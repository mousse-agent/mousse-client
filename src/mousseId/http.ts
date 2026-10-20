// JSON over HTTPS to the Mousse ID API, with its two error styles folded into one lowercase code.
// Net routes answer `{error: {code: 'not_found'}}`; app-session routes answer `UNAUTHORIZED`,
// `RATE_LIMITED` or `INVALID_STATE`.

const RESPONSE_MAX_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

export type MousseIdErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'revoked'
  | 'not_found'
  | 'conflict'
  | 'expired'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'unavailable'
  | 'offline'
  | 'not_configured'
  | 'bad_response'

export class MousseIdError extends Error {
  constructor(
    readonly code: MousseIdErrorCode,
    message: string = defaultMessage(code),
    readonly status?: number,
  ) {
    super(message)
    this.name = 'MousseIdError'
  }
  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'unavailable' || this.code === 'offline'
  }
}

function defaultMessage(code: MousseIdErrorCode): string {
  switch (code) {
    case 'unauthorized':
      return 'Sign in to Mousse ID again.'
    case 'rate_limited':
      return 'Too many attempts. Wait a minute and try again.'
    case 'quota_exceeded':
      return 'Your Mousse ID account has reached its device limit.'
    case 'offline':
      return 'Mousse ID cannot be reached. Check your connection.'
    case 'unavailable':
      return 'Mousse ID is unavailable right now. Try again shortly.'
    case 'not_configured':
      return 'This build has no Mousse ID server configured.'
    case 'expired':
      return 'This request has expired.'
    case 'not_found':
      return 'Mousse ID does not know this item.'
    case 'revoked':
      return 'This device was removed from Mousse ID.'
    default:
      return `Mousse ID refused the request (${code}).`
  }
}

const SERVER_CODES: Record<string, MousseIdErrorCode> = {
  UNAUTHORIZED: 'unauthorized',
  RATE_LIMITED: 'rate_limited',
  INVALID_STATE: 'bad_request',
  FORBIDDEN: 'forbidden',
  bad_request: 'bad_request',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  revoked: 'revoked',
  not_found: 'not_found',
  conflict: 'conflict',
  expired: 'expired',
  quota_exceeded: 'quota_exceeded',
  rate_limited: 'rate_limited',
}

function codeForStatus(status: number): MousseIdErrorCode {
  if (status === 400) return 'bad_request'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 410) return 'expired'
  if (status === 429) return 'rate_limited'
  return 'unavailable'
}

/** Accepts `https://host[:port]`, or `http://` on loopback for development. Returns the bare origin. */
export function checkedOrigin(value: string | undefined): string {
  if (!value) throw new MousseIdError('not_configured')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MousseIdError('not_configured', 'The Mousse ID address is not a valid URL.')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new MousseIdError('not_configured', 'The Mousse ID address must be an https origin.')
  return url.origin
}

export interface RequestOptions {
  bearer?: string
  body?: unknown
  signal?: AbortSignal
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export class MousseIdHttp {
  readonly origin: string
  constructor(
    origin: string,
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.origin = checkedOrigin(origin)
  }

  async request<T>(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<T> {
    if (options.bearer !== undefined && (!options.bearer || /[\r\n]/.test(options.bearer) || options.bearer.length > 16_384))
      throw new MousseIdError('unauthorized')
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetcher(this.origin + path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      })
    } catch (cause) {
      if (options.signal?.aborted) throw cause
      throw new MousseIdError('offline')
    }
    const text = await response.text()
    if (text.length > RESPONSE_MAX_BYTES) throw new MousseIdError('bad_response', 'Mousse ID sent an oversized response.')
    if (!response.ok) {
      let code = codeForStatus(response.status)
      try {
        const serverCode = (JSON.parse(text) as { error?: { code?: unknown } })?.error?.code
        if (typeof serverCode === 'string' && SERVER_CODES[serverCode]) code = SERVER_CODES[serverCode]
      } catch {
        // Keep the status-derived code.
      }
      throw new MousseIdError(code, undefined, response.status)
    }
    if (response.status === 204 || !text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new MousseIdError('bad_response', 'Mousse ID sent an invalid response.')
    }
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function badResponse(): never {
  throw new MousseIdError('bad_response', 'Mousse ID sent an unexpected response.')
}
