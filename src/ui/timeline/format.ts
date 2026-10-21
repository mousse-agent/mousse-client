// Pure helpers for the thread timeline. Labels, truncation and grouping follow the desktop's
// agent-elements (mousse/src/renderer/chat/components/agent-elements): tool-registry.ts,
// utils/format-tool.ts, utils/assistant-blocks.ts, turn-edit-summary.tsx and message-list.tsx.
import type { ChatItem, ChatToolCall } from '../../connection/types'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text
}

// ---- Text helpers (utils/format-tool.ts) ----

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])(\*|_)([^*_]+)\2/g, '$1$3')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .trim()
}

/** First non-empty line of a thought, without markdown, at most 64 characters. */
export function thoughtHeading(content: string | undefined): string {
  if (!content) return ''
  const first = content.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const plain = stripInlineMarkdown(first.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '')).trim()
  return plain.length <= 64 ? plain : `${plain.slice(0, 61).trimEnd()}...`
}

export function commandSummary(command: string): string {
  const collapsed = command.replace(/\s+/g, ' ').trim()
  return collapsed.length <= 64 ? collapsed : `${collapsed.slice(0, 61).trimEnd()}...`
}

/** Strips sandbox prefixes and starts at the first apps|packages|src|lib|components folder. */
export function displayPath(filePath: string): string {
  if (!filePath) return ''
  for (const prefix of ['/project/sandbox/repo/', '/project/sandbox/', '/project/', '/workspace/'])
    if (filePath.startsWith(prefix)) return filePath.slice(prefix.length)
  if (filePath.startsWith('/')) {
    const parts = filePath.split('/')
    const root = parts.findIndex((part) => ['apps', 'packages', 'src', 'lib', 'components'].includes(part))
    if (root > 0) return parts.slice(root).join('/')
  }
  return filePath
}

export const baseName = (path: string): string => path.split(/[\\/]/).pop() || path

/** Keeps the end of a long path, where the file name is: "…/net/resume.test.ts". */
export function shortPath(path: string, max = 40): string {
  if (path.length <= max) return path
  const parts = path.split('/')
  let out = parts.pop() ?? path
  while (parts.length && out.length + parts[parts.length - 1].length + 1 <= max - 2) out = `${parts.pop()}/${out}`
  return `…/${out}`
}

export function filePathOf(input: unknown): string {
  if (!isObject(input)) return ''
  const raw = input.file_path ?? input.path ?? input.filePath ?? input.file ?? input.notebook_path
  return typeof raw === 'string' ? raw : ''
}

// ---- Tool status ----

export type ToolState = 'running' | 'done' | 'error' | 'interrupted'

/** A tool that is not finished counts as running while the turn is live, and interrupted after it. */
export function toolState(item: ChatItem, turnLive: boolean): ToolState {
  if (item.status === 'error') return 'error'
  if (isObject(item.tool?.output) && item.tool.output.success === false) return 'error'
  if (item.status === 'streaming') return turnLive ? 'running' : 'interrupted'
  return 'done'
}

// ---- Bash ----

export function bashCommand(tool: ChatToolCall): string {
  return str(tool.input?.command)
}

/** stdout and stderr, or the plain result text, and whether the exit code says it worked. */
export function bashOutput(tool: ChatToolCall): { text: string; ok: boolean } {
  const output = tool.output
  if (typeof output === 'string') return { text: output, ok: true }
  if (isObject(output)) {
    const stdout = str(output.stdout) || str(output.output)
    const stderr = str(output.stderr)
    const exit = output.exitCode ?? output.exit_code
    return { text: [stdout, stderr].filter(Boolean).join('\n'), ok: exit === undefined || exit === 0 }
  }
  return { text: output === undefined ? '' : JSON.stringify(output, null, 2), ok: true }
}

// ---- Diffs ----

export interface DiffLine {
  type: 'add' | 'remove' | 'context'
  text: string
}

const MAX_DIFF_CELLS = 400_000

