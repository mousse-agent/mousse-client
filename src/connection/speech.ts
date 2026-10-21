// Speech on the phone with the computer's models: dictation (speech-to-text) and read aloud
// (text-to-speech). The phone records and plays; the paired computer runs the model it is set up
// to use, through its `speech.*` RPCs. See mousse/src/shared/speechRelay.ts for the contract.
import { newId } from '../net/canonical'
import { NetError } from '../net/errors'
import type { RpcOptions } from '../net/session'

export type SpeechKind = 'dictation' | 'readAloud'

/** A local model's download state on the computer. */
export type LocalModelState =
  | { status: 'not-downloaded' }
  | { status: 'downloading'; receivedBytes: number; totalBytes: number }
  | { status: 'downloaded' }
  | { status: 'error'; message: string }

export interface SpeechProviderModel {
  providerId: string
  providerLabel: string
  modelId: string
  label: string
}

export interface SpeechLocalModel {
  id: string
  label: string
  description: string
  parameters: string
  license: string
  homepage: string
  bytes: number
  state: LocalModelState
}

export interface SpeechSelection {
  source: 'provider' | 'local'
  providerId?: string
  modelId: string
  label: string
}

export type SpeechChoice =
  | { source: 'provider'; providerId: string; modelId: string }
  | { source: 'local'; modelId: string }

/** What the computer's chooser offers, and the model it uses now (null before the first choice). */
export interface SpeechOptions {
  kind: SpeechKind
  selection: SpeechSelection | null
  voice?: string
  providers: SpeechProviderModel[]
  local: SpeechLocalModel[]
}

/** One clip of speech, ready to play: clips play in order. */
export interface SpeechClip {
  index: number
  bytes: Uint8Array
  mimeType: string
  /** Playback rate to apply with pitch kept. */
  rate: number
}

export type SpeechErrorCode = 'no_host' | 'no_model' | 'unavailable' | 'invalid' | 'busy' | 'failed' | 'unsupported'

/** A refusal from the computer, with a message meant for the user. */
export class SpeechError extends Error {
  constructor(readonly code: SpeechErrorCode, message: string) {
    super(message)
    this.name = 'SpeechError'
  }
}

/** A recording that is sent to the computer while it is made, then transcribed there. */
export interface SpeechRecordingUpload {
  /** Queues recorded bytes; they go out in pieces in the background. */
  add(bytes: Uint8Array): void
  /** Bytes queued so far. */
  readonly bytes: number
  /**
   * Sends what is left, then transcribes on the computer. `onPartial` receives the text so far
   * when the computer's model works in pieces. Can be called again after a `no_model` refusal.
   */
  transcribe(mimeType: string, options?: { onPartial?: (text: string) => void; signal?: AbortSignal }): Promise<string>
}

export interface ComputerSpeech {
  options(kind: SpeechKind): Promise<SpeechOptions>
  choose(kind: SpeechKind, choice: SpeechChoice): Promise<SpeechSelection>
  /** Downloads a local model on the computer; `onState` follows its progress. Abort cancels it. */
  download(kind: SpeechKind, modelId: string, options?: { onState?: (state: LocalModelState) => void; signal?: AbortSignal }): Promise<LocalModelState>
  startRecording(): SpeechRecordingUpload
  /** Reads `markdown` aloud with the computer's voice; clips arrive as they are made. */
  speak(markdown: string, options: { onClip: (clip: SpeechClip) => void; signal?: AbortSignal }): Promise<void>
}

type Rpc = (method: string, params: unknown, options?: RpcOptions) => Promise<unknown>

/** Raw bytes per uploaded piece: 48 KiB of base64, the most one request carries. */
export const UPLOAD_PIECE_BYTES = 36 * 1024
/** The computer's limit for one recording. */
export const MAX_RECORDING_BYTES = 2_200_000
/** Longest text read aloud in one request, in UTF-8 bytes. */
export const MAX_SPEAK_BYTES = 40 * 1024

