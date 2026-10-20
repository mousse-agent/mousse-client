// Browser port of the desktop `link/mux.ts` StreamMux. Same frame layout, credits and checks:
// 16-byte header [version=1, lane, flags, 0, id u32, length u32, grant u32] then the payload.
import { decodeMessage, encodeMessage, laneFor, MAX_MESSAGE_BYTES, type Lane, type MuxMessage } from './codec'
import { NetError } from './errors'
import type { ByteStream } from './stream'

export const MUX_WINDOWS = { control: 256 * 1024, bulk: 1024 * 1024 } as const
export const MAX_FRAME_BYTES = 64 * 1024
export const FRAGMENT_STALL_MS = 30_000
const HEADER = 16
const FIRST = 1
const LAST = 2
const CREDIT = 4
const LANES: Lane[] = ['control', 'bulk']

type Send = {
  bytes: Uint8Array
  offset: number
  id?: number
  resolve(): void
  reject(error: Error): void
  signal?: AbortSignal
  abort?: () => void
}
type Receive = { id: number; chunks: Uint8Array[]; size: number }
type LaneState = {
  credit: number
  receiveCredit: number
  grants: number
  active?: Send
  waiting: Send[]
  waitingBytes: number
  receive?: Receive
}

export interface MuxOptions {
  /** Called with data bytes before decoding; the session enforces its preauth budget here and may throw. */
  onBytesReceived?: (count: number) => void
  stallMs?: number
}

export class StreamMux {
  private readonly lanes: Record<Lane, LaneState>
  private readonly messages = new Set<(lane: Lane, message: MuxMessage) => void>()
  private readonly closedListeners = new Set<(error?: Error) => void>()
  private closed = false
  private closeError?: Error
  private scheduled = false
  private nextId = 1
  private lastReceivedId = 0
  private readonly frameHeader = new Uint8Array(HEADER)
  private headerOffset = 0
  private payload?: Uint8Array
  private payloadOffset = 0
  private frame?: { lane: Lane; flags: number; id: number; length: number }
  private stallTimer?: ReturnType<typeof setTimeout>
  private readonly stallMs: number
  private readonly onBytesReceived?: (count: number) => void