/** A line diff by longest common subsequence; very large inputs fall back to remove-all/add-all. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head = a.slice(0, start).map((text): DiffLine => ({ type: 'context', text }))
  const tail = a.slice(endA).map((text): DiffLine => ({ type: 'context', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const middle: DiffLine[] = []
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    for (const text of midA) middle.push({ type: 'remove', text })
    for (const text of midB) middle.push({ type: 'add', text })
  } else {
    const n = midA.length
    const m = midB.length
    const w = m + 1
    const table = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i * w + j] = midA[i] === midB[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ type: 'context', text: midA[i] })
        i++
        j++
      } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) middle.push({ type: 'remove', text: midA[i++] })
      else middle.push({ type: 'add', text: midB[j++] })
    }
    while (i < n) middle.push({ type: 'remove', text: midA[i++] })
    while (j < m) middle.push({ type: 'add', text: midB[j++] })
  }
  return [...head, ...middle, ...tail]
}

/** Keeps changed lines with up to `context` lines around them; `null` marks a skipped stretch. */
export function hunks(lines: DiffLine[], context = 3): Array<DiffLine | null> {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.type === 'context') return
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true
  })
  const out: Array<DiffLine | null> = []
  let skipped = false
  lines.forEach((line, index) => {
    if (keep[index]) {
      out.push(line)
      skipped = false
    } else if (!skipped) {
      out.push(null)
      skipped = true
    }
  })
  return out
}

function patchLines(patches: unknown): DiffLine[] | undefined {
  if (!Array.isArray(patches)) return undefined
  const out: DiffLine[] = []
  for (const patch of patches) {
    const lines = isObject(patch) ? patch.lines : undefined
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (typeof line !== 'string' || line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) out.push({ type: 'add', text: line.slice(1) })
      else if (line.startsWith('-')) out.push({ type: 'remove', text: line.slice(1) })
      else out.push({ type: 'context', text: line.startsWith(' ') ? line.slice(1) : line })
    }
  }
  return out.length ? out : undefined
}

/** The change an Edit or Write call made, from whichever shape the provider used. */
export function editDiff(tool: ChatToolCall): DiffLine[] {
  const input = tool.input ?? {}
  const output = isObject(tool.output) ? tool.output : undefined
  const fromPatch = patchLines(output?.structuredPatch)
  if (fromPatch) return fromPatch
  if (tool.name === 'Write') {
    const content = str(output?.content) || str(input.content) || str(input.contents)
    const body = content.endsWith('\n') ? content.slice(0, -1) : content
    return content ? body.split('\n').map((text): DiffLine => ({ type: 'add', text })) : []
  }
  if (Array.isArray(input.edits)) {
    const out: DiffLine[] = []
    for (const edit of input.edits) {
      if (!isObject(edit)) continue
      out.push(...diffLines(str(edit.oldText ?? edit.old_string), str(edit.newText ?? edit.new_string)))
    }
    return out
  }
  const before = str(input.old_string ?? input.oldText) || str(output?.old_content)
  const after = str(input.new_string ?? input.newText) || (input.old_string === undefined ? str(output?.content) : '')
  return before || after ? diffLines(before, after) : []
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.type === 'add') added++
    else if (line.type === 'remove') removed++
  }
  return { added, removed }
}

// ---- Search ----

/** How many results a search returned, when the result says, and the result lines. */
export function searchResults(tool: ChatToolCall): { count: number; lines: string[] } {
  const output = tool.output
  if (isObject(output)) {
    const names = Array.isArray(output.filenames) ? output.filenames.map(String) : []
    if (typeof output.numFiles === 'number') return { count: output.numFiles, lines: names }
    if (Array.isArray(output.results)) {
      const lines = output.results
        .map((entry) => (isObject(entry) ? str(entry.title) || str(entry.url) || str(entry.source) : String(entry)))
        .filter(Boolean)
      return { count: lines.length, lines }
    }
    if (names.length) return { count: names.length, lines: names }
  }
  if (Array.isArray(output)) return { count: output.length, lines: output.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))) }
  if (typeof output === 'string') {
    const lines = output.split('\n').filter((line) => line.trim())
    if (!lines.length || /^no (matches|files|results)/i.test(lines[0])) return { count: 0, lines: [] }
    return { count: lines.length, lines }
  }
  return { count: 0, lines: [] }
}

/** "Found 3 results" / "No matches", and `Grep "query"` as the detail. */
export function searchLabels(tool: ChatToolCall, found: number): { done: string; detail: string } {
  const name = tool.name === 'WebSearch' ? 'Web search' : tool.name
  const query = (str(tool.input?.query) || str(tool.input?.pattern)).trim()
  const detail = query ? `${name} “${query}”` : name
  return { done: found > 0 ? `Found ${found} ${found === 1 ? 'result' : 'results'}` : 'No matches', detail }
}

// ---- Todos ----

export interface TodoEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export function todosOf(tool: ChatToolCall): TodoEntry[] {
  const todos = tool.input?.todos
  if (!Array.isArray(todos)) return []
  return todos.filter(isObject).map((todo) => ({
    content: str(todo.content) || str(todo.activeForm) || str(todo.title),
    status: todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending',
  }))
}

// ---- MCP (tools/mcp-tool.tsx) ----

