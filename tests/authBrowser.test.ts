import { afterEach, describe, expect, it, vi } from 'vitest'
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { isOAuthCallback, openAuthBrowser } from '../src/authBrowser'

function listenerMock() {
  const listeners: Record<string, ((data?: unknown) => void)[]> = {}
  return {
    addListener: vi.fn((eventName: string, handler: (data?: unknown) => void) => {
      ;(listeners[eventName] ??= []).push(handler)
      return Promise.resolve({
        remove: vi.fn(async () => {
          listeners[eventName] = (listeners[eventName] ?? []).filter((h) => h !== handler)
        }),
      })
    }),
    __trigger: (eventName: string, data?: unknown) => {
      for (const handler of listeners[eventName] ?? []) handler(data)
    },
    __count: () => Object.values(listeners).reduce((n, list) => n + list.length, 0),
  }
}

vi.mock('@capacitor/app', () => ({ App: listenerMock() }))
vi.mock('@capacitor/browser', () => ({
  Browser: { ...listenerMock(), open: vi.fn(async () => {}), close: vi.fn(async () => {}) },
}))

const app = CapacitorApp as unknown as ReturnType<typeof listenerMock>
const browser = Browser as unknown as ReturnType<typeof listenerMock> & {
  open: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

afterEach(() => {
  vi.clearAllMocks()
  browser.open.mockImplementation(async () => {})
})

describe('openAuthBrowser', () => {
  it('recognises the callback deep link in the forms the platforms deliver', () => {
    expect(isOAuthCallback(new URL('com.ryspa.mousse:/oauth/callback?code=x'))).toBe(true)
    expect(isOAuthCallback(new URL('mousse://oauth/callback?code=x'))).toBe(true)
    expect(isOAuthCallback(new URL('com.ryspa.mousse:/other'))).toBe(false)
    expect(isOAuthCallback(new URL('https://evil.test/oauth/callback'))).toBe(false)
  })

  it('opens the page, waits for the callback, then closes the browser and its listeners', async () => {
    browser.open.mockImplementation(async () => {
      app.__trigger('appUrlOpen', { url: 'com.ryspa.mousse:/elsewhere' })
      app.__trigger('appUrlOpen', { url: 'com.ryspa.mousse:/oauth/callback?code=handoff' })
    })
    const received = await openAuthBrowser('https://id.test/start')
    expect(browser.open).toHaveBeenCalledWith({ url: 'https://id.test/start', presentationStyle: 'popover' })
    expect(received.searchParams.get('code')).toBe('handoff')
    expect(browser.close).toHaveBeenCalled()
    expect(app.__count() + browser.__count()).toBe(0)
  })

  it('rejects when the browser is closed before the callback', async () => {
    browser.open.mockImplementation(async () => browser.__trigger('browserFinished'))
    await expect(openAuthBrowser('https://id.test/start')).rejects.toThrow('cancelled')
    expect(app.__count() + browser.__count()).toBe(0)
  })

  it('rejects with the open error when the browser cannot be opened', async () => {
    browser.open.mockRejectedValue(new Error('no browser'))
    await expect(openAuthBrowser('https://id.test/start', 50)).rejects.toThrow('no browser')
    expect(app.__count() + browser.__count()).toBe(0)
  })

  it('times out when nothing comes back', async () => {
    await expect(openAuthBrowser('https://id.test/start', 20)).rejects.toThrow('timed out')
    expect(browser.close).toHaveBeenCalled()
  })
})
