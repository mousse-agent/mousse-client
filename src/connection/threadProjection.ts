// Turns a computer's signed thread display stream (`node.thread`) into the phone's chat items.
// The desktop writes a snapshot as thread.snapshot.begin, chunk… and end records, followed by
// thread.event records (see the desktop's ThreadStreamAdapter). Records arrive already
// signature-checked by LeafSession.
import { equalBytes, fromB64url, fromUtf8 } from '../net/bytes'
import { sha256 } from '../net/crypto'
import type { StreamRecord } from '../net/session'
import type { ChatItem, PendingQuestions, ThreadDisplayState, TurnPhase } from './types'
import { foldItems, pendingQuestionsOf, toChatItem } from './timelineItems'

const KNOWN_PHASES = new Set<TurnPhase>(['idle', 'queued', 'thinking', 'streaming', 'tool_running', 'awaiting_input', 'finalizing', 'completed', 'stopped', 'failed'])
const ACTIVE_PHASES = new Set<TurnPhase>(['queued', 'thinking', 'streaming', 'tool_running', 'finalizing'])
const CHUNK_BYTES = 32 * 1024
const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024

/** The desktop's ChatMessage (shared/types.ts), as far as the phone reads it. Every field is untrusted. */
export interface DesktopMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  turnId?: unknown
  kind?: unknown
  hidden?: boolean
  streaming?: boolean
  incomplete?: boolean
  error?: unknown
  images?: unknown
  thinking?: unknown
  planCard?: unknown
  contextHandoff?: unknown
  responseMetadata?: unknown
  presentationParts?: unknown
  toolCall?: { title?: string; summary?: string; toolName?: string; status?: string; details?: unknown; response?: unknown; input?: unknown }
}

interface PendingSnapshot {
  id: string
  bytes: number
  chunks: number
  hash: Uint8Array
  parts: Uint8Array[]
  received: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isMessage(value: unknown): value is DesktopMessage {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    !!value.id &&
    (value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
    typeof value.content === 'string'
  )
}

function messagesOf(value: unknown): DesktopMessage[] | undefined {
  return Array.isArray(value) ? value.filter(isMessage) : undefined
}

/** Maps one desktop message to a chat item; hidden or empty messages map to nothing. */
export function chatItem(message: DesktopMessage): ChatItem | undefined {
  return toChatItem(message)
}

export class ThreadProjection {
  private messages: DesktopMessage[] = []
  private pending?: PendingSnapshot
  private localItems: ChatItem[] = []
  /** Items by message object, so unchanged messages keep the same item between updates. */
  private mapped = new WeakMap<DesktopMessage, ChatItem | null>()
  /** Whether the computer reports a running turn, as far as the stream has told us. */
  active = false
  phase?: TurnPhase
  turnStartedAt?: number
  turnError?: string
  questions: PendingQuestions[] = []
  connectionFailed?: string

  constructor(readonly threadId: string) {}

  /** Applies verified records in stream order. Returns whether the visible items changed. */
  apply(records: StreamRecord[]): boolean {
    let changed = false
    for (const record of records) changed = this.accept(record.envelope.type, record.envelope.body) || changed
    return changed
  }

  /** Adds an item that exists only on this phone, such as a send that failed after it was dispatched. */
  addLocal(item: ChatItem): void {
    this.localItems.push(item)
  }

  items(): ChatItem[] {
    const items: ChatItem[] = []
    for (const message of this.messages) {
      let item = this.mapped.get(message)
      if (item === undefined) {
        item = toChatItem(message) ?? null
        this.mapped.set(message, item)
      }
      if (item) items.push(item)
    }
    const folded = foldItems(items)
    if (!this.localItems.length) return folded
    return [...folded, ...this.localItems].sort((a, b) => a.createdAt - b.createdAt)
  }

  state(): ThreadDisplayState {
    return {
      ...(this.phase ? { phase: this.phase } : {}),
      ...(this.turnStartedAt !== undefined ? { turnStartedAt: this.turnStartedAt } : {}),
      ...(this.turnError ? { turnError: this.turnError } : {}),
      questions: this.questions,
      ...(this.connectionFailed ? { connectionFailed: this.connectionFailed } : {}),
    }
  }

  /**
   * Applies a live delta the computer sent outside the signed stream: a reply still being written,
   * or the thread's pending questions. A streaming delta never replaces a finished message.
   * Returns whether anything visible changed.
   */
  applyDelta(value: unknown): boolean {
    if (!isObject(value) || value.threadId !== this.threadId || typeof value.type !== 'string' || !isObject(value.data)) return false
    const data = value.data
    if (data.threadId !== undefined && data.threadId !== this.threadId) return false
    switch (value.type) {
      case 'thread.message':
      case 'thread.message-updated': {
        if (!isMessage(data.message) || data.message.streaming !== true) return false
        const known = this.messages.find((entry) => entry.id === (data.message as DesktopMessage).id)
        if (known && known.streaming !== true) return false
        return this.upsert(data.message)
      }
      case 'questions.updated': {
        const questions = pendingQuestionsOf(data.pending, this.threadId)
        if (!questions) return false
        this.questions = questions
        return true
      }
      default:
        return false
    }
  }

