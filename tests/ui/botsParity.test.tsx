import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMatchMedia } from './helpers'
import {
  botActionRefusal,
  botActionRefusalText,
  parseBot,
  parseBotMessage,
  parseDetail,
  SessionBots,
  type BotChatMessage,
  type BotDetail,
  type BotMemoryItem,
  type ComputerBots,
  type ListBot,
} from '../../src/connection/bots'
import type { ComputerLists } from '../../src/connection/types'
import { BotAboutSheet } from '../../src/ui/bots/BotAboutSheet'
import { BotActionCard } from '../../src/ui/bots/BotActionCard'
import { BotAskReplies } from '../../src/ui/bots/BotAskReplies'
import { BotCards } from '../../src/ui/bots/BotCards'
import { BotChat } from '../../src/ui/bots/BotChat'
import { BotHeader } from '../../src/ui/bots/BotHeader'
import { BotMemorySheet } from '../../src/ui/bots/BotMemorySheet'
import { BotMenuSheet } from '../../src/ui/bots/BotMenuSheet'
import { BotPresenceSheet } from '../../src/ui/bots/BotPresenceSheet'
import { BotQuestionReplies } from '../../src/ui/bots/BotQuestionReplies'
import { BotReminderReplies } from '../../src/ui/bots/BotReminderReplies'
import { BotSteps } from '../../src/ui/bots/BotSteps'
import { BotTasksButton, BotTasksSheet } from '../../src/ui/bots/BotTasksSheet'
import { BotThreadHeader } from '../../src/ui/bots/BotThreadHeader'
import { Mascot, mascotEyeOffset } from '../../src/ui/bots/Mascot'
import { botRowLine, chatRows, presenceOf } from '../../src/ui/bots/botChatShape'
import { parseBotCommand, statusText } from '../../src/ui/bots/botCommands'
import { botMessageFrom } from '../../src/ui/bots/botMessages'
import { botRetryOf } from '../../src/ui/bots/botRetry'
import { shuffleLook } from '../../src/ui/bots/face/BotLookPicker'
import { BOT_EYES, BOT_KINDS, botEyesOf, botKindOf, DEFAULT_BOT_LOOK } from '../../src/ui/bots/look'
import { Sidebar } from '../../src/ui/sidebar/Sidebar'

const EMPTY_LISTS: ComputerLists = { status: {}, receivedAt: 0, projects: [], threads: [], chats: [], bots: [] }

function stubBot(overrides: Partial<ListBot> = {}): ListBot {
  return {
    id: 'bot-1',
    name: 'Pip',
    description: 'Sorts your inbox.',
    look: { kind: 'blob', colour: 'amber', eyes: 'round', accessory: 'none' },
    state: 'idle',
    stateText: '',
    unread: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

function stubMessage(overrides: Partial<BotChatMessage> = {}): BotChatMessage {
  return {
    seq: 1,
    id: 'm1',
    at: '2026-11-12T10:00:00.000Z',
    author: 'bot',
    kind: 'text',
    text: 'Hello',
    chips: [],
    ...overrides,
  }
}

function stubBots(overrides: Partial<ComputerBots> = {}): ComputerBots {
  return {
    chat: vi.fn(async () => ({ messages: [] })),
    send: vi.fn(async (_botId, text) => stubMessage({ seq: 99, id: 'sent-1', author: 'owner', text })),
    stop: vi.fn(async () => undefined),
    stopWork: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    answer: vi.fn(async () => stubMessage()),
    answerAction: vi.fn(async () => null),
    answerQuestion: vi.fn(async (_botId, questionId, choice) => ({
      message: stubMessage({ seq: 50, id: 'ans-1', author: 'owner', text: choice, answers: { questionId, tapped: true } }),
    })),
    snoozeReminder: vi.fn(async (_botId, messageId) => stubMessage({
      id: messageId,
      reminder: { snoozedUntil: '2026-11-12T11:00:00.000Z' },
    })),
    get: vi.fn(async (): Promise<BotDetail> => ({
      summary: stubBot(),
      permissions: [],
      runs: [],
      reminders: [],
    })),
    cancelReminder: vi.fn(async () => ({ summary: stubBot(), permissions: [], runs: [], reminders: [] })),
    memory: vi.fn(async () => []),
    forgetMemory: vi.fn(async () => undefined),
    editMemory: vi.fn(async (_botId, id, text): Promise<BotMemoryItem> => ({ id, kind: 'owner', text })),
    attachment: vi.fn(async () => ({ mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) })),
    removeSchedule: vi.fn(async () => ({ summary: stubBot(), permissions: [], runs: [], reminders: [] })),
    setPermission: vi.fn(async () => ({ summary: stubBot(), permissions: [], runs: [], reminders: [] })),
    revokePermission: vi.fn(async () => ({ summary: stubBot(), permissions: [], runs: [], reminders: [] })),
    pause: vi.fn(async () => stubBot({ state: 'paused', stateText: 'Paused' })),
    resume: vi.fn(async () => stubBot({ state: 'idle', stateText: '' })),
    create: vi.fn(async () => stubBot()),
    update: vi.fn(async (_botId, patch) => stubBot({ name: patch.name ?? 'Pip', look: patch.look ?? DEFAULT_BOT_LOOK })),
    ...overrides,
  }
}

function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() { return entries.size },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
    clear: () => entries.clear(),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  installMatchMedia()
})
afterEach(() => vi.unstubAllGlobals())

