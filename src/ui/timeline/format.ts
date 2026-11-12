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

const SHELL_WRAPPER = /^(?:\S*[\\/])?(?:bash|sh|zsh|dash|fish|ksh)(?:\.exe)?\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c\s+([\s\S]+)$/
const CMD_WRAPPER = /^(?:\S*[\\/])?cmd(?:\.exe)?\s+(?:\/[a-zA-Z]\s+)*\/[ck]\s+([\s\S]+)$/i
const POWERSHELL_WRAPPER =
  /^(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:-(?:NoProfile|NoLogo|NonInteractive|NoExit|Login)\s+|-(?:ExecutionPolicy|ep|WindowStyle)\s+\S+\s+)*-(?:Command|c)\s+([\s\S]+)$/i
const ENV_WRAPPER = /^env\s+(?:(?:-\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*([\s\S]+)$/
const SUDO_WRAPPER = /^sudo\s+(?:-\S+\s+)*([\s\S]+)$/

function unquote(text: string): string {
  const trimmed = text.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1)
    return quote === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner
  }
  return trimmed
}

/**
 * The command a shell invocation runs, for a one-line label (shared/agentActivity.ts commandLabel): `bash -lc '…'`,
 * `sh -c`, `env FOO=1 …`, `sudo …`, `cmd /c …` and `powershell -Command …` are unwrapped and spacing collapses.
 */
