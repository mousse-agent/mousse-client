// Moments when the phone's network may have changed: the OS reports a new connection (Wi-Fi on or
// off, another network), the browser goes online or offline, or the app comes back to the
// foreground. Sessions use them to check their path at once instead of waiting for a missed ping.

export interface NetworkSignals {
  /** Calls `listener` after each change; returns a function that stops it. */
  onChange(listener: () => void): () => void
}

const listeners = new Set<() => void>()
let started = false

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One listener's failure never stops the others.
    }
  }
}

function start(): void {
  if (started) return
  started = true
  if (typeof window !== 'undefined') {
    window.addEventListener('online', notify)
    window.addEventListener('offline', notify)
  }
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') notify()
    })
  // The Capacitor plugin reports Wi-Fi and cellular changes the browser events miss.
  void import('@capacitor/network')
    .then(({ Network }) => Network.addListener('networkStatusChange', notify))
    .catch(() => undefined)
  // The webview may not report its return as a visibility change; the app plugin does.
  void import('@capacitor/app')
    .then(({ App }) => App.addListener('resume', notify))
    .catch(() => undefined)
}

/** The device's network signals, shared by every session. */
export const deviceNetworkSignals: NetworkSignals = {
  onChange(listener) {
    start()
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

/** Signals a test fires by hand. */
export function manualNetworkSignals(): NetworkSignals & { fire(): void } {
  const own = new Set<() => void>()
  return {
    onChange(listener) {
      own.add(listener)
      return () => {
        own.delete(listener)
      }
    },
    fire() {
      for (const listener of [...own]) listener()
    },
  }
}