describe('connection bot protocol parsing and RPC wiring', () => {
  it('parses rich bot summary, detail, action, question, cards, reminder and memory fields', () => {
    const bot = parseBot({
      id: 'b1',
      name: 'Pip',
      createdAt: '2026-11-01T00:00:00.000Z',
      look: { kind: 'cat', colour: 'rose', eyes: 'happy', eyeColour: 'sage', accessory: 'hat' },
      state: 'working',
      stateText: 'Checking mail',
      needsOwner: true,
      lastReply: 'All caught up.',
      tasks: [{ id: 't1', text: 'Read bills', status: 'in_progress' }, { id: 't2', text: 'Draft reply', status: 'completed' }],
      watchers: [{ id: 'w1', title: 'Wait for CI', command: 'gh run watch', startedAt: '2026-11-12T09:40:00.000Z', until: 'done' }],
      threads: [{ threadId: 'th-1', title: 'CI fix', status: 'running', startedAt: '2026-11-12T09:40:00.000Z', updatedAt: '2026-11-12T09:55:00.000Z' }],
    })
    expect(bot?.look.eyeColour).toBe('sage')
    expect(bot?.needsOwner).toBe(true)
    expect(bot?.lastReply).toBe('All caught up.')
    expect(bot?.tasks).toHaveLength(2)
    expect(bot?.watchers?.[0]?.title).toBe('Wait for CI')
    expect(bot?.threads?.[0]?.threadId).toBe('th-1')

    const msg = parseBotMessage({
      seq: 7,
      id: 'm7',
      at: '2026-11-12T10:00:00.000Z',
      author: 'bot',
      kind: 'text',
      text: 'Summary\nFallback text',
      plainFrom: 7,
      reaction: '👍',
      chips: [{ icon: 'think', text: 'started CI fix', thread: 'th-1', said: 'Check tests', title: 'Opus' }],
      action: {
        actionId: 'a1',
        digest: 'd1',
        title: 'Send email',
        serverName: 'Gmail',
        args: { to: 'sam@example.com' },
        hasHiddenValues: true,
        hiddenPaths: [['headers', 'auth']],
        status: 'open',
        previous: { status: 'failed', at: '2026-11-12T09:59:00.000Z' },
      },
      question: {
        questionId: 'q1',
        choices: [{ label: 'Flat A', detail: 'Near park' }, { label: 'Flat B' }],
        status: 'open',
        defaultLabel: 'Flat A',
      },
      reminder: { expiresAt: '2026-11-12T12:00:00.000Z' },
      cards: [
        { type: 'facts', title: 'Invoice', rows: [{ label: 'Total', value: '$42' }] },
        { type: 'progress', done: 2, total: 4, label: 'Halfway' },
      ],
    })
    expect(msg?.plainFrom).toBe(7)
    expect(msg?.reaction).toBe('👍')
    expect(msg?.chips[0]?.thread).toBe('th-1')
    expect(msg?.action?.previous?.status).toBe('failed')
    expect(msg?.question?.choices[0]?.detail).toBe('Near park')
    expect(msg?.reminder?.expiresAt).toBe('2026-11-12T12:00:00.000Z')
    expect(msg?.cards).toHaveLength(2)

    const detail = parseDetail({
      summary: { id: 'b1', name: 'Pip', state: 'idle', createdAt: '2026-11-01T00:00:00.000Z' },
      permissions: [{ id: 'p1', title: 'search the web', note: '', grantedAt: '2026-11-01T00:00:00.000Z', enabled: true, builtIn: true, under: 'Web' }],
      runs: [{ id: 'r1', label: 'every day · 08:00', kind: 'schedule', name: 'Morning sweep', lastOutcome: 'ok' }],
      reminders: [{ id: 'rem1', text: 'Check PR', dueAt: '2026-11-12T12:00:00.000Z', wake: 'checks PR' }],
      context: { used: 10_000, window: 100_000, lastRequestAt: 1000, cacheTtlMs: 300_000, turn: { cacheRead: 8000, cacheWrite: 1000, fresh: 1000 } },
      usage: { turns: 5, inputPerTurn: 9000, outputPerTurn: 400, cachedShare: 0.8 },
    })
    expect(detail?.permissions[0]?.enabled).toBe(true)
    expect(detail?.permissions[0]?.builtIn).toBe(true)
    expect(detail?.runs[0]?.name).toBe('Morning sweep')
    expect(detail?.reminders?.[0]?.wake).toBe('checks PR')
    expect(detail?.context?.used).toBe(10_000)
    expect(detail?.usage?.turns).toBe(5)
  })

  it('wires new remote RPC methods and parses action refusals', async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'bots.actions.answer') throw { code: 'conflict', reason: 'bot_action_changed' }
      if (method === 'bots.questions.answer') return { message: stubMessage({ id: 'o1', author: 'owner', text: 'Yes' }) }
      if (method === 'bots.reminders.snooze') return stubMessage({ id: 'r1', reminder: { snoozedUntil: '2026-11-12T11:00:00.000Z' } })
      if (method === 'bots.update') return { bot: stubBot({ name: String(params?.name ?? 'Pip') }) }
      if (method === 'bots.permissions.set') {
        return {
          summary: stubBot(),
          permissions: [{ id: 'p1', title: 'web', note: '', grantedAt: '2026-11-01T00:00:00.000Z', enabled: false }],
          runs: [],
          reminders: [],
        }
      }
      if (method === 'bots.memory.edit') return { entry: { id: 'm1', ref: 'm1v2', kind: 'owner', text: 'Updated' } }
      return {}
    })
    const api = new SessionBots(request)

    const refusal = await api.answerAction('b1', 'a1', 'd1', 'send', { botName: 'Pip', serverName: 'Gmail' })
    expect(refusal?.reason).toBe('bot_action_changed')
    expect(refusal?.text).toContain('This changed since you saw it')
    expect(botActionRefusal({ code: 'bot_action_paused' }, { botName: 'Pip' })?.text).toContain('Resume Pip')
    expect(botActionRefusalText('bot_action_unreachable', { serverName: 'Gmail' })).toContain('Gmail')

    await api.answerQuestion('b1', 'q1', 'Yes', 'req-1')
    expect(request).toHaveBeenCalledWith(
      'bots.questions.answer',
      { botId: 'b1', questionId: 'q1', choice: 'Yes', clientRequestId: 'req-1' },
      expect.objectContaining({ idem: expect.any(String) }),
    )

    await api.snoozeReminder('b1', 'r1', '10m')
    expect(request).toHaveBeenCalledWith(
      'bots.reminders.snooze',
      { botId: 'b1', messageId: 'r1', choice: '10m' },
      expect.objectContaining({ idem: expect.any(String) }),
    )

    const updatedBot = await api.update('b1', { name: 'Pippa' })
    expect(updatedBot.name).toBe('Pippa')

    const updatedDetail = await api.setPermission('b1', 'p1', false)
    expect(updatedDetail.permissions[0]?.enabled).toBe(false)

    const edited = await api.editMemory('b1', 'm1v1', 'Updated')
    expect(edited?.text).toBe('Updated')
  })
})

