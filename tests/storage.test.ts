import { describe, expect, it, vi } from 'vitest'

const { getItem, setItem, preferencesGet, preferencesSet } = vi.hoisted(() => ({
  getItem: vi.fn().mockRejectedValue(new Error('keystore unavailable')),
  setItem: vi.fn().mockRejectedValue(new Error('keystore unavailable')),
  preferencesGet: vi.fn(),
  preferencesSet: vi.fn()
}))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }))
vi.mock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: { getItem, setItem, removeItem: vi.fn() } }))
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: preferencesGet, set: preferencesSet, remove: vi.fn() } }))

import { tokens } from '../src/storage'

describe('token persistence', () => {
  it('never falls back to Preferences when native secure storage fails', async () => {
    await expect(tokens.get()).rejects.toThrow('Secure storage is unavailable')
    await expect(tokens.set({ access_token: 'access', refresh_token: 'refresh', expires_at: 1, scope: 'mousse:read', client_id: 'client', base_url: 'https://mousse.test', issuer: 'https://mousse.test' })).rejects.toThrow('Secure storage is unavailable')
    expect(preferencesGet).not.toHaveBeenCalled()
    expect(preferencesSet).not.toHaveBeenCalled()
  })
})