export function commandLabel(command: string): string {
  let current = command.trim()
  for (let depth = 0; depth < 5; depth += 1) {
    const match =
      SHELL_WRAPPER.exec(current) ?? POWERSHELL_WRAPPER.exec(current) ?? CMD_WRAPPER.exec(current) ?? ENV_WRAPPER.exec(current) ?? SUDO_WRAPPER.exec(current)
    if (!match) break
    const inner = unquote(match[1]!)
    if (!inner || inner === current) break
    current = inner
  }
  return current.replace(/\s+/g, ' ').trim()
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

/** The line some runtimes (Claude Code) put before a failed command's output: `Exit code 1`. */
const EXIT_CODE_LINE = /^Exit code (-?\d+)(?:\r?\n|$)/

/** A command's result text split into its exit code and its output, when it starts with `Exit code N`. */
export function splitExitCode(result: string): { exitCode?: number; output: string } {
  const match = EXIT_CODE_LINE.exec(result)
  if (!match) return { output: result }
  return { exitCode: Number(match[1]), output: result.slice(match[0].length) }
}

export interface BashResult {
  text: string
  /** False when the exit code says it failed. */
  ok: boolean
  exitCode?: number
  durationMs?: number
  /** Earlier output was cut; `bytes` is how much there was. */
  truncated?: boolean
  bytes?: number
  cwd?: string
}

/** stdout and stderr, or the plain result text, with the exit code, time and folder when the result says. */
export function bashOutput(tool: ChatToolCall): BashResult {
  const output = tool.output
  const cwd = str(tool.input?.cwd) || undefined
  if (typeof output === 'string') {
    const { exitCode, output: text } = splitExitCode(output)
    return { text, ok: exitCode === undefined || exitCode === 0, ...(exitCode !== undefined ? { exitCode } : {}), ...(cwd ? { cwd } : {}) }
  }
  if (isObject(output)) {
    const stdout = str(output.stdout) || str(output.output)
    const stderr = str(output.stderr)
    let text = [stdout, stderr].filter(Boolean).join('\n')
    let exit = typeof output.exitCode === 'number' ? output.exitCode : typeof output.exit_code === 'number' ? output.exit_code : undefined
    if (exit === undefined) {
      const split = splitExitCode(text)
      if (split.exitCode !== undefined) ({ exitCode: exit, output: text } = split)
    }
    const durationMs = typeof output.durationMs === 'number' ? output.durationMs : undefined
    const bytes = typeof output.bytes === 'number' ? output.bytes : undefined
    return {
      text,
      ok: exit === undefined || exit === 0,
      ...(exit !== undefined ? { exitCode: exit } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(output.truncated === true ? { truncated: true } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(cwd || str(output.cwd) ? { cwd: cwd || str(output.cwd) } : {}),
    }
  }
  return { text: output === undefined ? '' : JSON.stringify(output, null, 2), ok: true, ...(cwd ? { cwd } : {}) }
}

/** Terminal escape sequences (colours, cursor moves, titles): plain text shows them as noise. */
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g
/** A line a test runner or compiler marks as a failure: `× adds`, `FAIL a.test.ts`, `Error: …`, `npm ERR! …`. */
const FAILURE_LINE = /^\s*(?:[×✗✘✕]\s|(?:FAIL|FAILED)\b|ERR!|npm ERR!|[A-Za-z]*Error:|error(?:\[[A-Z0-9]+\])?:)/

/** The output as lines, escape sequences removed, with failure lines marked for the danger colour. */
export function bashOutputLines(output: string): Array<{ text: string; failed: boolean }> {
  return output
    .replace(ESCAPE_PATTERN, '')
    .split('\n')
    .map((text) => ({ text, failed: FAILURE_LINE.test(text) }))
}

/** "850ms", "2.4s", "1m 5s", for a command's exit line. */
export function formatCommandDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Whether a call failed, finished or not. */
export function toolFailed(item: ChatItem): boolean {
  if (item.status === 'error') return true
  const tool = item.tool
  if (!tool) return false
  if (isObject(tool.output) && tool.output.success === false) return true
  return tool.name === 'Bash' && item.status === 'done' && !bashOutput(tool).ok
}

/**
 * The failed calls of a turn the agent got past (mousseToUI.ts markRecoveredFailures): a later call succeeded, a
 * reply followed, or the turn ended normally. Their rows stay quiet. A failure is loud only when nothing came after
 * it and the turn ended on an error or was cut off (`endedBadly`).
 */
export function recoveredFailures(replies: ChatItem[], endedBadly: boolean): Set<string> {
  const recovered = new Set<string>()
  let pending: string[] = []
  const settle = (failed: boolean) => {
    if (!failed) for (const id of pending) recovered.add(id)
    pending = []
  }
  for (const item of replies) {
    if (item.error) {
      settle(true)
      continue
    }
    if (item.kind === 'tool' && item.tool) {
      if (toolFailed(item)) pending.push(item.id)
      else if (item.status === 'done') settle(false)
      continue
    }
    if (item.role === 'assistant' && item.kind === 'message' && item.text.trim()) settle(false)
  }
  settle(endedBadly)
  return recovered
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

/** Calls drawn on their own surface, never inside a group or folded behind a finished turn's line. */
const STANDALONE_TOOLS = new Set(['Question', 'QuestionAnswers', 'QuickAction', 'ExitPlanMode', 'PlanWrite'])
/** A runtime's own subagent: a card of its own, outside any group. */
export const isSubagentItem = (item: ChatItem): boolean => item.kind === 'tool' && (item.tool?.name === 'Task' || item.tool?.name === 'Agent')

/** Thoughts and tool calls group together; questions, plans, quick actions and subagents stand alone. */
export function isActivity(item: ChatItem): boolean {
  if (item.kind === 'thinking') return true
  return item.kind === 'tool' && !!item.tool && !STANDALONE_TOOLS.has(item.tool.name) && !isSubagentItem(item)
}

/** A call (not a thought) that has not finished. */
export const isRunningCall = (item: ChatItem): boolean => item.kind === 'tool' && item.status === 'streaming'
/** A thought still being written. */
export const isLiveThought = (item: ChatItem | undefined): boolean => item?.kind === 'thinking' && item.status === 'streaming'

export type Segment = { kind: 'item'; item: ChatItem } | { kind: 'group'; items: ChatItem[] } | { kind: 'cards'; items: ChatItem[] }

/**
 * Runs of activity rows with two or more calls fold into one group; narration between them splits them. While the
 * turn runs (`live`), a call still running folds into a group even alone: the live line under the work says what
 * runs now, so it does not show twice.
 */
export function segmentReplies(replies: ChatItem[], live = false): Segment[] {
  const segments: Segment[] = []
  let run: ChatItem[] = []
  let cards: ChatItem[] = []
  const flush = () => {
    if (run.length >= 2 || (live && run.some(isRunningCall))) segments.push({ kind: 'group', items: run })
    else for (const item of run) segments.push({ kind: 'item', item })
    run = []
    // Consecutive subagents form one list, outside any group.
    if (cards.length) segments.push({ kind: 'cards', items: cards })
    cards = []
  }
  for (const item of replies) {
    if (isSubagentItem(item)) {
      if (run.length) flush()
      cards.push(item)
    } else if (isActivity(item)) {
      if (cards.length) flush()
      run.push(item)
    } else {
      flush()
      segments.push({ kind: 'item', item })
    }
  }
  flush()
  return segments
}

/** The latest thought heading in a group, or "". */
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

// ---- Work groups (assistant-blocks.ts workGroupTitle) ----

type WorkKind = 'edit' | 'command' | 'read' | 'search' | 'web' | 'fetch' | 'agent' | 'other' | 'thought'

function workKindOf(item: ChatItem): WorkKind {
  if (item.kind === 'thinking') return 'thought'
  switch (item.tool?.name) {
    case 'Read':
      return 'read'
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit'
    case 'Bash':
      return 'command'
    case 'Grep':
    case 'Glob':
      return 'search'
    case 'WebSearch':
      return 'web'
    case 'WebFetch':
      return 'fetch'
    case 'Task':
    case 'Agent':
      return 'agent'
    default:
      return 'other'
  }
}

/** Which kinds a title names first when a group did more than three kinds of thing: changes before reads. */
const KIND_PRIORITY: WorkKind[] = ['edit', 'command', 'read', 'search', 'web', 'fetch', 'agent', 'other']
const times = (count: number) => (count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`)

function kindPhrase(kind: WorkKind, count: number): string {
  switch (kind) {
    case 'edit':
      return `Edited ${plural(count, 'file')}`
    case 'command':
      return `Ran ${plural(count, 'command')}`
    case 'read':
      return `Read ${plural(count, 'file')}`
    case 'search':
      return `Searched code ${times(count)}`
    case 'web':
      return `Searched the web ${times(count)}`
    case 'fetch':
      return `Fetched ${plural(count, 'page')}`
    case 'agent':
      return `Ran ${plural(count, 'subagent')}`
    default:
      return `Used ${plural(count, 'tool')}`
  }
}

type KindTally = { kind: WorkKind; calls: number; files: Set<string>; first: number; item: ChatItem }

function tallyKinds(items: ChatItem[]): KindTally[] {
  const tallies = new Map<WorkKind, KindTally>()
  items.forEach((item, index) => {
    const kind = workKindOf(item)
    let tally = tallies.get(kind)
    if (!tally) tallies.set(kind, (tally = { kind, calls: 0, files: new Set(), first: index, item }))
    // Reading one file twice counts once.
    const file = kind === 'read' || kind === 'edit' ? filePathOf(item.tool?.input).trim() : ''
    if (file) {
      if (!tally.files.has(file)) tally.calls += 1
      tally.files.add(file)
    } else tally.calls += 1
  })
  return [...tallies.values()]
}

/**
 * What a group of calls did, by kind: "Read 3 files and ran 2 commands". Up to three kinds are named in the order
 * they first ran; with more, the two that changed most are named and the rest counted as other actions. Thoughts
 * are left out; a group of thoughts alone takes its latest thought's line.
 */
export function workGroupTitle(items: ChatItem[]): string {
  const tallies = tallyKinds(items)
  const work = tallies.filter((tally) => tally.kind !== 'thought')
  if (work.length === 0) return groupLabel(items) || (tallies.length ? 'Thought' : '')
  const named = [...work]
    .sort((a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind))
    .slice(0, work.length === 3 ? 3 : 2)
    .sort((a, b) => a.first - b.first)
  const rest = work.filter((tally) => !named.includes(tally)).reduce((sum, tally) => sum + tally.calls, 0)
  const phrases = named.map((tally, index) => {
    const phrase = kindPhrase(tally.kind, tally.calls)
    return index === 0 ? phrase : phrase[0].toLowerCase() + phrase.slice(1)
  })
  if (rest > 0) phrases.push(plural(rest, 'other action'))
  return phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}` : phrases[0]
}

/** The tool whose icon stands for a group: its calls' tool when all are one kind, 'Thinking' for thoughts alone. */
export function workGroupIcon(items: ChatItem[]): string | undefined {
  const tallies = tallyKinds(items)
  const work = tallies.filter((tally) => tally.kind !== 'thought')
  if (work.length === 0) return tallies.length ? 'Thinking' : undefined
  return work.length === 1 ? work[0].item.tool?.name : undefined
}

// ---- Settling and folding a finished turn (assistant-blocks.ts) ----

const isReplyText = (item: ChatItem): boolean => item.role === 'assistant' && item.kind === 'message' && !!item.text.trim() && !item.error

/**
 * A finished turn as it reads once the work is done: its answer, the last reply with text, comes last, and work
 * after it moves above it. A turn cut off by a Stop or a restart (`cutOff`) has no answer: when work followed its
 * last text, that text was written before the work and the turn keeps the order it ran in.
 */
export function settleFinishedTurn(replies: ChatItem[], cutOff = false): ChatItem[] {
  let answer = -1
  for (let index = replies.length - 1; index >= 0; index--) {
    if (isReplyText(replies[index])) {
      answer = index
      break
    }
  }
  if (answer === -1) return replies
  const after = replies.slice(answer + 1)
  if (!after.some(isActivity)) return replies
  if (cutOff) return replies
  return [...replies.slice(0, answer), ...after.filter(isActivity), replies[answer], ...after.filter((item) => !isActivity(item))]
}

/** What `foldTurnWork` knows of one segment of a finished turn. */
export type FoldRow = {
  kind: 'message' | 'tools' | 'cards'
  /** Tool calls and thoughts only. */
  toolsOnly?: boolean
  /** A reply with text (narration, or the answer). */
  text?: boolean
  /** Stays in view whatever the fold: an error, a question, a plan, a notice, a marker, an unrecovered failure. */
  keep?: boolean
  /** A subagent still working. */
  running?: boolean
}

/**
 * Which segments of a finished turn fold behind its "Worked for" line: the work (thoughts, groups, narration,
 * finished subagents), not the answer. The answer is the last reply with text and no work after it; a turn cut off
 * before it wrote one folds all of its work. What needs the person stays in view.
 */
export function foldTurnWork(rows: FoldRow[]): boolean[] {
  let answer = -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.kind === 'tools') break
    if (row.kind === 'cards') continue
    if (row.toolsOnly) break
    if (row.keep) continue
    if (row.text) answer = index
    break
  }
  return rows.map((row, index) => {
    if (row.kind === 'tools') return !row.keep
    if (row.kind === 'cards') return !row.running
    if (row.keep || index === answer) return false
    return !!row.toolsOnly || !!row.text
  })
}

// ---- A thought as it is written (format-tool.ts) ----

const LIVE_THOUGHT_CHARS = 160

/** The latest paragraph of a thought, as plain text on one line. */
export function liveThoughtText(content: string | undefined): string {
  if (!content?.trim()) return ''
  const paragraphs = content.split(/\n\s*\n/).filter((block) => block.trim())
  const latest = paragraphs[paragraphs.length - 1]
    .split('\n')
    .map((line) => line.trim().replace(/^#{1,6}\s+/, '').replace(/^>\s?/, ''))
    .filter(Boolean)
    .join(' ')
  return stripInlineMarkdown(latest).replace(/(\*\*|__)/g, '').replace(/\s+/g, ' ').trim()
}

/** The newest words of a thought being written, starting at a word. */
export function liveThoughtLine(content: string | undefined): string {
  const plain = liveThoughtText(content)
  if (plain.length <= LIVE_THOUGHT_CHARS) return plain
  const tail = plain.slice(plain.length - LIVE_THOUGHT_CHARS)
  const space = tail.indexOf(' ')
  return `…${space > 0 && space < 24 ? tail.slice(space + 1) : tail}`
}

// ---- The live line under Working (turn-progress.tsx) ----

export interface TurnProgress {
  kind: 'starting' | 'thinking' | 'writing' | 'preparing-tool' | 'running-tool' | 'finishing'
  label: string
  /** What the running call works on, shown dim after the label. */
  detail?: string
  /** The running tool: the line shows its icon, pulsing. */
  tool?: string
}

function inputDetail(input: unknown): string | undefined {
  if (!isObject(input)) return undefined
  for (const key of ['command', 'file_path', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      const line = value.trim().split('\n')[0]
      return line.length > 120 ? `${line.slice(0, 117)}…` : line
    }
  }
  return undefined
}

/** Fields a call's row has before its arguments arrive; they say nothing about what it will do. */
const PLACEHOLDER_INPUT_KEYS = new Set(['label', 'cwd'])

function toolProgress(item: ChatItem): TurnProgress {
  const tool = item.tool!
  const detail = inputDetail(tool.input)
  if (isSubagentItem(item)) return { kind: 'running-tool', label: 'Running subagent…', detail }
  const name = tool.name === 'Mcp' ? mcpDisplayName(tool) : tool.name === 'Generic' ? tool.rawName || 'tool' : tool.name
  const noInput = !tool.input || Object.entries(tool.input).every(([key, value]) => PLACEHOLDER_INPUT_KEYS.has(key) || value === undefined || value === null || value === '')
  if (noInput) return { kind: 'preparing-tool', label: `Preparing ${name}…`, tool: tool.name }
  return { kind: 'running-tool', label: `Running ${name}…`, detail, tool: tool.name }
}

/**
 * What a running turn does now, in a few words, for the line under its work. Null where something else already
 * says it: a question waiting, a compaction running, or a thought being written (its row is the live line).
 */
export function describeTurnProgress(replies: ChatItem[], phase: string | undefined, waiting: boolean): TurnProgress | null {
  if (waiting || phase === 'awaiting_input') return null
  const last = replies[replies.length - 1]
  if (last?.kind === 'compaction' && last.status === 'streaming') return null
  // Subagents still starting have no row yet: the line stands for them until each has a name.
  const spawning = replies.filter((item) => isSubagentItem(item) && !subagentStarted(item)).length
  if (spawning) return { kind: 'preparing-tool', label: spawning === 1 ? 'Starting subagent…' : `Starting ${spawning} subagents…` }
  if (last && isRunningCall(last)) return toolProgress(last)
  if (isLiveThought(last)) return null
  for (let index = replies.length - 1; index >= 0; index--) if (isRunningCall(replies[index])) return toolProgress(replies[index])
  switch (phase) {
    case 'streaming':
      return { kind: 'writing', label: 'Writing…' }
    case 'tool_running':
      return { kind: 'running-tool', label: 'Running tools…' }
    case 'finalizing':
      return { kind: 'finishing', label: 'Thinking…' }
    case 'queued':
      return { kind: 'starting', label: 'Thinking…' }
  }
  return replies.length ? { kind: 'thinking', label: 'Thinking…' } : { kind: 'starting', label: 'Thinking…' }
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

export type SubagentState = 'starting' | 'working' | 'done' | 'failed' | 'interrupted'

/**
 * A runtime's own subagent call (Claude Code's Task / Agent) in its state. A call still open after its turn ended was
 * cut off, unless it runs in the background: then it still works, and never flashes done.
 */
export function subagentState(item: ChatItem, turnLive: boolean): SubagentState {
  const state = toolState(item, turnLive)
  if (state === 'error') return 'failed'
  if (state === 'done') return 'done'
  const input = item.tool?.input ?? {}
  if (state === 'interrupted') return input.run_in_background === true ? 'working' : 'interrupted'
  return str(input.description).trim() ? 'working' : 'starting'
}

/** Whether a subagent call has a name to show: until then the turn's live line says "Starting subagent…". */
export const subagentStarted = (item: ChatItem): boolean => !!str(item.tool?.input?.description).trim() || item.status !== 'streaming'

/** How long a finished subagent ran, when its result says. */
export function subagentDuration(tool: ChatToolCall): number | undefined {
  const output = isObject(tool.output) ? tool.output : undefined
  const ms = output?.totalDurationMs ?? output?.durationMs ?? output?.duration_ms
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

/** A subagent's report as Markdown with its line breaks: text blocks join by lines, not run together. */
export function subagentReport(tool: ChatToolCall): string {
  // Claude Code ends a report with the id to resume the agent by; it is not part of what the agent said.
  return rawSubagentReport(tool).replace(/\n*^agentId: \S+ \(for resuming[^)]*\)\s*$/m, '').trim()
}

function rawSubagentReport(tool: ChatToolCall): string {
  const output = tool.output
  if (typeof output === 'string') return output.trim()
  const blocks = Array.isArray(output) ? output : isObject(output) && Array.isArray(output.content) ? output.content : undefined
  if (blocks) {
    const text = blocks
      .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => (block as { text: string }).text.trim())
      .filter(Boolean)
      .join('\n\n')
    if (text) return text
  }
  if (isObject(output)) return (str(output.summary) || str(output.result) || str(output.text)).trim()
  return ''
}

/** A report as one line of plain text: no fences, rules, table dividers, list marks, headings or inline marks. */
export function plainResultText(markdown: string): string {
  const words: string[] = []
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw.trim()
    if (/^(`{3,}|~{3,})/.test(line) || /^([-*_]\s*){3,}$/.test(line) || /^\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?$/.test(line)) continue
    line = line
      .replace(/^(>\s?)+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    if (line.startsWith('|'))
      line = line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(' · ')
    line = stripInlineMarkdown(line).replace(/(\*\*|__)/g, '').trim()
    if (line) words.push(line)
  }
  return words.join(' ').replace(/\s+/g, ' ').trim()
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