describe('mascot (#1579) and shuffle look (#1609)', () => {
  it('renders the mascot, cheers on tap, and clamps eye tracking offsets', () => {
    render(<Mascot />)
    const root = screen.getByRole('button')
    expect(root).toHaveAttribute('data-state', 'idle')
    fireEvent.click(root)
    expect(root).toHaveAttribute('data-state', 'happy')

    const box = { left: 100, top: 100, width: 100, height: 100 }
    const farRight = mascotEyeOffset(box, 1000, 150)
    expect(farRight.x).toBeGreaterThan(2)
    expect(Math.hypot(farRight.x, farRight.y)).toBeLessThanOrEqual(4.1)
    const center = mascotEyeOffset(box, 150, 150)
    expect(center).toEqual({ x: 0, y: 0 })
  })

  it('shuffles character kind and eyes as well as colour and accessory', () => {
    const kinds = new Set<string>()
    const eyes = new Set<string>()
    for (let i = 0; i < 120; i += 1) {
      const next = shuffleLook(DEFAULT_BOT_LOOK)
      kinds.add(botKindOf(next))
      eyes.add(botEyesOf(next))
    }
    expect(kinds.size).toBeGreaterThan(1)
    expect(eyes.size).toBeGreaterThan(1)
    for (const k of kinds) expect(BOT_KINDS).toContain(k)
    for (const e of eyes) expect(BOT_EYES).toContain(e)
  })
})