const DOWNLOAD_DEADLINE_MS = 60 * 60 * 1000
const TRANSCRIBE_DEADLINE_MS = 10 * 60 * 1000
const SPEAK_DEADLINE_MS = 30 * 60 * 1000

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const CODES = new Set<SpeechErrorCode>(['no_host', 'no_model', 'unavailable', 'invalid', 'busy', 'failed'])

/** Turns `{ ok: false }` answers into SpeechErrors and returns the rest. */
function answer(value: unknown, method: string): Record<string, unknown> {
  if (!isObject(value)) throw new SpeechError('failed', `The computer sent an unexpected answer to ${method}.`)
  if (value.ok === false) {
    const code = CODES.has(value.code as SpeechErrorCode) ? (value.code as SpeechErrorCode) : 'failed'
    throw new SpeechError(code, typeof value.error === 'string' && value.error ? value.error : 'The computer could not do that.')
  }
  return value
}

/** An older Mousse on the computer does not know these methods. */
function unsupported(error: unknown): never {
  if (error instanceof NetError && error.code === 'forbidden')
    throw new SpeechError('unsupported', 'Update Mousse on this computer to use voice from your phone.')
  throw error
}

function state(value: unknown): LocalModelState {
  if (!isObject(value)) return { status: 'not-downloaded' }
  if (value.status === 'downloaded') return { status: 'downloaded' }
  if (value.status === 'downloading')
    return { status: 'downloading', receivedBytes: Number(value.receivedBytes) || 0, totalBytes: Number(value.totalBytes) || 0 }
  if (value.status === 'error') return { status: 'error', message: typeof value.message === 'string' ? value.message : 'The download failed.' }
  return { status: 'not-downloaded' }
}

