// Composer choices kept on this phone, like the desktop keeps them per profile: the chat mode per
// computer, unsent drafts per thread, and favourite models per computer. The thread's model and
// effort live on the computer (the thread record), not here.

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key)
    else globalThis.localStorage?.setItem(key, value)
  } catch {
    // Storage can be unavailable (private mode, tests); the composer still works without it.
  }
}

const BUILT_IN_MODES = new Set(['plan', 'agent', 'build'])
export const DEFAULT_MODE = 'agent'

export function loadMode(nodeId: string): string {
  const value = read(`mousse.composer.mode.${nodeId}`)
  return value && BUILT_IN_MODES.has(value) ? value : DEFAULT_MODE
}

export function saveMode(nodeId: string, mode: string): void {
  write(`mousse.composer.mode.${nodeId}`, mode === DEFAULT_MODE ? null : mode)
}

export function loadDraft(key: string): string {
  return read(`mousse.composer.draft.${key}`) ?? ''
}

export function saveDraft(key: string, text: string): void {
  write(`mousse.composer.draft.${key}`, text ? text : null)
}

export function loadFavorites(nodeId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(read(`mousse.composer.favorites.${nodeId}`) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveFavorites(nodeId: string, favorites: Set<string>): void {
  write(`mousse.composer.favorites.${nodeId}`, favorites.size ? JSON.stringify([...favorites]) : null)
}