describe('sidebar bots list (#1404, #915, #1579)', () => {
  it('shows empty mascot when there are no bots or chats', () => {
    render(
      <Sidebar
        lists={EMPTY_LISTS}
        tab="chats"
        order="recent"
        onOpenThread={vi.fn()}
        onOpenChat={vi.fn()}
        onOpenBot={vi.fn()}
        onNewBot={vi.fn()}
        canMakeBots
      />,
    )
    expect(screen.getByText('Make your first bot')).toBeInTheDocument()
    expect(document.querySelector('.bot-mascot')).not.toBeNull()
  })

  it('lists bots as rows with sleeping idle faces, active tint, unread dot, and foldable sections', () => {
    const activeBot = stubBot({ id: 'b-active', name: 'Pip', state: 'working', stateText: 'Checking mail', unread: 2 })
    const idleBot = stubBot({
      id: 'b-idle',
      name: 'Juno',
      state: 'idle',
      stateText: '',
      unread: 1,
      lastReply: 'CI is green.',
    })
    render(
      <Sidebar
        lists={{ ...EMPTY_LISTS, bots: [idleBot, activeBot] }}
        tab="chats"
        order="recent"
        selectedBotId="b-active"
        onOpenThread={vi.fn()}
        onOpenChat={vi.fn()}
        onOpenBot={vi.fn()}
      />,
    )
    const roster = screen.getByRole('region', { name: 'Bots' })
    const pipRow = within(roster).getByRole('button', { name: 'Message Pip' })
    const junoRow = within(roster).getByRole('button', { name: 'Message Juno' })

    expect(pipRow).toHaveClass('is-active')
    expect(pipRow).toHaveAttribute('aria-current', 'true')
    expect(within(pipRow).queryByLabelText('2 unread')).not.toBeInTheDocument()

    expect(junoRow.querySelector('.bot-row-dot')).not.toBeNull()
    expect(within(junoRow).getByLabelText('1 unread')).toBeInTheDocument()
    expect(within(junoRow).getByText('CI is green.')).toBeInTheDocument()
    expect(junoRow.querySelector('.bot-row-face.is-resting')).not.toBeNull()

    // Section folds and unfolds, persisting to localStorage.
    const foldBtn = screen.getByRole('button', { name: /Bots/i })
    expect(foldBtn).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(foldBtn)
    expect(foldBtn).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Message Pip' })).not.toBeInTheDocument()
    expect(localStorage.getItem('mousse.sidebar.chatsCollapsed')).toContain('"bots":true')
  })

  it('derives row state text and presence cleanly', () => {
    expect(botRowLine(stubBot({ state: 'paused', stateText: 'Paused' })).text).toBe('Paused')
    expect(botRowLine(stubBot({ state: 'working', stateText: 'Drafting notes' })).tone).toBe('working')
    expect(botRowLine(stubBot({ needsOwner: true, stateText: 'Waiting for you' })).tone).toBe('needs')
    expect(presenceOf(stubBot({ state: 'idle' }), { typing: false, offline: false }).kind).toBe('free')
  })
})

