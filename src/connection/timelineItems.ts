// Maps the desktop's ChatMessage rows into the phone's ChatItems the same way the desktop's
// renderer adapter does (mousse/src/renderer/chat/adapters/mousseToUI.ts): tool names are
// normalized, composer markers are lifted out of user text, consecutive thoughts merge and
// repeated assistant text folds. Everything here reads untrusted JSON from the computer.
import { publishedAppletParts, streamingAppletParts } from './applets'
import type {
  ChatImage,
  ChatItem,
  ChatItemKind,
  ChatPart,
  ChatReference,
  ChatResponseMeta,
  ChatToolCall,
  PendingQuestion,
  PendingQuestions,
} from './types'
import type { DesktopMessage } from './threadProjection'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const TOOL_KINDS = new Set(['thinking', 'tool_call', 'mcp_tool_call', 'mcp_tool_result', 'skill_loaded', 'build_tool_call', 'build_tool_result'])

/** Same mapping as the desktop's normalizeToolName. */
export function normalizeToolName(rawName: string | undefined, kind?: string): string {
  const lower = (rawName ?? '').toLowerCase().replace(/[^a-z]/g, '')
  switch (lower) {
    case 'read':
    case 'readfile':
      return 'Read'
    case 'edit':
    case 'notebookedit':
    case 'declarefiles':
      return 'Edit'
    case 'write':
      return 'Write'
    case 'bash':
    case 'bashoutput':
    case 'killshell':
      return 'Bash'
    case 'grep':
      return 'Grep'
    case 'glob':
    case 'find':
    case 'ls':
    case 'listdir':
      return 'Glob'
    case 'todo':
    case 'todowrite':
      return 'TodoWrite'
    case 'plan':
    case 'planwrite':
    case 'presentplan':
    case 'exitplanmode':
      return rawName === 'ExitPlanMode' ? 'ExitPlanMode' : 'PlanWrite'
    case 'websearch':
      return 'WebSearch'
    case 'webfetch':
      return 'WebFetch'
    case 'skill':
    case 'loadskill':
    case 'listskills':
      return 'Skill'
    case 'agent':
      return 'Agent'
    case 'task':
      return 'Task'
    case 'question':
      return 'Question'
    case 'createquickaction':
      return 'QuickAction'
    case 'thinking':
      return 'Thinking'
    case 'cloning':
      return 'cloning'
    default:
      if (!rawName) return kind === 'mcp_tool_call' || kind === 'mcp_tool_result' ? 'Mcp' : 'Generic'
      if (/^[A-Z][A-Za-z]*$/.test(rawName)) return rawName
      return rawName.charAt(0).toUpperCase() + rawName.slice(1)
  }
}

const RICH_TOOLS = new Set([
  'Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'TodoWrite', 'PlanWrite', 'ExitPlanMode',
  'WebSearch', 'WebFetch', 'Skill', 'Task', 'Agent', 'Question', 'Thinking', 'cloning', 'QuickAction',
])

function fallbackToolName(title: string, details: string[]): string | undefined {
  const named = details.find((line) => line.startsWith('Tool:'))?.replace('Tool:', '').trim().split(/\s+/)[0]
  if (named) return named
  const lower = title.toLowerCase()
  if (lower.includes('read')) return 'Read'
  if (lower.includes('edit')) return 'Edit'
  if (lower.includes('write') && !lower.includes('plan')) return 'Write'
  if (lower.includes('bash') || lower.includes('command') || lower.includes('terminal')) return 'Bash'
  if (lower.includes('grep')) return 'Grep'
  if (lower.includes('glob') || lower.includes('exploring files')) return 'Glob'
  if (lower.includes('todo')) return 'TodoWrite'
  if (lower.includes('quickaction') || lower.includes('quick action')) return 'QuickAction'
  if (lower.includes('plan')) return 'PlanWrite'
  if (lower.includes('search') || lower.includes('webfetch') || lower.includes('fetch')) return 'WebSearch'
  if (lower.includes('skill')) return 'Skill'
  if (lower.includes('agent') || lower.includes('spawning')) return 'Agent'
  if (lower.includes('task')) return 'Task'
  return undefined
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.parse(trimmed)
  } catch {
    return text
  }
}

