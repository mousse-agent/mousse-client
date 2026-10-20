// The phone's Mousse ID sign-in (contract §1): password or Google in the system browser, a stored
// refresh token, and access tokens refreshed shortly before they expire or after a 401.
import { b64url, randomBytes, utf8 } from '../net/bytes'
import { sha256 } from '../net/crypto'
import { readJson, writeJson, type KeyStorage } from '../net/keys'
import { MousseIdError, badResponse, isObject, type MousseIdHttp } from './http'

export interface AppSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  account: { id: string; email: string | null }
}

const STORAGE_KEY = 'mousseId.session'
const REFRESH_MARGIN_MS = 60_000
const EMAIL_MAX = 320
const CODE_MAX = 2048

/** The deep link the browser returns to after a browser sign-in. */
export const OAUTH_REDIRECT_URI = 'com.ryspa.mousse:/oauth/callback'

/**
 * Opens a URL in the system browser and resolves with the OAuth callback URL it returns to.
 * On the phone this is `openAuthBrowser` from src/authBrowser.ts.
 */
export type AuthBrowser = (url: string) => Promise<URL>

function checkedSession(value: unknown): AppSession {
  if (
    !isObject(value) ||
    typeof value.accessToken !== 'string' ||
    !value.accessToken ||
    typeof value.refreshToken !== 'string' ||
    !value.refreshToken ||
    !Number.isSafeInteger(value.expiresAt) ||
    !isObject(value.account) ||
    typeof value.account.id !== 'string' ||
    !value.account.id ||
    !(value.account.email === null || typeof value.account.email === 'string')
  )
    return badResponse()
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt as number,
    account: { id: value.account.id, email: value.account.email as string | null },
  }
}

function checkedEmail(email: string): string {
  const trimmed = email.trim()
  if (!trimmed || trimmed.length > EMAIL_MAX || !trimmed.includes('@'))
    throw new MousseIdError('bad_request', 'Enter a valid email address.')
  return trimmed
}

export class MousseIdSession {
  private session?: AppSession
  private loaded?: Promise<void>
  private refreshing?: Promise<AppSession>
  private readonly listeners = new Set<(session: AppSession | undefined) => void>()

  constructor(
    readonly http: MousseIdHttp,
    private readonly storage: KeyStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /** Restores a stored session. Safe to call more than once. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const stored = await readJson<unknown>(this.storage, STORAGE_KEY)
        this.session = stored === undefined ? undefined : checkedSession(stored)
      } catch {
        this.session = undefined
        await this.storage.removeItem(STORAGE_KEY)
      }
      this.emit()
    })()
    return this.loaded
  }

  current(): AppSession | undefined {
    return this.session
  }

  onChange(listener: (session: AppSession | undefined) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async signInWithPassword(email: string, password: string): Promise<AppSession> {
    if (!password) throw new MousseIdError('bad_request', 'Enter your password.')
    const value = await this.http.request<unknown>('POST', '/v1/app/session/password', { body: { email: checkedEmail(email), password } })
    return this.adopt(checkedSession(value))
  }

  /**
   * Signs in with Google in the system browser. Mousse ID runs the Google sign-in, then sends the
   * browser back to the app's callback with a one-time code that only this verifier can redeem.
   */
  async signInWithGoogle(openBrowser: AuthBrowser): Promise<AppSession> {
    const verifier = b64url(randomBytes(32))
    const start = new URL('/v1/app/oauth/google/start', this.http.origin)
    start.searchParams.set('code_challenge', b64url(sha256(utf8(verifier))))
    start.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI)
    const received = await openBrowser(start.toString())
    if (received.searchParams.has('error'))
      throw new MousseIdError('unauthorized', 'Google sign-in did not finish. Try again.')
    const code = received.searchParams.get('code')
    if (!code || code.length > CODE_MAX) throw new MousseIdError('bad_response', 'Google sign-in returned no code. Try again.')
    const value = await this.http.request<unknown>('POST', '/v1/app/session/oauth', { body: { code, code_verifier: verifier } })
    return this.adopt(checkedSession(value))
  }

  /** Ends the session locally even when the server cannot be reached. */
  async signOut(): Promise<void> {
    const session = this.session
    await this.clear()
    if (!session) return
    try {
      await this.http.request('POST', '/v1/app/session/logout', { bearer: session.accessToken })
    } catch {
      // The refresh token is gone locally; the server session expires on its own.
    }
  }

  /** A current access token, refreshed when it expires within a minute. */
  async accessToken(): Promise<string> {
    await this.load()
    const session = this.session
    if (!session) throw new MousseIdError('unauthorized', 'Sign in to Mousse ID first.')
    if (session.expiresAt - REFRESH_MARGIN_MS > this.now()) return session.accessToken
    return (await this.refresh()).accessToken
  }

  /** Runs `call` with an access token, refreshing once and retrying after a 401. */
  async authorized<T>(call: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken()
    try {
      return await call(token)
    } catch (error) {
      if (!(error instanceof MousseIdError) || error.code !== 'unauthorized') throw error
      if (this.session?.accessToken !== token) return call(await this.accessToken())
      return call((await this.refresh()).accessToken)
    }
  }

  refresh(): Promise<AppSession> {
    this.refreshing ??= (async () => {
      const session = this.session
      if (!session) throw new MousseIdError('unauthorized', 'Sign in to Mousse ID first.')
      try {
        const value = await this.http.request<unknown>('POST', '/v1/app/session/refresh', {
          body: { refreshToken: session.refreshToken },
        })
        return await this.adopt(checkedSession(value))
      } catch (error) {
        if (error instanceof MousseIdError && error.code === 'unauthorized') await this.clear()
        throw error
      }
    })().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async adopt(session: AppSession): Promise<AppSession> {
    this.session = session
    await writeJson(this.storage, STORAGE_KEY, session)
    this.emit()
    return session
  }

  private async clear(): Promise<void> {
    this.session = undefined
    await this.storage.removeItem(STORAGE_KEY)
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.session)
  }
}
