import { Preferences } from '@capacitor/preferences'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import type { TokenSet } from './types'

const TOKEN_KEY = 'mousse.connection.tokens.v1'
const CONNECTION_KEY = 'mousse.connection.info.v1'
async function secureGet(key: string) {
  try { return await SecureStorage.getItem(key) } catch { return (await Preferences.get({ key })).value }
}
async function secureSet(key: string, value: string) {
  try { await SecureStorage.setItem(key, value) } catch { await Preferences.set({ key, value }) }
}
export const tokens = { async get() { const raw = await secureGet(TOKEN_KEY); return raw ? JSON.parse(raw) as TokenSet : null }, set: (value: TokenSet) => secureSet(TOKEN_KEY, JSON.stringify(value)), async clear() { try { await SecureStorage.removeItem(TOKEN_KEY) } catch {} ; await Preferences.remove({ key: TOKEN_KEY }); await Preferences.remove({ key: CONNECTION_KEY }) } }
export const connectionCache = { async get() { const { value } = await Preferences.get({ key: CONNECTION_KEY }); return value ? JSON.parse(value) : null }, set: (value: unknown) => Preferences.set({ key: CONNECTION_KEY, value: JSON.stringify(value) }) }
