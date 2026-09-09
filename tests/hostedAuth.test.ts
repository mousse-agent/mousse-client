import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import {
  AccountMismatchError,
  assertAccountMatch,
  loginHosted,
  logoutHosted,
  openHostedSignup,
  refreshHostedSession
} from '../src/hostedAuth'
import { hostedSession } from '../src/storage'
import type { HostedSession } from '../src/types'

vi.mock('@capacitor/app', () => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {}
  return {
    App: {
      addListener: vi.fn((eventName: string, handler: (...args: any[]) => void) => {
        listeners[eventName] = listeners[eventName] || []
        listeners[eventName].push(handler)
        return Promise.resolve({
          remove: vi.fn(async () => {
            listeners[eventName] = (listeners[eventName] || []).filter(h => h !== handler)
          })
        })
      }),
      __trigger: (eventName: string, data: any) => {
        for (const handler of listeners[eventName] || []) {
          handler(data)
        }
      },
      __clear: () => {
        for (const key of Object.keys(listeners)) {
          delete listeners[key]
        }
      }
    }
  }
})

vi.mock('@capacitor/browser', () => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {}
  return {
    Browser: {
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      addListener: vi.fn((eventName: string, handler: (...args: any[]) => void) => {
        listeners[eventName] = listeners[eventName] || []
        listeners[eventName].push(handler)
        return Promise.resolve({
          remove: vi.fn(async () => {
            listeners[eventName] = (listeners[eventName] || []).filter(h => h !== handler)
          })
        })
      }),
      __trigger: (eventName: string, data?: any) => {
        for (const handler of listeners[eventName] || []) {
          handler(data)
        }
      },
      __clear: () => {
        for (const key of Object.keys(listeners)) {
          delete listeners[key]
        }
      }
    }
  }
})

describe('hostedAuth module', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    ;(CapacitorApp as any).__clear()
    ;(Browser as any).__clear()
    await hostedSession.clear()
  })

  describe('assertAccountMatch', () => {
    it('allows matching account ids', () => {
      expect(() => assertAccountMatch('acc-1', 'acc-1')).not.toThrow()
    })

    it('allows when either account id is omitted', () => {
      expect(() => assertAccountMatch(undefined, 'acc-1')).not.toThrow()
      expect(() => assertAccountMatch('acc-1', undefined)).not.toThrow()
    })

    it('throws AccountMismatchError when accounts differ', () => {
      expect(() => assertAccountMatch('acc-1', 'acc-2')).toThrow(AccountMismatchError)
      try {
        assertAccountMatch('acc-1', 'acc-2')
      } catch (err: any) {
        expect(err.code).toBe('ACCOUNT_MISMATCH')
      }
    })
  })

  describe('openHostedSignup', () => {
    it('opens dashboard signup url in browser', async () => {
      await openHostedSignup('https://mousse.example.com/')
      expect(Browser.open).toHaveBeenCalledWith({
        url: 'https://mousse.example.com/signup',
        presentationStyle: 'popover'
      })
    })
  })

  describe('loginHosted', () => {
    it('successfully performs PKCE flow, exchanges token, and saves session', async () => {
      // Mock fetch for token exchange
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'hosted-acc-tok',
          refresh_token: 'hosted-ref-tok',
          expires_in: 3600,
          user: { id: 'usr-123', email: 'user@example.com' }
        })
      }) as any

      // Intercept Browser.open to trigger the appUrlOpen deep link
      ;(Browser.open as any).mockImplementationOnce(async ({ url }: { url: string }) => {
        const parsed = new URL(url)
        const state = parsed.searchParams.get('state')
        // Simulate deep link callback with the exact state and an auth code
        setTimeout(() => {
          ;(CapacitorApp as any).__trigger('appUrlOpen', {
            url: `mousse://oauth/callback?code=test-auth-code&state=${state}`
          })
        }, 10)
      })

      const session = await loginHosted('https://mousse.example.com')

      expect(session.access_token).toBe('hosted-acc-tok')
      expect(session.refresh_token).toBe('hosted-ref-tok')
      expect(session.account_id).toBe('usr-123')
      expect(session.email).toBe('user@example.com')
      expect(session.dashboard_url).toBe('https://mousse.example.com')

      const stored = await hostedSession.get()
      expect(stored).toEqual(session)
    })

    it('rejects on CSRF state mismatch', async () => {
      ;(Browser.open as any).mockImplementationOnce(async () => {
        setTimeout(() => {
          ;(CapacitorApp as any).__trigger('appUrlOpen', {
            url: 'mousse://oauth/callback?code=test-code&state=wrong-state'
          })
        }, 10)
      })

      await expect(loginHosted('https://mousse.example.com')).rejects.toThrow(
        /Authorization state did not match/
      )
    })

    it('rejects on OAuth error returned from callback', async () => {
      ;(Browser.open as any).mockImplementationOnce(async ({ url }: { url: string }) => {
        const parsed = new URL(url)
        const state = parsed.searchParams.get('state')
        setTimeout(() => {
          ;(CapacitorApp as any).__trigger('appUrlOpen', {
            url: `mousse://oauth/callback?error=access_denied&error_description=User+cancelled&state=${state}`
          })
        }, 10)
      })

      await expect(loginHosted('https://mousse.example.com')).rejects.toThrow(/User cancelled/)
    })
  })

  describe('refreshHostedSession', () => {
    it('refreshes token and serializes concurrent calls', async () => {
      const initial: HostedSession = {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: Date.now() - 1000,
        account_id: 'usr-1',
        dashboard_url: 'https://mousse.example.com',
        supabase_url: 'https://mousse.example.com'
      }

      let fetchCount = 0
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCount++
        await new Promise(r => setTimeout(r, 20))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 7200,
            user: { id: 'usr-1', email: 'user@example.com' }
          })
        }
      }) as any

      // Call refreshHostedSession twice concurrently
      const [res1, res2] = await Promise.all([
        refreshHostedSession(initial),
        refreshHostedSession(initial)
      ])

      // Serialized in-flight deduplication must only issue 1 fetch call
      expect(fetchCount).toBe(1)
      expect(res1.access_token).toBe('new-access')
      expect(res2.access_token).toBe('new-access')
      expect(res1.refresh_token).toBe('new-refresh')
      expect(res2.refresh_token).toBe('new-refresh')

      const stored = await hostedSession.get()
      expect(stored?.access_token).toBe('new-access')
    })

    it('clears storage and throws if refresh fails with 401', async () => {
      const initial: HostedSession = {
        access_token: 'old-access',
        refresh_token: 'bad-refresh',
        expires_at: Date.now() - 1000,
        account_id: 'usr-1',
        dashboard_url: 'https://mousse.example.com'
      }

      await hostedSession.set(initial)

      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'invalid_grant' })
      }) as any

      await expect(refreshHostedSession(initial)).rejects.toThrow(/Hosted session expired/)
      const stored = await hostedSession.get()
      expect(stored).toBeNull()
    })
  })

  describe('logoutHosted', () => {
    it('calls remote logout and clears session storage', async () => {
      const session: HostedSession = {
        access_token: 'active-tok',
        refresh_token: 'active-ref',
        expires_at: Date.now() + 100000,
        account_id: 'usr-1',
        dashboard_url: 'https://mousse.example.com'
      }
      await hostedSession.set(session)

      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 })
      globalThis.fetch = fetchMock as any

      await logoutHosted(session)

      expect(fetchMock).toHaveBeenCalledWith(
        'https://mousse.example.com/auth/v1/logout',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer active-tok' }
        })
      )

      const stored = await hostedSession.get()
      expect(stored).toBeNull()
    })
  })
})
