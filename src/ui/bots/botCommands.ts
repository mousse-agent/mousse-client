// Slash commands in a bot's chat (#1266), ported from mousse/src/renderer/components/bots/botCommands.ts
// and runBotCommand.ts, scoped to the commands the computer's remote bot API supports (/stop, /status,
// /pause, /resume, /memory). Commands that stay on the computer (/clear, /forget, /reset, /model) say so plainly.
import type { BotDetail, BotLaunchedThread, BotWorkItem, ListBot } from '../../connection/bots'

export type BotCommand =
  | { kind: 'stop' | 'status' | 'pause' | 'resume' | 'memory' }
  | { kind: 'desktop_only'; name: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'invalid'; text: string }

export interface BotCommandSuggestion {
  key: string
  label: string
  description: string
  fill: string
}

const COMMANDS: readonly { usage: string; action: string }[] = [
  { usage: '/stop', action: 'Stop all running work' },
  { usage: '/status', action: 'Show work, threads and schedules' },
  { usage: '/pause', action: 'Turn off schedules and wake-ups' },
  { usage: '/resume', action: 'Turn them back on' },
  { usage: '/memory', action: 'Open saved memory' },
]

const PHONE_COMMANDS = new Set(['stop', 'status', 'pause', 'resume', 'memory'])
const DESKTOP_ONLY = new Set(['clear', 'forget', 'reset', 'model'])
const COMMAND_WORD = /^\/([a-z][a-z0-9-]*)(?=\s|$)/i

/** What a message asks for, or null when it is an ordinary message for the bot. */
export function parseBotCommand(text: string): BotCommand | null {
  const trimmed = text.trim()
  const head = COMMAND_WORD.exec(trimmed)
  if (!head) return null
  const name = head[1]!.toLowerCase()
  const rest = trimmed.slice(head[0].length).trim()
  if (PHONE_COMMANDS.has(name)) {
    return rest ? { kind: 'invalid', text: `/${name} takes nothing after it.` } : { kind: name as 'stop' | 'status' | 'pause' | 'resume' | 'memory' }
  }
  if (DESKTOP_ONLY.has(name)) return { kind: 'desktop_only', name }
  return { kind: 'unknown', name }
}

/** Suggestions while a `/` command is typed at the start of the bot composer. */
export function botCommandSuggestions(input: string): BotCommandSuggestion[] {
  if (!input.startsWith('/') || input.includes('\n')) return []
  const typed = input.toLowerCase().replace(/\s+/g, ' ')
  return COMMANDS.filter((row) => row.usage.startsWith(typed)).map((row) => ({
    key: row.usage,
    label: row.usage,
    description: row.action,
    fill: row.usage,
  }))
}

function since(at: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'now'
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

const WORK_STATE: Record<BotWorkItem['status'], string> = { running: '', queued: 'waiting', waiting_for_internet: 'waiting for internet', paused: 'held' }
const THREAD_STATE: Record<BotLaunchedThread['status'], string> = {
  running: 'running',
  queued: 'waiting',
  paused: 'held',
  subagents: 'subagents working',
  needs_input: 'needs you',
  on_hold: 'needs you',
  idle: 'idle',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

/** `/status`: the bot's work, background commands, threads, schedules and reminders, one short line each. */
export function statusText(bot: ListBot | undefined, detail: BotDetail, now = Date.now()): string {
  const summary = detail.summary ?? bot
  const lines: string[] = []
  if (summary?.state === 'paused') lines.push(summary.stateText.startsWith('Paused') ? `${summary.stateText}.` : 'Paused.')
  if (summary?.chat) lines.push('Chat: replying')
  const work = summary?.work ?? []
  lines.push(work.length
    ? `Work: ${work.map((item) => {
      const state = item.status === 'paused' && item.waitsFor === 'answer' ? 'waiting on you' : WORK_STATE[item.status]
      return `${item.title} (${state || since(item.startedAt, now)})`
    }).join(', ')}`
    : 'Work: none')
  const watchers = summary?.watchers ?? []
  if (watchers.length) lines.push(`Background: ${watchers.map((item) => item.title).join(', ')}`)
  const threads = summary?.threads ?? []
  if (threads.length) {
    const shown = threads.slice(0, 5).map((thread) => `${thread.title} (${THREAD_STATE[thread.status]})`)
    lines.push(`Threads: ${shown.join(', ')}${threads.length > 5 ? ` +${threads.length - 5}` : ''}`)
  }
  const schedules = detail.runs.filter((run) => run.kind === 'schedule')
  lines.push(schedules.length ? `Schedules: ${schedules.map((run) => `${run.label}${run.paused ? ' (off)' : ''}`).join(', ')}` : 'Schedules: none')
  const reminders = detail.reminders ?? []
  if (reminders.length) lines.push(`Reminders: ${reminders.length} waiting`)
  return lines.join('\n')
}
