// Turns a computer's signed thread display stream (`node.thread`) into the phone's chat items.
// The desktop writes a snapshot as thread.snapshot.begin, chunk… and end records, followed by
// thread.event records (see the desktop's ThreadStreamAdapter). Records arrive already
// signature-checked by LeafSession.
import { equalBytes, fromB64url, fromUtf8 } from '../net/bytes'
import { sha256 } from '../net/crypto'
import type { StreamRecord } from '../net/session'
import type { ChatItem } from './types'

const CHUNK_BYTES = 32 * 1024
const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024

/** The desktop's ChatMessage, as far as the phone reads it. */
export interface DesktopMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  hidden?: boolean
  streaming?: boolean
  incomplete?: boolean
  error?: unknown
  toolCall?: { title?: string; summary?: string; toolName?: string; status?: string; details?: unknown }
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

function toolText(tool: NonNullable<DesktopMessage['toolCall']>): string {
  return [tool.title, tool.summary].filter((part): part is string => typeof part === 'string' && !!part.trim()).join('\n')
}

/** Maps one desktop message to a chat item; hidden or empty messages map to nothing. */
export function chatItem(message: DesktopMessage): ChatItem | undefined {
  if (message.hidden) return undefined
  const tool = isObject(message.toolCall) ? message.toolCall : undefined
  const error = typeof message.error === 'string' ? message.error : message.error ? 'The computer reported an error.' : undefined
  const text = message.content.trim() ? message.content : tool ? toolText(tool) : (error ?? '')
  if (!text.trim()) return undefined
  const createdAt = Date.parse(message.timestamp)
  const running = message.streaming === true || (tool && (tool.status === 'running' || tool.status === 'pending'))
  return {
    id: message.id,
    role: tool ? 'tool' : message.role,
    text,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    status: error || tool?.status === 'error' || tool?.status === 'failed' ? 'error' : running ? 'streaming' : 'done',
    ...(tool ? { toolName: tool.toolName || tool.title || 'tool' } : {}),
  }
}

export class ThreadProjection {
  private messages: DesktopMessage[] = []
  private pending?: PendingSnapshot
  private localItems: ChatItem[] = []
  /** Whether the computer reports a running turn, as far as the stream has told us. */
  active = false

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
    const items = this.messages.map(chatItem).filter((item): item is ChatItem => !!item)
    if (!this.localItems.length) return items
    return [...items, ...this.localItems].sort((a, b) => a.createdAt - b.createdAt)
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
        return false
      case 'turn.completed':
      case 'turn.interrupted':
      case 'turn.aborted':
        this.active = false
        return false
      case 'turn.state':
        this.active = typeof data.phase === 'string' && !['idle', 'failed', 'completed', 'interrupted'].includes(data.phase)
        return false
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