  /** Replaces the pending questions, for example after reading them again from the computer. */
  setQuestions(questions: PendingQuestions[]): void {
    this.questions = questions
  }

  private accept(type: string, body: unknown): boolean {
    if (!isObject(body) || body.threadId !== this.threadId) return false
    switch (type) {
      case 'thread.snapshot.begin':
        this.begin(body)
        return false
      case 'thread.snapshot.chunk':
        this.chunk(body)
        return false
      case 'thread.snapshot.end':
        return this.end(body)
      case 'thread.event':
        return typeof body.type === 'string' ? this.event(body.type, body.data) : false
      default:
        return false
    }
  }

  private begin(body: Record<string, unknown>): void {
    this.pending = undefined
    const { snapshot, totalBytes, chunks, sha256: hash } = body
    if (
      typeof snapshot !== 'string' ||
      !Number.isSafeInteger(totalBytes) ||
      (totalBytes as number) < 1 ||
      (totalBytes as number) > SNAPSHOT_MAX_BYTES ||
      chunks !== Math.ceil((totalBytes as number) / CHUNK_BYTES) ||
      typeof hash !== 'string'
    )
      return
    try {
      this.pending = { id: snapshot, bytes: totalBytes as number, chunks: chunks as number, hash: fromB64url(hash, 32), parts: [], received: 0 }
    } catch {
      this.pending = undefined
    }
  }

  private chunk(body: Record<string, unknown>): void {
    const held = this.pending
    if (!held) return
    if (body.snapshot !== held.id || body.index !== held.parts.length || typeof body.data !== 'string') {
      this.pending = undefined
      return
    }
    let bytes: Uint8Array
    try {
      bytes = fromB64url(body.data)
    } catch {
      this.pending = undefined
      return
    }
    if (bytes.length !== Math.min(CHUNK_BYTES, held.bytes - held.received)) {
      this.pending = undefined
      return
    }
    held.parts.push(bytes)
    held.received += bytes.length
  }

  private end(body: Record<string, unknown>): boolean {
    const held = this.pending
    this.pending = undefined
    if (!held || body.snapshot !== held.id || held.received !== held.bytes || held.parts.length !== held.chunks) return false
    const bytes = new Uint8Array(held.bytes)
    let offset = 0
    for (const part of held.parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    if (!equalBytes(sha256(bytes), held.hash)) return false
    let value: unknown
    try {
      value = JSON.parse(fromUtf8(bytes))
    } catch {
      return false
    }
    if (!isObject(value)) return false
    const messages = messagesOf(value.messages)
    if (!messages) return false
    this.messages = messages
    this.localItems = []
    if (isObject(value.activeTurn)) this.active = value.activeTurn.active === true
    this.questions = pendingQuestionsOf(value.pendingQuestions, this.threadId) ?? []
    if (!this.active && this.phase && ACTIVE_PHASES.has(this.phase)) this.phase = undefined
    return true
  }

  private event(type: string, data: unknown): boolean {
    if (!isObject(data)) return false
    switch (type) {
      case 'thread.message':
      case 'thread.message-updated':
        return isMessage(data.message) ? this.upsert(data.message) : false
      case 'thread.messages': {
        const messages = messagesOf(data.messages)
        if (!messages) return false
        this.messages = data.replace === true ? messages : this.merge(messages)
        return true
      }
      case 'turn.started':
        this.active = true
        this.connectionFailed = undefined
        this.turnError = undefined
        return true
      case 'turn.completed':
        this.active = false
        this.phase = 'completed'
        return true
      case 'turn.interrupted':
      case 'turn.aborted':
        this.active = false
        this.phase = 'stopped'
        return true
      case 'turn.state': {
        if (typeof data.phase !== 'string') return false
        const phase = data.phase as TurnPhase
        this.phase = KNOWN_PHASES.has(phase) ? phase : undefined
        this.active = ACTIVE_PHASES.has(phase) || phase === 'awaiting_input'
        const started = typeof data.startedAt === 'string' ? Date.parse(data.startedAt) : NaN
        this.turnStartedAt = this.active && Number.isFinite(started) ? started : undefined
        this.turnError = phase === 'failed' && typeof data.error === 'string' ? data.error : undefined
        return true
      }
      case 'connection.failed': {
        const error = isObject(data.error) && typeof data.error.message === 'string' ? data.error.message : ''
        this.connectionFailed = error || 'The computer could not reach its model provider.'
        return true
      }
      default:
        return false
    }
  }

  private upsert(message: DesktopMessage): boolean {
    const index = this.messages.findIndex((entry) => entry.id === message.id)
    if (index < 0) this.messages = [...this.messages, message]
    else this.messages = this.messages.map((entry, i) => (i === index ? message : entry))
    return true
  }

  /** A full list without `replace` keeps messages that arrived after the list was taken. */
  private merge(messages: DesktopMessage[]): DesktopMessage[] {
    const ids = new Set(messages.map((message) => message.id))
    let lastKnown = -1
    this.messages.forEach((message, index) => {
      if (ids.has(message.id)) lastKnown = index
    })
    if (lastKnown < 0) return messages
    const tail = this.messages.slice(lastKnown + 1).filter((message) => !ids.has(message.id))
    return [...messages, ...tail]
  }
}
