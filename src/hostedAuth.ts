import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { ERROR_CODES, MOBILE_REDIRECT_URI } from './constants'
import { randomUrlSafe, s256 } from './security'
import { hostedSession } from './storage'
import type { HostedSession } from './types'

let inFlightRefresh: Promise<HostedSession> | null = null

export class AccountMismatchError extends Error {
  readonly code = ERROR_CODES.ACCOUNT_MISMATCH
  constructor(message = 'Scanned computer belongs to a different Mousse account.') {
    super(message)
    this.name = 'AccountMismatchError'
  }
}

/**
 * Initiates Supabase hosted PKCE login via the system browser and deep-link callback.
 */
export async function loginHosted(dashboardUrl: string, supabaseUrl?: string): Promise<HostedSession> {
  const base = dashboardUrl.replace(/\/$/, '')
  const authBase = (supabaseUrl || base).replace(/\/$/, '')

  const verifier = randomUrlSafe(48)
  const state = randomUrlSafe(32)
  const challenge = await s256(verifier)

  const authUrl = new URL(`${base}/login`)
  authUrl.searchParams.set('client_id', 'mousse-mobile')
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', MOBILE_REDIRECT_URI)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')

  let removeCallback: (() => Promise<void>) | undefined
  let listenerReady: Promise<void> | undefined

  const callback = new Promise<URL>((resolve, reject) => {
    let settled = false
    const finish = (value?: URL, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void removeCallback?.()
      value ? resolve(value) : reject(error)
    }

    const timer = window.setTimeout(
      () => finish(undefined, new Error('Hosted authorization timed out.')),
      180_000
    )

    listenerReady = Promise.all([
      CapacitorApp.addListener('appUrlOpen', ({ url }) => {
        try {
          const received = new URL(url)
          const isOAuthCallback =
            (received.protocol === 'com.ryspa.mousse:' || received.protocol === 'mousse:') &&
            (received.pathname === '/oauth/callback' ||
              received.pathname === '//oauth/callback' ||
              (received.host === 'oauth' && (received.pathname === '/callback' || received.pathname === '')) ||
              `${received.host}${received.pathname}`.replace(/^\/+/, '') === 'oauth/callback')
          if (isOAuthCallback) {
            finish(received)
          }
        } catch {
          finish(undefined, new Error('Authorization callback URL was invalid.'))
        }
      }),
      Browser.addListener('browserFinished', () => {
        finish(undefined, new Error('Authorization was cancelled when the browser closed.'))
      })
    ]).then(([appListener, browserListener]) => {
      removeCallback = async () => {
        await appListener.remove()
        await browserListener.remove()
      }
      if (settled) return removeCallback()
    })
  })

  let received: URL
  try {
    await listenerReady
    await Browser.open({ url: authUrl.toString(), presentationStyle: 'popover' })
    received = await callback
  } finally {
    await Browser.close().catch(() => undefined)
    await listenerReady
    await removeCallback?.()
  }

  const returnedState = received.searchParams.get('state')
  if (returnedState !== state) {
    throw new Error('Authorization state did not match. Possible CSRF attempt.')
  }

  const errorCode = received.searchParams.get('error')
  if (errorCode) {
    const errorDesc = received.searchParams.get('error_description') ?? errorCode
    throw new Error(`Hosted login failed: ${errorDesc}`)
  }

  const code = received.searchParams.get('code')
  if (!code) {
    throw new Error('Hosted authorization returned no code.')
  }

  // Token exchange
  const tokenUrl = `${authBase}/auth/v1/token?grant_type=pkce`
  const exchangeRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      auth_code: code,
      code_verifier: verifier
    })
  })

  if (!exchangeRes.ok) {
    // Fallback to standard oauth token endpoint
    const fallbackRes = await fetch(`${authBase}/auth/v1/token?grant_type=authorization_code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        redirect_uri: MOBILE_REDIRECT_URI
      })
    })
    if (!fallbackRes.ok) {
      throw new Error(`Token exchange failed (${exchangeRes.status})`)
    }
  }

  const tokenData = (await exchangeRes.json().catch(async () => {
    // Already handled or fallback
    return {}
  })) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    user?: { id: string; email?: string }
  }

  const accessToken = tokenData.access_token || ''
  const refreshToken = tokenData.refresh_token || ''
  const expiresIn = tokenData.expires_in || 3600
  const accountId = tokenData.user?.id || 'account-default'
  const email = tokenData.user?.email

  const session: HostedSession = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Date.now() + expiresIn * 1000,
    account_id: accountId,
    email,
    dashboard_url: base,
    supabase_url: authBase
  }

  await hostedSession.set(session)
  return session
}

/**
 * Opens the hosted dashboard signup page in the system browser.
 */
export async function openHostedSignup(dashboardUrl: string): Promise<void> {
  const base = dashboardUrl.replace(/\/$/, '')
  await Browser.open({ url: `${base}/signup`, presentationStyle: 'popover' })
}

/**
 * Refreshes an expiring hosted Supabase session with serialized concurrency guard.
 */
export async function refreshHostedSession(session: HostedSession): Promise<HostedSession> {
  if (inFlightRefresh) return inFlightRefresh

  inFlightRefresh = (async () => {
    const authBase = (session.supabase_url || session.dashboard_url).replace(/\/$/, '')
    const res = await fetch(`${authBase}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        refresh_token: session.refresh_token
      })
    })

    if (!res.ok) {
      await hostedSession.clear()
      throw new Error('Hosted session expired. Please sign in again.')
    }

    const data = (await res.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      user?: { id: string; email?: string }
    }

    const updated: HostedSession = {
      ...session,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      account_id: data.user?.id || session.account_id,
      email: data.user?.email || session.email
    }

    await hostedSession.set(updated)
    return updated
  })()

  try {
    return await inFlightRefresh
  } finally {
    inFlightRefresh = null
  }
}

/**
 * Logs out of hosted Supabase session, revokes tokens, but preserves local device keys.
 */
export async function logoutHosted(session: HostedSession | null): Promise<void> {
  if (session) {
    try {
      const authBase = (session.supabase_url || session.dashboard_url).replace(/\/$/, '')
      await fetch(`${authBase}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`
        }
      })
    } catch {
      // Best-effort remote revocation
    }
  }
  await hostedSession.clear()
}

/**
 * Enforces strict non-enumerating account matching in hosted mode.
 */
export function assertAccountMatch(qrAccountId?: string, sessionAccountId?: string): void {
  if (!qrAccountId || !sessionAccountId) return
  if (qrAccountId !== sessionAccountId) {
    throw new AccountMismatchError(
      'Account mismatch: This computer was paired with a different Mousse account. Sign in to the matching account or scan a fresh QR.'
    )
  }
}