function toolCall(message: DesktopMessage, kind: string): ChatToolCall | undefined {
  const raw = message.toolCall
  if (!isObject(raw)) return undefined
  const title = str(raw.title)
  const summary = str(raw.summary)
  const details = Array.isArray(raw.details) ? raw.details.filter((line): line is string => typeof line === 'string') : []
  const rawName = str(raw.toolName) || fallbackToolName(title, details)
  let name = normalizeToolName(rawName, kind)
  const server = details.find((line) => line.startsWith('Server:'))?.replace('Server:', '').trim().split(/\s+/)[0] || undefined
  // MCP rows are MCP cards unless they carry a rich tool without a server (Pi/build tools).
  if ((kind === 'mcp_tool_call' || kind === 'mcp_tool_result') && (server || !RICH_TOOLS.has(name))) name = 'Mcp'
  const response = str(raw.response)
  const structured = isObject(raw.input) ? raw.input : parseJsonObject(response)
  let input: Record<string, unknown> = structured ? { ...structured } : {}
  if (!structured) {
    const detail = (prefix: string) => details.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim()
    if (name === 'Bash') input = { command: detail('Command:') ?? '' }
    else if (name === 'Read' || name === 'Edit' || name === 'Write')
      input = { file_path: detail('File:') ?? summary.match(/[^\s]+\.[a-z]{1,4}/i)?.[0] ?? '' }
    else if (name === 'Grep' || name === 'Glob' || name === 'WebSearch') input = { pattern: summary, query: summary }
  }
  // A running call's response is its arguments, never its output.
  const argsOnly = !!structured && raw.status === 'processing'
  const output = argsOnly || !response ? undefined : parseJson(response)
  return {
    name,
    ...(rawName ? { rawName } : {}),
    ...(server ? { server } : {}),
    title,
    summary,
    details,
    input,
    ...(output !== undefined ? { output } : {}),
  }
}

// ---- User message markers (mousse/src/renderer/utils/messageAttachments.ts) ----

const REFERENCE_BLOCK = /\n?\[Mousse references data="([^"]+)"\]\n[\s\S]*?\n\[\/Mousse references\]\s*/g
const BROWSER_BLOCK = /\[Selected browser element\]\n([\s\S]*?)\n\[\/Selected browser element\]/g
const REFERENCE_KINDS = new Set(['file', 'project', 'thread', 'terminal', 'browser', 'agent'])

function cleanField(value: unknown, max = 4096): string | undefined {
  if (typeof value !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return clean && clean.length <= max ? clean : undefined
}

/** Lifts references, attached-file markers, voice markers and browser element blocks out of user text. */
export function parseUserContent(content: string): { text: string; files: string[]; references: ChatReference[] } {
  const references: ChatReference[] = []
  const files: string[] = []
  let text = content.replace(REFERENCE_BLOCK, (_block, encoded: string) => {
    try {
      const values: unknown = JSON.parse(decodeURIComponent(encoded))
      if (Array.isArray(values))
        for (const value of values.slice(0, 100)) {
          if (!isObject(value) || !REFERENCE_KINDS.has(value.kind as string)) continue
          const title = cleanField(value.title, 512)
          if (!title) continue
          const path = cleanField(value.path)
          const url = cleanField(value.url)
          references.push({ kind: value.kind as string, title, ...(path ? { path } : {}), ...(url ? { url } : {}) })
        }
    } catch {
      // Malformed reference data stays hidden.
    }
    return '\n'
  })
  text = text.replace(/\[Attached files: ([^\]]+)\]/g, (_match, list: string) => {
    for (const name of list.split(', ')) if (name.trim()) files.push(name.trim())
    return ''
  })
  text = text.replace(/\[(?:Voice message \([^)]+\)(?:, )?)+\]/g, '')
  text = text.replace(BROWSER_BLOCK, (_match, body: string) => {
    const line = (prefix: string) => body.split('\n').find((entry) => entry.startsWith(prefix))?.slice(prefix.length)
    const label = line('Text: ')?.trim() || line('Accessible label: ')?.trim() || line('Element: ')?.match(/^<[^>\s]+>/)?.[0] || 'element'
    const url = cleanField(line('URL: '))
    references.push({ kind: 'browser', title: label.slice(0, 80), ...(url ? { url } : {}) })
    return ''
  })
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), files, references }
}

