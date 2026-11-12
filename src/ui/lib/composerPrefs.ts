import type { ModelSelection } from '../../connection/types'
// Composer choices kept on this phone, like the desktop keeps them per profile: unsent drafts per
// thread, and favourite models per computer. The thread's model and
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

/** The computer the user last opened or started a thread on: a new thread starts there. */
export function loadLastComputer(): string | undefined {
  return read('mousse.newThread.computer') ?? undefined
}

export function saveLastComputer(nodeId: string): void {
  write('mousse.newThread.computer', nodeId)
}

/** The project a new thread on this computer last went to; an empty string is no project. */
export function loadLastProject(nodeId: string): string | undefined {
  return read(`mousse.newThread.project.${nodeId}`) ?? undefined
}

export function saveLastProject(nodeId: string, projectId: string): void {
  write(`mousse.newThread.project.${nodeId}`, projectId)
}

/** What the composer's send does while a reply runs: queue the message, or steer it into the reply. */
export type SendMode = 'queue' | 'steer'

const STEER_THREADS = 'mousse.composer.steerThreads.v1'
/** More threads than anyone keeps in Steer; past it the oldest choice is dropped. */
const MAX_STEER_THREADS = 500

function steerThreads(): string[] {
  try {
    const parsed: unknown = JSON.parse(read(STEER_THREADS) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/** The thread's send mode, as the desktop keeps it per thread; a thread queues until it is switched. */
export function loadSendMode(key: string): SendMode {
  return steerThreads().includes(key) ? 'steer' : 'queue'
}

export function saveSendMode(key: string, mode: SendMode): void {
  const others = steerThreads().filter((entry) => entry !== key)
  const next = mode === 'steer' ? [...others, key].slice(-MAX_STEER_THREADS) : others
  write(STEER_THREADS, next.length ? JSON.stringify(next) : null)
}

/**
 * What a new thread in a project starts with, as last picked on this phone for one of the project's new
 * threads: the model (with its level) and whether it starts in a worktree. Like the desktop's per-project
 * choice (`Project.newThread`); the computer keeps that one for its own windows, so the phone keeps its own.
 */
export interface ProjectChoice {
  model?: ModelSelection
  worktree?: boolean
}

const choiceKey = (nodeId: string, projectId: string) => `mousse.newThread.choice.${nodeId}.${projectId}`

export function loadProjectChoice(nodeId: string, projectId: string): ProjectChoice {
  if (!projectId) return {}
  try {
    const parsed: unknown = JSON.parse(read(choiceKey(nodeId, projectId)) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null) return {}
    const { model, worktree } = parsed as Record<string, unknown>
    const choice: ProjectChoice = {}
    if (isModelSelection(model)) choice.model = model
    if (typeof worktree === 'boolean') choice.worktree = worktree
    return choice
  } catch {
    return {}
  }
}

/** Remembers what was picked; what was not picked this time keeps what was remembered before. */
export function rememberProjectChoice(nodeId: string, projectId: string, choice: ProjectChoice): void {
  if (!projectId) return
  const next = { ...loadProjectChoice(nodeId, projectId), ...Object.fromEntries(Object.entries(choice).filter(([, value]) => value !== undefined)) }
  write(choiceKey(nodeId, projectId), JSON.stringify(next))
}

function isModelSelection(value: unknown): value is ModelSelection {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.llmProvider === 'string' && typeof entry.model === 'string' && (entry.instanceId === undefined || typeof entry.instanceId === 'string')
}