  constructor(
    private readonly stream: ByteStream,
    options: MuxOptions = {},
  ) {
    this.stallMs = options.stallMs ?? FRAGMENT_STALL_MS
    this.onBytesReceived = options.onBytesReceived
    const state = (lane: Lane): LaneState => ({
      credit: MUX_WINDOWS[lane],
      receiveCredit: MUX_WINDOWS[lane],
      grants: 0,
      waiting: [],
      waitingBytes: 0,
    })
    this.lanes = { control: state('control'), bulk: state('bulk') }
    stream.listen({
      data: (bytes) => this.data(bytes),
      close: (error) =>
        this.close(
          error
            ? error instanceof NetError
              ? error
              : new NetError('route_unreachable', error.message, { cause: error })
            : new NetError('route_unreachable', 'Mux peer closed.'),
        ),
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  send(message: MuxMessage, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(this.closeError ?? new NetError('route_unreachable', 'Mux is closed.'))
    if (signal?.aborted) return Promise.reject(new NetError('cancelled', undefined, { cause: signal.reason }))
    const lane = laneFor(message.header)
    let bytes: Uint8Array
    try {
      bytes = encodeMessage(message.header, message.parts)
    } catch (error) {
      return Promise.reject(error)
    }
    const state = this.lanes[lane]
    if (state.active && state.waitingBytes + bytes.length > MUX_WINDOWS[lane])
      return Promise.reject(new NetError('rate_limited', 'Mux waiting queue is full.'))
    return new Promise<void>((resolve, reject) => {
      const send: Send = { bytes, offset: 0, resolve, reject, signal }
      const abort = () => {
        if (state.active === send && send.offset > 0) {
          state.active = undefined
          const cancelled = new NetError('cancelled', 'A fragmented send was cancelled.', { cause: signal?.reason })
          this.finish(send, cancelled)
          this.close(new NetError('route_unreachable', 'Cancelled partial message requires reconnect.', { cause: cancelled }))
          return
        }
        if (state.active === send) {
          state.active = undefined
          this.promote(state)
        } else {
          const index = state.waiting.indexOf(send)
          if (index < 0) return
          state.waiting.splice(index, 1)
          state.waitingBytes -= send.bytes.length
        }
        this.finish(send, new NetError('cancelled', undefined, { cause: signal?.reason }))
        this.schedule()
      }
      send.abort = abort
      signal?.addEventListener('abort', abort, { once: true })
      if (!state.active) state.active = send
      else {
        state.waiting.push(send)
        state.waitingBytes += bytes.length
      }
      this.schedule()
    })
  }

  onMessage(listener: (lane: Lane, message: MuxMessage) => void): () => void {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closedListeners.add(listener)
    if (this.closed)
      queueMicrotask(() => {
        if (this.closedListeners.has(listener)) listener(this.closeError)
      })
    return () => this.closedListeners.delete(listener)
  }

  close(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    clearTimeout(this.stallTimer)
    for (const state of Object.values(this.lanes)) {
      state.receive = undefined
      const failure = error ?? new NetError('route_unreachable')
      if (state.active) this.finish(state.active, failure)
      for (const send of state.waiting) this.finish(send, failure)
      state.active = undefined
      state.waiting = []
      state.waitingBytes = 0
      state.grants = 0
    }
    this.stream.close(error)
    this.payload = undefined
    this.frame = undefined
    for (const listener of this.closedListeners) listener(error)
    this.messages.clear()
  }

  private finish(send: Send, error?: Error): void {
    if (send.abort) send.signal?.removeEventListener('abort', send.abort)
    if (error) send.reject(error)
    else send.resolve()
  }

  private promote(state: LaneState): void {
    state.active = state.waiting.shift()
    if (state.active) state.waitingBytes -= state.active.bytes.length
  }

  private schedule(): void {
    if (this.closed || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.pump()
    })
  }

  private frameBytes(lane: Lane, flags: number, id: number, payload?: Uint8Array, grant = 0): Uint8Array {
    const bytes = new Uint8Array(HEADER + (payload?.length ?? 0))
    const view = new DataView(bytes.buffer)
    bytes[0] = 1
    bytes[1] = lane === 'control' ? 0 : 1
    bytes[2] = flags
    view.setUint32(4, id, false)
    view.setUint32(8, payload?.length ?? 0, false)
    view.setUint32(12, grant, false)
    if (payload) bytes.set(payload, HEADER)
    return bytes
  }

  /** Writes frames until nothing is sendable; credit grants go first. */
  private pump(): void {
    while (!this.closed) {
      if (!this.pumpOne()) return
    }
  }

  private pumpOne(): boolean {
    for (const lane of LANES) {
      const state = this.lanes[lane]
      if (state.grants) {
        const grant = state.grants
        state.grants = 0
        state.receiveCredit += grant
        if (state.receiveCredit > MUX_WINDOWS[lane]) {
          this.close(new NetError('bad_request', 'Receive credit overflow.'))
          return false
        }
        return this.write(this.frameBytes(lane, CREDIT, 0, undefined, grant))
      }
    }
    for (const lane of LANES) {
      const state = this.lanes[lane]
      const send = state.active
      if (!send || !state.credit) continue
      if (send.id === undefined) {
        if (this.nextId > 0xffffffff) {
          this.close(new NetError('conflict', 'Mux message identifiers exhausted.'))
          return false
        }
        send.id = this.nextId++
      }
      const size = Math.min(MAX_FRAME_BYTES - HEADER, state.credit, send.bytes.length - send.offset)
      const first = send.offset === 0
      const last = send.offset + size === send.bytes.length
      const payload = send.bytes.subarray(send.offset, send.offset + size)
      send.offset += size
      state.credit -= size
      if (!this.write(this.frameBytes(lane, (first ? FIRST : 0) | (last ? LAST : 0), send.id, payload))) return false
      if (last && state.active === send) {
        state.active = undefined
        this.finish(send)
        this.promote(state)
      }
      return true
    }
    return false
  }

  private write(frame: Uint8Array): boolean {
    try {
      this.stream.write(frame)
      return true
    } catch (error) {
      this.close(error instanceof NetError ? error : new NetError('route_unreachable', undefined, { cause: error }))
      return false
    }
  }

  private progress(): void {
    clearTimeout(this.stallTimer)
    this.stallTimer = setTimeout(
      () => this.close(new NetError('deadline_exceeded', 'Fragment receive stalled.')),
      this.stallMs,
    )
  }

  private idle(): void {
    clearTimeout(this.stallTimer)
    this.stallTimer = undefined
    // A partially received message still needs to finish within the stall window.
    if (this.lanes.control.receive || this.lanes.bulk.receive) this.progress()
  }

  private data(input: Uint8Array): void {
    if (this.closed) return
    try {
      let offset = 0
      while (offset < input.length && !this.closed) {
        if (!this.frame) {
          const count = Math.min(HEADER - this.headerOffset, input.length - offset)
          this.frameHeader.set(input.subarray(offset, offset + count), this.headerOffset)
          this.headerOffset += count
          offset += count
          this.progress()
          if (this.headerOffset < HEADER) continue
          const h = this.frameHeader
          const view = new DataView(h.buffer)
          const lane = LANES[h[1]]
          const flags = h[2]
          const id = view.getUint32(4, false)
          const length = view.getUint32(8, false)
          const grant = view.getUint32(12, false)
          if (h[0] !== 1 || !lane || h[3] !== 0 || flags & ~7 || length > MAX_FRAME_BYTES - HEADER)
            throw new NetError('bad_request', 'Invalid mux frame header.')
          this.headerOffset = 0
          const state = this.lanes[lane]
          if (flags === CREDIT) {
            if (id !== 0 || length !== 0 || !grant || state.credit + grant > MUX_WINDOWS[lane])
              throw new NetError('bad_request', 'Invalid credit grant.')
            state.credit += grant
            this.idle()
            this.schedule()
            continue
          }
          if (flags & CREDIT || grant || !id || !length) throw new NetError('bad_request', 'Invalid data frame.')
          if (length > state.receiveCredit) throw new NetError('bad_request', 'Peer exceeded lane credit.')
          if (flags & FIRST) {
            if (state.receive || id <= this.lastReceivedId)
              throw new NetError('bad_request', 'Invalid first fragment or reused message ID.')
            this.lastReceivedId = id
            state.receive = { id, size: 0, chunks: [] }
          }
          const receive = state.receive
          if (!receive || receive.id !== id) throw new NetError('bad_request', 'Unexpected continuation fragment.')
          if (receive.size + length > MAX_MESSAGE_BYTES) throw new NetError('too_large', 'Reassembled message exceeds limit.')
          state.receiveCredit -= length
          this.frame = { lane, flags, id, length }
          this.payload = new Uint8Array(length)
          this.payloadOffset = 0
        }
        if (this.frame && this.payload) {
          const count = Math.min(this.frame.length - this.payloadOffset, input.length - offset)
          this.payload.set(input.subarray(offset, offset + count), this.payloadOffset)
          this.payloadOffset += count
          offset += count
          if (count) {
            this.onBytesReceived?.(count)
            this.progress()
          }
          if (this.payloadOffset !== this.frame.length) continue
          const frame = this.frame
          const state = this.lanes[frame.lane]
          const receive = state.receive!
          receive.chunks.push(this.payload)
          receive.size += this.payload.length
          state.grants += this.payload.length
          this.frame = undefined
          this.payload = undefined
          if (frame.flags & LAST) {
            state.receive = undefined
            const bytes = new Uint8Array(receive.size)
            let at = 0
            for (const chunk of receive.chunks) {
              bytes.set(chunk, at)
              at += chunk.length
            }
            let message: MuxMessage | undefined
            try {
              message = decodeMessage(bytes, frame.lane)
            } catch (error) {
              // Unknown complete message types are skipped for forward compatibility.
              if (!(error instanceof NetError && error.code === 'unsupported_version')) throw error
            }
            if (message) for (const listener of this.messages) listener(frame.lane, message)
          }
          this.idle()
          this.schedule()
        }
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new NetError('bad_request', undefined, { cause: error }))
    }
  }
}