describe('held action cards (#1390, #1556, #1545), quick replies, cards and steps', () => {
  it('renders a held action card with masked args, previous notice, and refusal text', async () => {
    const onAnswer = vi.fn(async () => ({ reason: 'bot_action_changed', text: 'This changed since you saw it.' }))
    render(
      <BotActionCard
        botName="Pip"
        onAnswer={onAnswer}
        card={{
          actionId: 'a1',
          digest: 'd1',
          title: 'Send email',
          serverName: 'Gmail',
          args: { to: 'sam@example.com', body: 'Hello \u202Eworld' },
          hasHiddenValues: true,
          hiddenPaths: [['headers', 'token']],
          status: 'open',
          previous: { status: 'failed', at: '2026-11-12T09:58:00.000Z' },
        }}
      />,
    )
    expect(screen.getByText('Send email')).toBeInTheDocument()
    expect(screen.getByText(/Gmail/)).toBeInTheDocument()
    expect(screen.getByText(/already tried exactly this/i)).toBeInTheDocument()
    expect(screen.getByText(/Hidden values will be sent/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onAnswer).toHaveBeenCalledWith('send')
    expect(await screen.findByRole('status')).toHaveTextContent('This changed since you saw it.')
  })

  it('disables Send on tooLarge actions with a computer-only note', () => {
    render(
      <BotActionCard
        botName="Pip"
        onAnswer={vi.fn(async () => null)}
        card={{
          actionId: 'a2',
          digest: 'd2',
          title: 'Upload archive',
          serverName: 'Drive',
          args: null,
          hasHiddenValues: false,
          hiddenPaths: [],
          status: 'open',
          tooLarge: true,
        }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByText(/too large/i)).toBeInTheDocument()
  })

  it('handles BotAskReplies details toggle and refusal', async () => {
    const onAnswer = vi.fn(async () => 'Allow this on the computer.')
    render(
      <BotAskReplies
        botName="Pip"
        onAnswer={onAnswer}
        ask={{
          askId: 'ask1',
          title: 'use Terminal',
          note: 'Needs shell access.',
          details: { summary: 'Commands', items: ['npm test'] },
          status: 'open',
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Needs shell access.')).toBeInTheDocument()
    expect(screen.getByText('Commands: npm test')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(await screen.findByRole('note')).toHaveTextContent('Allow this on the computer.')
  })

  it('handles BotQuestionReplies tap, Other… and settled states', () => {
    const onAnswer = vi.fn(async () => true)
    const onOther = vi.fn()
    const { rerender } = render(
      <BotQuestionReplies
        onAnswer={onAnswer}
        onOther={onOther}
        question={{
          questionId: 'q1',
          choices: [{ label: 'Morning', detail: '08:00' }, { label: 'Evening' }],
          other: true,
          status: 'open',
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Other…' }))
    expect(onOther).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Morning/ }))
    expect(onAnswer).toHaveBeenCalledWith('Morning')

    rerender(
      <BotQuestionReplies
        onAnswer={onAnswer}
        onOther={onOther}
        question={{ questionId: 'q1', choices: [{ label: 'Morning' }], other: false, status: 'defaulted', answer: 'Morning' }}
      />,
    )
    expect(screen.getByText('No answer · went with Morning')).toBeInTheDocument()
  })

  it('handles BotReminderReplies snooze choices and snoozed display', () => {
    const onSnooze = vi.fn(async () => true)
    const future = new Date(Date.now() + 60 * 60_000).toISOString()
    const { rerender } = render(
      <BotReminderReplies reminder={{ expiresAt: future }} onSnooze={onSnooze} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'In 10 min' }))
    expect(onSnooze).toHaveBeenCalledWith('10m')

    rerender(<BotReminderReplies reminder={{ snoozedUntil: future }} onSnooze={onSnooze} />)
    expect(screen.getByRole('note')).toHaveTextContent(/Snoozed until/)
  })

  it('renders BotCards (facts, checklist, progress, watcher, automation) and BotSteps open thread', () => {
    const onStopWatcher = vi.fn(async () => undefined)
    const onOpenAbout = vi.fn()
    const onOpenThread = vi.fn()
    render(
      <>
        <BotCards
          bots={stubBots()}
          botId="b1"
          messageId="m1"
          watchers={[{ id: 'w1', title: 'Wait for deploy', command: 'gh run watch', startedAt: '2026-11-12T10:00:00.000Z', until: 'done' }]}
          runs={[{ id: 'r1', jobId: 'j1', kind: 'schedule', label: 'every day · 08:00', name: 'Daily digest' }]}
          onStopWatcher={onStopWatcher}
          onOpenAbout={onOpenAbout}
          cards={[
            { type: 'facts', title: 'Status', rows: [{ label: 'Build', value: 'Green' }] },
            { type: 'checklist', title: 'Ship', items: [{ text: 'Tests', state: 'done' }, { text: 'Tag', state: 'todo' }] },
            { type: 'progress', done: 3, total: 5, label: '3 of 5' },
            { type: 'watcher', watcherId: 'w1', title: 'Wait for deploy', command: 'gh run watch' },
            { type: 'automation', jobId: 'j1', name: 'Daily digest', label: 'every day · 08:00' },
          ]}
        />
        <BotSteps chips={[{ icon: 'think', text: 'started Deploy fix', thread: 'th-9', said: 'Investigate' }]} onOpenThread={onOpenThread} />
      </>,
    )
    expect(screen.getByText('Green')).toBeInTheDocument()
    expect(screen.getByText('Tests')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3')
    fireEvent.click(screen.getByRole('button', { name: 'Stop Wait for deploy' }))
    expect(onStopWatcher).toHaveBeenCalledWith('w1')
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(onOpenAbout).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenThread).toHaveBeenCalledWith('th-9')
  })
})

describe('BotChat parity: inter-bot bubbles (#1543), working dots (#1275), retry (#1630), slash commands (#1266), find', () => {
  it('parses inter-bot headers, retry payload, and slash commands', () => {
    const interBot = stubMessage({
      id: 'bm_botmsg_bot_juno_12345678-1234-1234-1234-1234567890ab',
      text: '**Message from your bot Juno**\n\n> The release is ready.',
    })
    expect(botMessageFrom(interBot)).toEqual({ name: 'Juno', botId: 'bot_juno', message: 'The release is ready.' })

    const ownerMsg = stubMessage({ seq: 1, id: 'o1', author: 'owner', text: 'Check PR 42', activationId: 'act-retry' })
    const failMsg = stubMessage({ seq: 2, id: 'e1', author: 'bot', kind: 'error', text: '', activationId: 'act-retry', error: { text: 'Timed out' } })
    expect(botRetryOf([ownerMsg, failMsg], failMsg)).toEqual({ text: 'Check PR 42' })

    expect(parseBotCommand('/status')).toEqual({ kind: 'status' })
    expect(parseBotCommand('/clear')).toEqual({ kind: 'desktop_only', name: 'clear' })
    expect(parseBotCommand('/nope')).toEqual({ kind: 'unknown', name: 'nope' })
    expect(statusText(stubBot({ state: 'idle' }), { summary: stubBot({ state: 'idle' }), permissions: [], runs: [], reminders: [] })).toContain('Work: none')
  })

  it('renders inter-bot bubble, typing dots, retry button, slash commands and Find in chat', async () => {
    const juno = stubBot({ id: 'bot_juno', name: 'Juno', look: { kind: 'cat', colour: 'sage', eyes: 'round', accessory: 'none' } })
    const pip = stubBot({
      id: 'bot_pip',
      name: 'Pip',
      state: 'working',
      chat: { activationId: 'act-1' },
      activity: { icon: 'read', text: 'Reading your inbox' },
    })
    const send = vi.fn(async (_botId: string, text: string) => stubMessage({ seq: 20, id: 'o20', author: 'owner', text }))
    const pause = vi.fn(async () => ({ ...pip, state: 'paused' as const, stateText: 'Paused' }))
    const onOpenMemory = vi.fn()
    const messages: BotChatMessage[] = [
      stubMessage({ seq: 1, id: 'm1', author: 'owner', text: 'Summarize bills', activationId: 'act-fail' }),
      stubMessage({
        seq: 2,
        id: 'bm_botmsg_bot_juno_12345678-1234-1234-1234-1234567890ab',
        author: 'bot',
        text: '**Message from your bot Juno**\n\n> Electricity bill is paid.',
      }),
      stubMessage({ seq: 3, id: 'm3', author: 'bot', kind: 'error', text: '', activationId: 'act-fail', error: { text: 'The provider timed out.' } }),
    ]
    const bots = stubBots({
      chat: vi.fn(async () => ({ messages })),
      send,
      pause,
    })

    const { rerender } = render(
      <BotChat
        bot={pip}
        allBots={[pip, juno]}
        bots={bots}
        findSignal={0}
        onOpenMemory={onOpenMemory}
      />,
    )

    // Inter-bot bubble renders sender's name & text.
    expect(await screen.findByText('Electricity bill is paid.')).toBeInTheDocument()
    expect(screen.getByText('Juno')).toBeInTheDocument()

    // Working dots show live activity (#1275).
    expect(screen.getByText('Reading your inbox')).toBeInTheDocument()

    // Failed turn shows Retry button and resends the owner's prompt (#1630).
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('bot_pip', 'Summarize bills', undefined, expect.any(String)))

    // Slash commands execute locally or show computer-only note (#1266).
    const input = screen.getByPlaceholderText('Message Pip')
    fireEvent.change(input, { target: { value: '/pause' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    expect(await screen.findByText(/Paused: schedules and wake-ups are off/)).toBeInTheDocument()
    expect(pause).toHaveBeenCalledWith('bot_pip')

    fireEvent.change(input, { target: { value: '/memory' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    await waitFor(() => expect(onOpenMemory).toHaveBeenCalled())

    fireEvent.change(input, { target: { value: '/clear' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    expect(await screen.findByText(/\/clear runs on the computer/)).toBeInTheDocument()

    // Find in chat searches transcript messages.
    rerender(
      <BotChat
        bot={pip}
        allBots={[pip, juno]}
        bots={bots}
        findSignal={1}
        onOpenMemory={onOpenMemory}
      />,
    )
    const search = screen.getByRole('searchbox', { name: 'Find in chat' })
    fireEvent.change(search, { target: { value: 'Electricity' } })
    expect(await screen.findByText('1/1')).toBeInTheDocument()
  })

  it('folds expired schedule action reviews into a collapsed details row', () => {
    const expired = stubMessage({
      seq: 1,
      id: 'exp1',
      expiredActionSchedule: 'sched-1',
      action: {
        actionId: 'a1',
        digest: 'd1',
        title: 'Post update',
        serverName: 'Slack',
        args: { channel: '#ops' },
        hasHiddenValues: false,
        hiddenPaths: [],
        status: 'expired',
        at: '2026-11-12T10:05:00.000Z',
      },
    })
    const { rows } = chatRows([expired], 'Pip')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('system')
    if (rows[0]?.kind === 'system') {
      expect(rows[0].expiredReviews).toHaveLength(1)
    }
  })
})

describe('sheets and chrome: About (#1140), Memory, Presence, Tasks, Menu, Header, ThreadHeader', () => {
  it('toggles per-permission switches, hides Remove on built-in permissions, and shows Context & cache', async () => {
    const setPermission = vi.fn(async (): Promise<BotDetail> => ({
      summary: stubBot(),
      permissions: [
        { id: 'p-builtin', title: 'search the web', note: '', grantedAt: '2026-11-01T00:00:00.000Z', enabled: false, builtIn: true },
        { id: 'p-extra', title: 'read Gmail', note: '', grantedAt: '2026-11-01T00:00:00.000Z', enabled: true, under: 'Gmail' },
      ],
      runs: [],
      reminders: [],
      context: { used: 25_000, window: 100_000, lastRequestAt: Date.now() - 10_000, cacheTtlMs: 300_000, turn: { cacheRead: 20_000, cacheWrite: 2000, fresh: 3000 } },
      usage: { turns: 4, inputPerTurn: 10_000, outputPerTurn: 500, cachedShare: 0.75 },
    }))
    const bots = stubBots({
      get: vi.fn(async (): Promise<BotDetail> => ({
        summary: stubBot(),
        permissions: [
          { id: 'p-builtin', title: 'search the web', note: '', grantedAt: '2026-11-01T00:00:00.000Z', enabled: true, builtIn: true },
          { id: 'p-extra', title: 'read Gmail', note: '', grantedAt: '2026-11-01T00:00:00.000Z', enabled: true, under: 'Gmail' },
        ],
        runs: [],
        reminders: [],
        context: { used: 25_000, window: 100_000, lastRequestAt: Date.now() - 10_000, cacheTtlMs: 300_000, turn: { cacheRead: 20_000, cacheWrite: 2000, fresh: 3000 } },
        usage: { turns: 4, inputPerTurn: 10_000, outputPerTurn: 500, cachedShare: 0.75 },
      })),
      setPermission,
    })

    render(<BotAboutSheet open bot={stubBot()} bots={bots} onClose={vi.fn()} onError={vi.fn()} onOpenMemory={vi.fn()} />)
    const webSwitch = await screen.findByRole('switch', { name: 'search the web' })
    expect(webSwitch).toHaveAttribute('aria-checked', 'true')
    // Built-in permission has no Remove button; extra permission does.
    expect(screen.queryByRole('button', { name: 'Remove search the web' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove read Gmail' })).toBeInTheDocument()

    fireEvent.click(webSwitch)
    await waitFor(() => expect(setPermission).toHaveBeenCalledWith('bot-1', 'p-builtin', false))

    // Open Context and cache fold.
    fireEvent.click(screen.getByRole('button', { name: /Context and cache/i }))
    expect(screen.getByTestId('bot-about-context')).toHaveTextContent('25%')
    expect(screen.getByTestId('bot-about-usage')).toHaveTextContent('75% cached')
  })

  it('searches, edits, forgets and asks about entries in BotMemorySheet', async () => {
    const editMemory = vi.fn(async (_botId: string, _id: string, text: string): Promise<BotMemoryItem> => ({
      id: 'mem-1',
      ref: 'mem-1v2',
      kind: 'owner',
      text,
    }))
    const onAskAbout = vi.fn()
    const bots = stubBots({
      memory: vi.fn(async () => [
        { id: 'mem-1', ref: 'mem-1v1', kind: 'owner', text: 'Keep summaries short.', learnedAt: '2026-11-10T09:00:00.000Z' },
        { id: 'mem-2', kind: 'note', text: 'Bank emails arrive on Fridays.' },
      ]),
      editMemory,
    })

    render(<BotMemorySheet open bot={stubBot()} bots={bots} onClose={vi.fn()} onAskAbout={onAskAbout} />)
    expect(await screen.findByText('Keep summaries short.')).toBeInTheDocument()
    expect(screen.getByText('Bank emails arrive on Fridays.')).toBeInTheDocument()

    // Edit entry inline.
    const wishRow = screen.getByText('Keep summaries short.').closest('li')!
    fireEvent.click(within(wishRow).getByRole('button', { name: 'Edit' }))
    fireEvent.change(within(wishRow).getByLabelText('Memory text'), { target: { value: 'Keep summaries under 3 lines.' } })
    fireEvent.click(within(wishRow).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(editMemory).toHaveBeenCalledWith('bot-1', 'mem-1v1', 'Keep summaries under 3 lines.'))
    expect(await screen.findByText('Keep summaries under 3 lines.')).toBeInTheDocument()

    // Ask Pip about an entry.
    const noteRow = screen.getByText('Bank emails arrive on Fridays.').closest('li')!
    fireEvent.click(within(noteRow).getByRole('button', { name: 'Ask Pip' }))
    expect(onAskAbout).toHaveBeenCalledWith('Bank emails arrive on Fridays.')
  })

  it('renders Presence, Tasks, Menu, Header and ThreadHeader sheets/controls', async () => {
    const onOpenThread = vi.fn()
    const onStopWork = vi.fn()
    const onBackToBot = vi.fn()
    const update = vi.fn(async (_botId: string, patch: { name?: string }) => stubBot({ name: patch.name ?? 'Pip' }))
    const bots = stubBots({ update })
    const busyBot = stubBot({
      state: 'working',
      work: [{ id: 'wk-1', title: 'Audit inbox', status: 'running', startedAt: '2026-11-12T09:50:00.000Z' }],
      threads: [{ threadId: 'th-42', title: 'Fix billing', status: 'running', startedAt: '2026-11-12T09:50:00.000Z', updatedAt: '2026-11-12T09:55:00.000Z' }],
      tasks: [{ id: 't1', text: 'Read bills', status: 'completed' }, { id: 't2', text: 'Reply to Sam', status: 'in_progress' }],
    })

    render(
      <>
        <BotHeader
          bot={busyBot}
          name={busyBot.name}
          onAbout={vi.fn()}
          onPresence={vi.fn()}
          onTasks={vi.fn()}
          trailing={<button type="button">Menu</button>}
        />
        <BotTasksButton botId={busyBot.id} tasks={busyBot.tasks} onOpen={vi.fn()} />
        <BotPresenceSheet open bot={busyBot} onClose={vi.fn()} onStopWork={onStopWork} onOpenThread={onOpenThread} />
        <BotTasksSheet open botName="Pip" tasks={busyBot.tasks} onClose={vi.fn()} />
        <BotMenuSheet open bot={busyBot} bots={bots} onClose={vi.fn()} onAbout={vi.fn()} onFind={vi.fn()} />
        <BotThreadHeader bot={busyBot} onBackToBot={onBackToBot} />
      </>,
    )

    expect(screen.getAllByRole('button', { name: 'Checklist, 1 of 2 done' }).length).toBeGreaterThan(0)
    expect(screen.getByText('Reply to Sam')).toBeInTheDocument()

    // Presence sheet opens thread and stops running work.
    fireEvent.click(screen.getByRole('button', { name: /Fix billing/ }))
    expect(onOpenThread).toHaveBeenCalledWith('th-42')
    fireEvent.click(screen.getByRole('button', { name: 'Stop Audit inbox' }))
    expect(onStopWork).toHaveBeenCalledWith('wk-1')

    // Menu sheet renames bot via bots.update.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: 'Pippa' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('bot-1', { name: 'Pippa' }))

    // BotThreadHeader navigates back to the bot.
    fireEvent.click(screen.getByRole('button', { name: /Back to Pip/i }))
    expect(onBackToBot).toHaveBeenCalled()
  })
})
