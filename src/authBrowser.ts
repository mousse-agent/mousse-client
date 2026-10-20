// Browser sign-in round trips: open a page in the system browser and wait for it to come back to
// the app through the com.ryspa.mousse:/oauth/callback deep link (see AndroidManifest.xml and
// Info.plist). Used by hosted sign-in and by "Continue with Google".
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'

const DEFAULT_TIMEOUT_MS = 180_000

/** True for the app's OAuth callback deep link, in any of the forms the platforms deliver it. */
export function isOAuthCallback(received: URL): boolean {
  return (
    (received.protocol === 'com.ryspa.mousse:' || received.protocol === 'mousse:') &&
    (received.pathname === '/oauth/callback' ||
      received.pathname === '//oauth/callback' ||
      (received.host === 'oauth' && (received.pathname === '/callback' || received.pathname === '')) ||
      `${received.host}${received.pathname}`.replace(/^\/+/, '') === 'oauth/callback')
  )
}

/**
 * Opens `url` in the system browser and resolves with the callback URL the browser returns to.
 * Closes the browser either way. Rejects when the browser is closed first or after `timeoutMs`.
 */
export async function openAuthBrowser(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<URL> {
  let removeCallback: (() => Promise<void>) | undefined
  let listenerReady: Promise<void> | undefined
  let abort: (error: Error) => void = () => undefined

  const callback = new Promise<URL>((resolve, reject) => {
    let settled = false
    const finish = (value?: URL, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void removeCallback?.()
      value ? resolve(value) : reject(error)
    }

    abort = (error) => finish(undefined, error)
    const timer = setTimeout(() => finish(undefined, new Error('Sign-in timed out. Try again.')), timeoutMs)

    listenerReady = Promise.all([
      CapacitorApp.addListener('appUrlOpen', ({ url }) => {
        try {
          const received = new URL(url)
          if (isOAuthCallback(received)) finish(received)
        } catch {
          finish(undefined, new Error('The sign-in callback URL was invalid.'))
        }
      }),
      Browser.addListener('browserFinished', () => {
        finish(undefined, new Error('Sign-in was cancelled when the browser closed.'))
      }),
    ]).then(([appListener, browserListener]) => {
      removeCallback = async () => {
        await appListener.remove()
        await browserListener.remove()
      }
      if (settled) return removeCallback()
    })
  })
  // A failed Browser.open settles the callback below; nothing else awaits it then.
  callback.catch(() => undefined)

  try {
    await listenerReady
    try {
      await Browser.open({ url, presentationStyle: 'popover' })
    } catch (error) {
      abort(error instanceof Error ? error : new Error('The browser could not be opened.'))
      throw error
    }
    return await callback
  } finally {
    await Browser.close().catch(() => undefined)
    await listenerReady
    await removeCallback?.()
  }
}