const ACTIVE_VERBS: Record<string, string> = {
  List: 'Listing', Get: 'Getting', Create: 'Creating', Update: 'Updating', Delete: 'Deleting', Search: 'Searching',
  Fetch: 'Fetching', Retrieve: 'Retrieving', Send: 'Sending', Generate: 'Generating', Add: 'Adding', Remove: 'Removing',
  Modify: 'Modifying', Draft: 'Drafting', Manage: 'Managing', Query: 'Querying', Start: 'Starting', Set: 'Setting',
  Check: 'Checking', Find: 'Finding',
}
const DONE_VERBS: Record<string, string> = {
  List: 'Listed', Get: 'Got', Create: 'Created', Update: 'Updated', Delete: 'Deleted', Search: 'Searched',
  Fetch: 'Fetched', Retrieve: 'Retrieved', Send: 'Sent', Generate: 'Generated', Add: 'Added', Remove: 'Removed',
  Modify: 'Modified', Draft: 'Drafted', Manage: 'Managed', Query: 'Queried', Start: 'Started', Set: 'Set',
  Check: 'Checked', Find: 'Found',
}
const PRIORITY_ARGS = ['query', 'question', 'email', 'name', 'id', 'customer', 'url', 'issue', 'body', 'summary', 'title']

/** "list_issues" → "List issues". */
export function mcpDisplayName(tool: ChatToolCall): string {
  const raw = tool.rawName || tool.title || 'tool'
  const words = raw
    .replace(/^mcp__[^_]+__/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Tool'
}

export function mcpTitle(tool: ChatToolCall, state: ToolState): string {
  const name = mcpDisplayName(tool)
  if (state === 'interrupted') return `${name} interrupted`
  const [verb, ...rest] = name.split(' ')
  const mapped = (state === 'running' ? ACTIVE_VERBS : DONE_VERBS)[verb]
  return mapped ? [mapped, ...rest].join(' ') : name
}

export function mcpArgs(input: unknown): string {
  if (!isObject(input)) return ''
  const entries = Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== '')
  entries.sort(([a], [b]) => {
    const ai = PRIORITY_ARGS.indexOf(a)
    const bi = PRIORITY_ARGS.indexOf(b)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return 0
  })
  return entries
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${truncate(typeof value === 'string' ? value : JSON.stringify(value), 30)}`)
    .join('  ')
}

/** MCP results are often `[{type:'text', text}]`; unwrap them and parse JSON text. */
export function unwrapOutput(output: unknown): unknown {
  if (!Array.isArray(output)) return output
  const text = output
    .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('')
  if (!text) return output
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** A result as display text, capped, and whether it is JSON. */
export function outputText(output: unknown, max = 3000): { text: string; json: boolean } {
  const value = unwrapOutput(output)
  if (value === undefined || value === null || value === '') return { text: '', json: false }
  if (typeof value === 'string') return { text: value.length > max ? `${value.slice(0, max)}…` : value, json: false }
  const text = JSON.stringify(value, null, 2)
  return { text: text.length > max ? `${text.slice(0, max)}…` : text, json: true }
}

// ---- Generic tool titles (tool-registry.ts) ----

/** Title and subtitle for tools without their own card. */
export function genericTitle(tool: ChatToolCall, state: ToolState): { title: string; subtitle: string } {
  const pending = state === 'running'
  const input = tool.input ?? {}
  const path = filePathOf(input)
  switch (tool.name) {
    case 'Read':
      return { title: pending ? 'Reading' : 'Read', subtitle: path ? baseName(path) : '' }
    case 'WebFetch': {
      const url = str(input.url)
      let host = url.slice(0, 30)
      try {
        host = new URL(url).hostname.replace('www.', '')
      } catch {
        // Not a URL.
      }
      return { title: pending ? 'Fetching' : 'Fetched', subtitle: host }
    }
    case 'Skill':
      return { title: 'Skill', subtitle: str(input.skill) || str(input.name) || tool.summary }
    case 'ExitPlanMode':
      return { title: pending ? 'Finishing plan' : 'Plan complete', subtitle: '' }
    case 'NotebookEdit':
      return { title: pending ? 'Editing notebook' : 'Edited notebook', subtitle: path ? baseName(path) : '' }
    case 'KillShell':
      return { title: pending ? 'Stopping shell' : 'Shell stopped', subtitle: typeof input.pid === 'number' ? `pid ${input.pid}` : '' }
    case 'cloning':
      return { title: pending ? 'Cloning repo' : 'Repo cloned', subtitle: str(input.repo) }
    default: {
      const name = tool.rawName || tool.title || 'Tool'
      const subtitle = tool.title && tool.title !== name ? tool.title : truncate(tool.summary, 50)
      return { title: pending ? `Running ${name}` : name, subtitle }
    }
  }
}

// ---- Turns (message-list.tsx, utils/assistant-blocks.ts) ----

export interface Turn {
  key: string
  user?: ChatItem
  replies: ChatItem[]
}

/** Splits the timeline into turns: each user message and everything after it. */
export function groupTurns(items: ChatItem[]): Turn[] {
  const turns: Turn[] = []
  for (const item of items) {
    if (item.role === 'user') turns.push({ key: item.id, user: item, replies: [] })
    else if (turns.length) turns[turns.length - 1].replies.push(item)
    else turns.push({ key: `lead-${item.id}`, replies: [item] })
  }
  return turns
}

/** Thoughts and tool calls group together; questions stand alone, like the desktop. */
export function isActivity(item: ChatItem): boolean {
  if (item.kind === 'thinking') return true
  return item.kind === 'tool' && item.tool?.name !== 'Question'
}

export type Segment = { kind: 'item'; item: ChatItem } | { kind: 'group'; items: ChatItem[] }

/** Runs of two or more activity rows collapse into one group. */
export function segmentReplies(replies: ChatItem[]): Segment[] {
  const segments: Segment[] = []
  let run: ChatItem[] = []
  const flush = () => {
    if (run.length >= 2) segments.push({ kind: 'group', items: run })
    else for (const item of run) segments.push({ kind: 'item', item })
    run = []
  }
  for (const item of replies) {
    if (isActivity(item)) run.push(item)
    else {
      flush()
      segments.push({ kind: 'item', item })
    }
  }
  flush()
  return segments
}

/** The latest thought heading in a group, or "" to fall back to "Tool calls". */
export function groupLabel(items: ChatItem[]): string {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item.kind === 'thinking') {
      const heading = thoughtHeading(item.text)
      if (heading) return heading
    }
  }
  return ''
}

export interface FileEdit {
  path: string
  added: number
  removed: number
}

/** Files the turn's finished Edit and Write calls changed, with line counts. */
export function turnEdits(replies: ChatItem[]): { files: FileEdit[]; added: number; removed: number } | undefined {
  const byPath = new Map<string, FileEdit>()
  for (const item of replies) {
    const tool = item.tool
    if (!tool || item.status !== 'done' || (tool.name !== 'Edit' && tool.name !== 'Write')) continue
    const path = filePathOf(tool.input)
    if (!path) continue
    const { added, removed } = diffStats(editDiff(tool))
    const shown = displayPath(path)
    const entry = byPath.get(shown) ?? { path: shown, added: 0, removed: 0 }
    entry.added += added
    entry.removed += removed
    byPath.set(shown, entry)
  }
  if (!byPath.size) return undefined
  const files = [...byPath.values()]
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  }
}

// ---- Durations and times (message-list.tsx, utils/assistantMessageActions.ts) ----

function durationParts(ms: number): { hours: number; minutes: number; seconds: number } {
  const total = Math.max(0, Math.floor(ms / 1000))
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 }
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function formatWorkingFor(ms: number): string {
  const { hours, minutes, seconds } = durationParts(ms)
  if (hours) return `Working for ${plural(hours, 'hour')}, ${plural(minutes, 'minute')}, and ${plural(seconds, 'second')}`
  if (minutes) return `Working for ${plural(minutes, 'minute')} and ${plural(seconds, 'second')}`
  return `Working for ${plural(seconds, 'second')}`
}

export function formatWorkedFor(ms: number): string {
  const { hours, minutes, seconds } = durationParts(ms)
  if (hours) return `Worked for ${[`${hours}h`, minutes ? `${minutes}m` : '', seconds ? `${seconds}s` : ''].filter(Boolean).join(' ')}`
  if (minutes) return seconds ? `Worked for ${minutes}m ${seconds}s` : `Worked for ${minutes}m`
  return `Worked for ${seconds}s`
}

/** "12s" or "2m 5s", for subagent cards. */
export function formatElapsed(ms: number): string {
  const { hours, minutes, seconds } = durationParts(ms)
  if (hours) return `${hours}h ${minutes}m`
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** "3:04 PM" today, otherwise "Oct 3". */
export function formatTimestamp(at: number, now = Date.now()): string {
  if (!at) return ''
  const date = new Date(at)
  const today = new Date(now)
  const sameDay =
    date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return sameDay
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

export function formatResponseTime(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'Unavailable'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`
}

export function formatTokens(tokens?: number): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return 'Unavailable'
  return new Intl.NumberFormat().format(Math.round(tokens))
}

export function formatTokensPerSecond(rate?: number): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return 'Unavailable'
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(rate)
}