function imagesOf(value: unknown): ChatImage[] {
  if (!Array.isArray(value)) return []
  const out: ChatImage[] = []
  for (const entry of value.slice(0, 32)) {
    if (!isObject(entry)) continue
    const mimeType = str(entry.mimeType)
    if (!/^image\/(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(mimeType)) continue
    const data = str(entry.data)
    out.push({ name: str(entry.name) || 'image', mimeType, ...(data && /^[A-Za-z0-9+/=_-]+$/.test(data) ? { data } : {}) })
  }
  return out
}

function metaOf(value: unknown): ChatResponseMeta | undefined {
  if (!isObject(value)) return undefined
  const meta: ChatResponseMeta = {}
  if (str(value.modelName)) meta.modelName = str(value.modelName)
  if (finite(value.totalResponseTimeMs) !== undefined) meta.totalResponseTimeMs = finite(value.totalResponseTimeMs)
  if (finite(value.tokensUsed) !== undefined) meta.tokensUsed = finite(value.tokensUsed)
  if (finite(value.tokensPerSecond) !== undefined) meta.tokensPerSecond = finite(value.tokensPerSecond)
  return Object.keys(meta).length ? meta : undefined
}

function errorOf(value: unknown): { message: string; code?: string } | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return { message: value }
  if (isObject(value)) {
    const message = str(value.message) || 'The computer reported an error.'
    return { message, ...(str(value.code) ? { code: str(value.code) } : {}) }
  }
  return { message: 'The computer reported an error.' }
}

const modelLabel = (value: unknown): string =>
  isObject(value) ? [str(value.provider), str(value.model)].filter(Boolean).join(' / ') : ''

/** One desktop message as a phone item, following the desktop adapter. Hidden or empty rows map to nothing. */
export function toChatItem(message: DesktopMessage): ChatItem | undefined {
  if (message.hidden) return undefined
  const kind = str(message.kind)
  const createdAt = Date.parse(message.timestamp)
  const base = {
    id: message.id,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    ...(str(message.turnId) ? { turnId: str(message.turnId) } : {}),
    ...(message.incomplete === true ? { incomplete: true } : {}),
  }
  const error = errorOf(message.error)
  const streaming = message.streaming === true

  if (kind === 'thinking' && isObject(message.thinking)) {
    const text = str(message.thinking.content)
    const pending = message.thinking.status === 'processing' || streaming
    return { ...base, role: 'assistant', kind: 'thinking', text, status: pending ? 'streaming' : 'done' }
  }

  if (kind === 'plan_card' && isObject(message.planCard)) {
    const request = str(message.planCard.originalRequest).trim() || 'Implementation plan'
    const markdown = str(message.planCard.planMarkdown).trim() || message.content.trim() || 'No plan generated.'
    const title = request.length > 90 ? `${request.slice(0, 87)}…` : request
    return {
      ...base,
      role: 'assistant',
      kind: 'plan',
      text: markdown,
      plan: { title, markdown, request },
      status: streaming ? 'streaming' : 'done',
    }
  }

  if (TOOL_KINDS.has(kind) || (!kind && isObject(message.toolCall))) {
    const tool = toolCall(message, kind)
    if (tool) {
      const raw = message.toolCall!
      const failed = /returned an error/i.test(tool.summary) || raw.status === 'error' || raw.status === 'failed'
      const running = raw.status === 'processing' || raw.status === 'running' || raw.status === 'pending' || streaming
      return {
        ...base,
        role: 'tool',
        kind: 'tool',
        text: [tool.title, tool.summary].filter((part) => part.trim()).join('\n'),
        toolName: tool.name,
        tool,
        status: failed ? 'error' : running ? 'streaming' : 'done',
      }
    }
  }

  if (kind === 'context_handoff' && isObject(message.contextHandoff)) {
    return {
      ...base,
      role: 'system',
      kind: 'handoff',
      text: message.content,
      handoff: { from: modelLabel(message.contextHandoff.from), to: modelLabel(message.contextHandoff.to) },
      status: 'done',
    }
  }

  if (kind === 'progress' || kind === 'warning' || kind === 'context_compaction') {
    const itemKind: ChatItemKind = kind === 'context_compaction' ? 'compaction' : kind
    if (!message.content.trim() && itemKind !== 'compaction') return undefined
    return { ...base, role: 'system', kind: itemKind, text: message.content, status: streaming ? 'streaming' : 'done' }
  }

  // Plain user / assistant / system text.
  if (message.role === 'assistant' && streaming && !message.content.trim() && !error) return undefined
  let text = message.content
  let files: string[] = []
  let references: ChatReference[] = []
  const images = imagesOf(message.images)
  if (message.role === 'user' && text.includes('[')) {
    const parsed = parseUserContent(text)
    text = parsed.text
    const imageNames = new Set(images.map((image) => image.name))
    files = parsed.files.filter((name) => !imageNames.has(name))
    references = parsed.references
  }
  let parts: ChatPart[] | undefined
  if (message.role === 'assistant') {
    text = text.replace(/(?:[ \t]*\r?\n)*[ \t]*\(Stopped\)\s*$/u, '')
    // Like the desktop: applets run only once the reply is finished and the computer published them.
    parts = streaming ? (text.includes('mousse-applet') ? streamingAppletParts(text) : undefined) : publishedAppletParts(message.content, message.presentationParts)
    if (parts && !parts.some((part) => part.type !== 'text')) parts = undefined
    if (parts) text = parts.map((part) => (part.type === 'text' ? part.text : '')).join('').replace(/\n{3,}/g, '\n\n').trim()
  }
  if (!text.trim() && !parts && !images.length && !files.length && !references.length && !error) return undefined
  const meta = message.role === 'assistant' ? metaOf(message.responseMetadata) : undefined
  return {
    ...base,
    role: message.role,
    kind: 'message',
    text,
    status: error ? 'error' : streaming ? 'streaming' : 'done',
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
    ...(references.length ? { references } : {}),
    ...(error ? { error } : {}),
    ...(meta ? { meta } : {}),
    ...(parts ? { parts } : {}),
  }
}

