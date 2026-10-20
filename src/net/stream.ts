/** An ordered, reliable byte stream (relay circuit, TLS channel, test pipe). */
export interface ByteStream {
  write(bytes: Uint8Array): void
  /** Closes the stream. Passing an error marks it as a failure. Idempotent. */
  close(error?: Error): void
  /** Sets the receiver. Data and close events that arrived earlier are delivered at once. */
  listen(handlers: StreamHandlers): void
  readonly closed: boolean
}

export interface StreamHandlers {
  data(bytes: Uint8Array): void
  close(error?: Error): void
}

/**
 * A stream end backed by a send function. The owner pushes inbound bytes with `deliver` and
 * reports the far end closing with `end`. Inbound events are buffered until `listen`.
 */
export class StreamEndpoint implements ByteStream {
  private handlers?: StreamHandlers
  private pending: Uint8Array[] = []
  private ended?: { error?: Error }
  closed = false

  constructor(
    private readonly send: (bytes: Uint8Array) => void,
    private readonly onLocalClose: (error?: Error) => void = () => {},
  ) {}

  write(bytes: Uint8Array): void {
    if (this.closed) throw new Error('Stream is closed.')
    if (bytes.length) this.send(bytes)
  }

  close(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.onLocalClose(error)
    this.end(error)
  }

  listen(handlers: StreamHandlers): void {
    this.handlers = handlers
    const pending = this.pending
    this.pending = []
    for (const bytes of pending) handlers.data(bytes)
    if (this.ended) handlers.close(this.ended.error)
  }

  deliver(bytes: Uint8Array): void {
    if (this.ended) return
    if (this.handlers) this.handlers.data(bytes)
    else this.pending.push(bytes)
  }

  end(error?: Error): void {
    if (this.ended) return
    this.ended = { error }
    this.closed = true
    this.handlers?.close(error)
  }
}

/** Two connected in-memory endpoints, for tests. Delivery is asynchronous (microtask). */
export function streamPair(): [StreamEndpoint, StreamEndpoint] {
  let a!: StreamEndpoint
  let b!: StreamEndpoint
  a = new StreamEndpoint(
    (bytes) => queueMicrotask(() => b.deliver(bytes.slice())),
    (error) => queueMicrotask(() => b.end(error)),
  )
  b = new StreamEndpoint(
    (bytes) => queueMicrotask(() => a.deliver(bytes.slice())),
    (error) => queueMicrotask(() => a.end(error)),
  )
  return [a, b]
}
