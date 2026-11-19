// Per-bot checklist visibility ("Hide checklist" / "Show checklist"), matching desktop's botChecklistSetting.ts.
import { useSyncExternalStore } from 'react'

const KEY = 'mousse.bots.checklistHidden'
const listeners = new Set<() => void>()

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

let cached: Set<string> | undefined

function current(): Set<string> {
  if (!cached) cached = read()
  return cached
}

export function setBotChecklistHidden(botId: string, hidden: boolean): void {
  const next = new Set(current())
  if (hidden) next.add(botId)
  else next.delete(botId)
  cached = next
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]))
  } catch {
    // Ignore storage errors.
  }
  for (const listener of listeners) listener()
}

export function useBotChecklistHidden(botId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => current().has(botId),
    () => false,
  )
}