/**
 * Merges back-to-back thoughts into one row (the latest segment owns the live state) and folds an
 * assistant text that exactly repeats the one before it, like the desktop.
 */
export function foldItems(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = []
  for (const item of items) {
    const previous = out[out.length - 1]
    if (previous?.kind === 'thinking' && item.kind === 'thinking') {
      out[out.length - 1] = {
        ...previous,
        text: [previous.text, item.text].filter((part) => part.trim()).join('\n\n'),
        status: item.status,
      }
      continue
    }
    if (
      previous &&
      item.role === 'assistant' &&
      previous.role === 'assistant' &&
      item.kind === 'message' &&
      previous.kind === 'message' &&
      item.status === 'done' &&
      previous.status === 'done' &&
      !item.images &&
      item.text.trim() &&
      item.text.trim() === previous.text.trim()
    )
      continue
    out.push(item)
  }
  return out
}

function questionOf(value: unknown): PendingQuestion | undefined {
  if (!isObject(value) || !str(value.id) || !Array.isArray(value.options)) return undefined
  const options = value.options
    .filter(isObject)
    .map((option) => ({ id: str(option.id), label: str(option.label) || str(option.id) }))
    .filter((option) => option.id)
  return { id: str(value.id), prompt: str(value.prompt), options, ...(value.allowMultiple === true ? { allowMultiple: true } : {}) }
}

/** Reads the desktop's `PendingUserQuestions[]` for one thread. */
export function pendingQuestionsOf(value: unknown, threadId: string): PendingQuestions[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: PendingQuestions[] = []
  for (const entry of value) {
    if (!isObject(entry) || !str(entry.requestId) || !Array.isArray(entry.questions)) continue
    if (entry.threadId !== undefined && entry.threadId !== threadId) continue
    const questions = entry.questions.map(questionOf).filter((question): question is PendingQuestion => !!question)
    if (questions.length) out.push({ requestId: str(entry.requestId), questions })
  }
  return out
}
