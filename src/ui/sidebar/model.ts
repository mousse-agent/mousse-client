// What the phone's Projects, Threads and Chats tabs show, computed from a computer's lists the way
// the desktop sidebar computes it (mousse/src/renderer/components/ThreadsSidebar.tsx, ChatsSidebar.tsx).
import type { ComputerLists, ListChat, ListThread, RunState } from '../../connection/types'

export const SIDEBAR_TABS = ['projects', 'threads', 'chats'] as const
export type SidebarTab = (typeof SIDEBAR_TABS)[number]

/** Rows a project shows before "Show more", as on the desktop. */
export const PROJECT_PREVIEW_LIMIT = 5

/** Desktop sidebar order: the persisted position, then the id. */
export function compareThreads(a: ListThread, b: ListThread): number {
  if (a.order !== b.order) return a.order - b.order
  return a.id.localeCompare(b.id)
}

/** Merged lists: pinned first, then the most recent activity. Positions of different computers cannot be compared. */
export function compareRecent(a: ListThread, b: ListThread): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.id.localeCompare(b.id)
}

/** Threads that back an agent chat; they appear under Chats, never under Threads or Projects. */
export function chatThreadIds(lists: ComputerLists): Set<string> {
  return new Set(lists.chats.map((chat) => chat.threadId).filter((id): id is string => !!id))
}

export interface SidebarModel {
  /** Started, unsettled threads that are not chats, in sidebar order. */
  threads: ListThread[]
  settled: ListThread[]
  byProject: Map<string, ListThread[]>
  /** Started threads with no project (the Projects tab's "Recent chats"). */
  standalone: ListThread[]
  projectNames: Map<string, string>
  groups: ListChat[]
  direct: ListChat[]
}

/** `recent` orders the Threads tab by activity, for lists merged from several computers. Projects keep the desktop order. */
export function sidebarModel(lists: ComputerLists, query = '', order: 'desktop' | 'recent' = 'desktop'): SidebarModel {
  const hidden = chatThreadIds(lists)
  const needle = query.trim().toLowerCase()
  const projectNames = new Map(lists.projects.map((project) => [project.id, project.name]))
  const matches = (thread: ListThread) =>
    !needle || thread.title.toLowerCase().includes(needle) || (projectNames.get(thread.projectId ?? '') ?? '').toLowerCase().includes(needle)
  const visible = lists.threads.filter((thread) => thread.started && !hidden.has(thread.id) && matches(thread)).sort(compareThreads)
  const unsettled = visible.filter((thread) => !thread.settled)
  const byProject = new Map<string, ListThread[]>()
  const standalone: ListThread[] = []
  for (const thread of unsettled) {
    if (thread.projectId && projectNames.has(thread.projectId)) {
      const list = byProject.get(thread.projectId) ?? []
      list.push(thread)
      byProject.set(thread.projectId, list)
    } else standalone.push(thread)
  }
  const chats = lists.chats
    .filter((chat) => !needle || chat.name.toLowerCase().includes(needle) || (chat.preview ?? '').toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const feed = order === 'recent' ? (list: ListThread[]) => [...list].sort(compareRecent) : (list: ListThread[]) => list
  return {
    threads: feed(unsettled),
    settled: feed(visible.filter((thread) => thread.settled)),
    byProject,
    standalone,
    projectNames,
    groups: chats.filter((chat) => chat.kind === 'group'),
    direct: chats.filter((chat) => chat.kind === 'direct'),
  }
}

/** The status a row shows; a run in the chat counts for its backing thread. */
export function runState(lists: ComputerLists, threadId: string): RunState | undefined {
  return lists.status[threadId]?.state
}

/** "now", "5m", "3h" (under 36 hours), then days: the desktop's threadAge. */
export function threadAge(at: number | undefined, now = Date.now()): string {
  if (!at) return ''
  const delta = now - at
  if (!Number.isFinite(delta) || delta < 45_000) return 'now'
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function projectInitials(name: string): string {
  const parts = name.split(/[\s/._-]+/).filter(Boolean)
  const letters = `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? parts[0]?.[1] ?? ''}`
  return letters.toUpperCase() || '•'
}

function hashText(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0
  return hash
}

/** The project's colour, 1 to 6 (var(--hue-N)), stable across devices. Merged keys use the computer's own project id. */
export function projectHue(projectId: string): number {
  return (Math.abs(hashText(splitKey(projectId)?.id ?? projectId)) % 6) + 1
}

// ---------- One list from several computers ----------

/** One computer's lists, to merge into the home screen's single list. */
export interface ListsSource {
  nodeId: string
  lists: ComputerLists
}

const KEY_SEPARATOR = '\u001f'

/** The id of a project, thread or chat in merged lists: unique across computers. */
export function mergedKey(nodeId: string, id: string): string {
  return `${nodeId}${KEY_SEPARATOR}${id}`
}

/** The computer and its own id behind a merged key; undefined for an id that is not one. */
export function splitKey(key: string): { nodeId: string; id: string } | undefined {
  const at = key.indexOf(KEY_SEPARATOR)
  return at < 0 ? undefined : { nodeId: key.slice(0, at), id: key.slice(at + 1) }
}

/** Positions of one computer's projects stay together, in the order of the computers. */
const PROJECT_ORDER_SPAN = 1_000_000

/**
 * The lists of several computers as one: every id becomes a merged key, so threads of different
 * computers never collide, and each computer's projects stay together in the computers' order.
 */
export function mergeLists(sources: readonly ListsSource[]): ComputerLists {
  const merged: ComputerLists = { projects: [], threads: [], chats: [], bots: [], status: {}, receivedAt: 0 }
  sources.forEach(({ nodeId, lists }, index) => {
    const key = (id: string) => mergedKey(nodeId, id)
    for (const project of lists.projects) merged.projects.push({ ...project, id: key(project.id), order: index * PROJECT_ORDER_SPAN + project.order })
    for (const thread of lists.threads) merged.threads.push({ ...thread, id: key(thread.id), ...(thread.projectId ? { projectId: key(thread.projectId) } : {}) })
    for (const chat of lists.chats)
      merged.chats.push({
        ...chat,
        id: key(chat.id),
        ...(chat.threadId ? { threadId: key(chat.threadId) } : {}),
        ...(chat.projectId ? { projectId: key(chat.projectId) } : {}),
      })
    for (const bot of lists.bots ?? []) merged.bots.push({ ...bot, id: key(bot.id) })
    for (const [id, status] of Object.entries(lists.status)) merged.status[key(id)] = status
    merged.receivedAt = Math.max(merged.receivedAt, lists.receivedAt)
  })
  return merged
}

/** The chat avatar's colour, 0 to 4 (.m-chat-color-N). */
export function chatColor(name: string): number {
  return [...name].reduce((value, char) => value + char.charCodeAt(0), 0) % 5
}

/** The line under a chat's name, as on the desktop. */
export function chatPreview(chat: ListChat): string {
  if (chat.network) return 'Space conversation'
  if (chat.run?.state === 'running') return 'Working…'
  if (chat.preview) return chat.preview
  return chat.agents.length === 1 ? '1 agent' : `${chat.agents.length} agents`
}

const TAB_KEY = 'mousse.sidebar.tab'

export function savedTab(): SidebarTab {
  try {
    const value = localStorage.getItem(TAB_KEY)
    return (SIDEBAR_TABS as readonly string[]).includes(value ?? '') ? (value as SidebarTab) : 'threads'
  } catch {
    return 'threads'
  }
}

export function saveTab(tab: SidebarTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // The tab simply resets to Threads on the next start.
  }
}