function selection(value: unknown): SpeechSelection | null {
  if (!isObject(value) || typeof value.modelId !== 'string' || (value.source !== 'provider' && value.source !== 'local')) return null
  return {
    source: value.source,
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    modelId: value.modelId,
    label: typeof value.label === 'string' && value.label ? value.label : value.modelId,
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Cuts text to at most `maxBytes` of UTF-8, at the last paragraph or sentence break when it must cut. */
export function fitSpeakText(markdown: string, maxBytes = MAX_SPEAK_BYTES): string {
  const encoder = new TextEncoder()
  if (encoder.encode(markdown).length <= maxBytes) return markdown
  let cut = markdown.slice(0, maxBytes)
  while (encoder.encode(cut).length > maxBytes) cut = cut.slice(0, -64)
  const breakAt = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '))
  return breakAt > cut.length / 2 ? cut.slice(0, breakAt + 1) : cut
}

class RecordingUpload implements SpeechRecordingUpload {
  private readonly id = newId('rpc')
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private sent = 0
  private total = 0
  private queue: Promise<void> = Promise.resolve()
  private failure?: unknown

  constructor(private readonly rpc: Rpc) {}

  get bytes(): number {
    return this.total
  }

  add(bytes: Uint8Array): void {
    if (!bytes.length) return
    this.total += bytes.length
    this.pending.push(bytes)
    this.pendingBytes += bytes.length
    while (this.pendingBytes >= UPLOAD_PIECE_BYTES) this.sendPiece(UPLOAD_PIECE_BYTES)
  }

  async transcribe(mimeType: string, options: { onPartial?: (text: string) => void; signal?: AbortSignal } = {}): Promise<string> {
    if (this.pendingBytes > 0) this.sendPiece(this.pendingBytes)
    await this.queue
    if (this.failure) throw this.failure
    if (this.sent === 0) throw new SpeechError('invalid', 'Nothing was recorded.')
    const value = await this.rpc(
      'speech.transcribe',
      { upload: this.id, parts: this.sent, mimeType },
      {
        idem: crypto.randomUUID(),
        deadlineMs: TRANSCRIBE_DEADLINE_MS,
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: (data) => {
          if (isObject(data) && data.type === 'partial') options.onPartial?.(text(data.text))
        },
      },
    ).catch(unsupported)
    return text(answer(value, 'speech.transcribe').text)
  }

  private sendPiece(size: number): void {
    const bytes = joinBytes(this.pending)
    const piece = bytes.subarray(0, size)
    const rest = bytes.subarray(size)
    this.pending = rest.length ? [rest] : []
    this.pendingBytes = rest.length
    const index = this.sent++
    const data = bytesToBase64(piece)
    this.queue = this.queue.then(async () => {
      if (this.failure) return
      try {
        answer(await this.rpc('speech.upload', { upload: this.id, index, data }, { idem: crypto.randomUUID() }).catch(unsupported), 'speech.upload')
      } catch (error) {
        this.failure = error
      }
    })
  }
}

export class LeafComputerSpeech implements ComputerSpeech {
  constructor(private readonly rpc: Rpc) {}

  async options(kind: SpeechKind): Promise<SpeechOptions> {
    const value = answer(await this.rpc('speech.options', { kind }).catch(unsupported), 'speech.options')
    return {
      kind,
      selection: selection(value.selection),
      ...(typeof value.voice === 'string' ? { voice: value.voice } : {}),
      providers: Array.isArray(value.providers)
        ? value.providers.flatMap((row): SpeechProviderModel[] =>
            isObject(row) && typeof row.providerId === 'string' && typeof row.modelId === 'string'
              ? [{ providerId: row.providerId, providerLabel: text(row.providerLabel) || row.providerId, modelId: row.modelId, label: text(row.label) || row.modelId }]
              : [])
        : [],
      local: Array.isArray(value.local)
        ? value.local.flatMap((row): SpeechLocalModel[] =>
            isObject(row) && typeof row.id === 'string'
              ? [{
                  id: row.id,
                  label: text(row.label) || row.id,
                  description: text(row.description),
                  parameters: text(row.parameters),
                  license: text(row.license),
                  homepage: text(row.homepage),
                  bytes: Number(row.bytes) || 0,
                  state: state(row.state),
                }]
              : [])
        : [],
    }
  }

  async choose(kind: SpeechKind, choice: SpeechChoice): Promise<SpeechSelection> {
    const value = answer(await this.rpc('speech.choose', { kind, selection: choice }, { idem: crypto.randomUUID() }).catch(unsupported), 'speech.choose')
    const chosen = selection(value.selection)
    if (!chosen) throw new SpeechError('failed', 'The computer did not confirm the model.')
    return chosen
  }

  async download(kind: SpeechKind, modelId: string, options: { onState?: (state: LocalModelState) => void; signal?: AbortSignal } = {}): Promise<LocalModelState> {
    const value = answer(
      await this.rpc('speech.download', { kind, modelId }, {
        idem: crypto.randomUUID(),
        deadlineMs: DOWNLOAD_DEADLINE_MS,
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress: (data) => {
          if (isObject(data) && data.type === 'status') options.onState?.(state(data.state))
        },
      }).catch(unsupported),
      'speech.download',
    )
    return state(value.state)
  }

  startRecording(): SpeechRecordingUpload {
    return new RecordingUpload(this.rpc)
  }

  async speak(markdown: string, options: { onClip: (clip: SpeechClip) => void; signal?: AbortSignal }): Promise<void> {
    const parts = new Map<number, Uint8Array[]>()
    const value = await this.rpc('speech.speak', { text: fitSpeakText(markdown) }, {
      idem: crypto.randomUUID(),
      deadlineMs: SPEAK_DEADLINE_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (data) => {
        if (!isObject(data) || data.type !== 'audio' || typeof data.data !== 'string' || !Number.isSafeInteger(data.clip)) return
        const clip = data.clip as number
        const list = parts.get(clip) ?? []
        list.push(base64ToBytes(data.data))
        parts.set(clip, list)
        if (data.last !== true) return
        parts.delete(clip)
        const rate = typeof data.rate === 'number' && data.rate > 0 && data.rate <= 4 ? data.rate : 1
        options.onClip({ index: clip, bytes: joinBytes(list), mimeType: text(data.mimeType) || 'audio/wav', rate })
      },
    }).catch(unsupported)
    answer(value, 'speech.speak')
  }
}
