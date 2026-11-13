import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { isBotsUnsupported, parseAttachmentPart, plainBotError, parseBot, parseBotMessage, parseDetail, parseLook, parseMemory, SessionBots } from '../../src/connection/bots'
import { parseLists } from '../../src/connection/lists'
import { fromWireError } from '../../src/net/errors'
import { mergeLists } from '../../src/ui/sidebar/model'
import { botMessageTime, pinnedOf, quoteOf, upsertMessages, workElapsed } from '../../src/ui/bots/BotChat'
import { botMessageLabel, placeMessages } from '../../src/ui/bots/messageGroups'
import { botImageSource } from '../../src/ui/bots/BotImages'
import { installMatchMedia, renderApp } from './helpers'

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

describe('bots in the lists', () => {
  it('reads bots from a lists snapshot and treats a missing field as none', () => {
    const lists = parseLists({
      kind: 'mousse.lists', version: 1, projects: [], threads: [], chats: [], status: {},
      bots: [
        { id: 'b1', name: 'Pip', description: 'Sorts mail', look: { colour: 'teal', accessory: 'headphones' }, state: 'needs_you', stateText: 'Wants Gmail', unread: 2, createdAt: '2026-11-01T00:00:00Z', activity: { icon: 'web', text: 'Reading', highlight: 'github.com' } },
        { name: 'No id' },
      ],
    })
    expect(lists?.bots.map((bot) => bot.name)).toEqual(['Pip'])
    expect(lists?.bots[0].activity).toMatchObject({ icon: 'web', highlight: 'github.com' })
    expect(parseLists({ kind: 'mousse.lists', version: 1, projects: [], threads: [], chats: [], status: {} })?.bots).toEqual([])
  })

  it('keeps unknown values safe: an unknown state is idle, an unknown look the default', () => {
    expect(parseBot({ id: 'x', name: 'X', state: 'dancing', look: 7, unread: -3, createdAt: 'now' })).toMatchObject({ state: 'idle', unread: 0 })
    expect(parseLook({ colour: 'teal', accessory: 'cape', kind: 'robot' })).toMatchObject({ colour: 'teal' })
    expect(parseBotMessage({ seq: 1, id: 'm', at: 'now', author: 'bot', kind: 'text', text: 'hi', chips: [{ icon: 'nope', text: 'x' }] })?.chips[0]?.icon).toBeDefined()
  })

  it('gives each merged bot its computer key', () => {
    const lists = parseLists({ kind: 'mousse.lists', version: 1, projects: [], threads: [], chats: [], status: {}, bots: [{ id: 'b1', name: 'Pip', look: {}, state: 'idle', unread: 0, createdAt: 'now' }] })!
    const merged = mergeLists([{ nodeId: 'node-a', lists }])
    expect(merged.bots[0].id).not.toBe('b1')
    expect(merged.bots[0].id).toContain('b1')
  })
})

describe('the bot methods', () => {
  it('names the methods and params the desktop offers phones', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown>; idem: boolean }> = []
    const bots = new SessionBots(async (method, params, options) => {
      calls.push({ method, params, idem: !!options?.idem })
      if (method === 'bots.chat.send') return { message: { seq: 4, id: 'm4', at: 'now', author: 'owner', kind: 'text', text: 'hi', chips: [] } }
      if (method === 'bots.create') return { bot: { id: 'b9', name: 'Nova', look: {}, state: 'idle', unread: 0, createdAt: 'now' } }
      return {}
    })
    await bots.send('b1', '  hi  ', 'm2')
    await bots.markRead('b1', 4)
    await bots.create({ look: { colour: 'teal', accessory: 'none' }, description: ' Watch the nightly ', name: ' ' })
    expect(calls.map((call) => call.method)).toEqual(['bots.chat.send', 'bots.chat.markRead', 'bots.create'])
    expect(calls[0].params).toMatchObject({ botId: 'b1', text: 'hi', replyTo: 'm2' })
    expect(calls[0].params).not.toHaveProperty('attachments')
    expect(calls[2].params).toMatchObject({ description: 'Watch the nightly' })
    expect(calls[2].params).not.toHaveProperty('name')
    expect(calls.every((call) => call.idem)).toBe(true)
  })

  it('says to update Mousse when the computer does not offer bots to phones', async () => {
    const bots = new SessionBots(async () => { throw Object.assign(new Error('forbidden'), { code: 'forbidden' }) })
    await expect(bots.chat('b1')).rejects.toThrow('Update Mousse on this computer')
  })

  it('sends with the caller’s request id, and reads the reminders, memory and images of newer computers', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const bots = new SessionBots(async (method, params) => {
      calls.push({ method, params })
      if (method === 'bots.chat.send') return { message: { seq: 4, id: 'm4', at: 'now', author: 'owner', kind: 'text', text: 'hi', chips: [], clientRequestId: params.clientRequestId } }
      if (method === 'bots.reminders.cancel') return { summary: { id: 'b1', name: 'Pip' }, permissions: [], runs: [], reminders: [] }
      if (method === 'bots.memory.list') return { entries: [{ id: 'm1', text: 'No em dashes', kind: 'owner', status: 'active' }, { id: 'm2', text: null, status: 'forgotten' }], gauge: '' }
      // A 6-byte image in two parts.
      if (method === 'bots.chat.attachment') return params.offset ? { name: 'p.png', mime: 'image/png', size: 6, offset: 3, dataB64: btoa('def') } : { name: 'p.png', mime: 'image/png', size: 6, offset: 0, dataB64: btoa('abc') }
      return {}
    })
    expect((await bots.send('b1', 'hi', undefined, 'req-1')).clientRequestId).toBe('req-1')
    expect(calls[0].params.clientRequestId).toBe('req-1')
    expect((await bots.cancelReminder('b1', 'rem_1')).reminders).toEqual([])
    expect(await bots.memory('b1')).toEqual([{ id: 'm1', text: 'No em dashes', kind: 'owner' }])
    await bots.forgetMemory('b1', 'm1')
    const image = await bots.attachment('b1', 'm4', 1)
    expect(image.mimeType).toBe('image/png')
    expect(new TextDecoder().decode(image.bytes)).toBe('abcdef')
    expect(calls.map((call) => call.method)).toEqual(['bots.chat.send', 'bots.reminders.cancel', 'bots.memory.list', 'bots.memory.forget', 'bots.chat.attachment', 'bots.chat.attachment'])
    expect(calls[1].params).toEqual({ botId: 'b1', reminderId: 'rem_1' })
    expect(calls[4].params).toEqual({ botId: 'b1', messageId: 'm4', index: 1 })
    expect(calls[5].params).toEqual({ botId: 'b1', messageId: 'm4', index: 1, offset: 3 })
  })

  it('says each refusal plainly: the computer sends only its code', async () => {
    // The computer's words never cross the wire: a refusal arrives as "Not permitted." with a code, and maybe a reason.
    const refusal = (code: string, reason?: string) => Object.assign(new Error('Not permitted.'), { code, ...(reason ? { reason } : {}) })
    const failure = await new SessionBots(async () => { throw refusal('forbidden') }).memory('b1').catch((error: unknown) => error)
    expect(isBotsUnsupported(failure)).toBe(true)
    expect(String(plainBotError('bots.chat.list', refusal('forbidden', 'setting_off')))).toContain('doesn’t share its bots')
    expect(isBotsUnsupported(plainBotError('bots.chat.list', refusal('forbidden', 'setting_off')))).toBe(false)
    expect((plainBotError('bots.asks.answer', refusal('forbidden')) as Error).message).toBe('Answer this on the computer.')
    expect((plainBotError('bots.reminders.cancel', refusal('stream_unknown')) as Error).message).toBe('This reminder is gone.')
    expect((plainBotError('bots.get', refusal('stream_unknown')) as Error).message).toBe('This bot is gone.')
    // The sync session carries the reason in the cause chain.
    const wire = fromWireError({ code: 'forbidden', message: 'Not permitted.', retryable: false, cause: [{ code: 'forbidden.setting_off', message: 'Not permitted.' }] })
    expect(wire.reason).toBe('setting_off')
    expect(fromWireError({ code: 'forbidden', message: 'Not permitted.', retryable: false }).reason).toBeUndefined()
    const offline = Object.assign(new Error('The computer is offline.'), { code: 'route_unreachable' })
    expect(plainBotError('bots.get', offline)).toBe(offline)
  })

  it('reads an older computer’s detail without reminders, and only raster images', () => {
    expect(parseDetail({ summary: { id: 'b1' }, permissions: [], runs: [] })).not.toHaveProperty('reminders')
    expect(parseDetail({ summary: { id: 'b1' }, permissions: [], runs: [], reminders: [{ id: 'r', dueAt: 'x', text: 'Pay', work: true }, { id: 'bad' }] })?.reminders).toEqual([{ id: 'r', dueAt: 'x', text: 'Pay', work: true }])
    expect(parseMemory({})).toBeUndefined()
    expect(parseAttachmentPart({ mime: 'image/svg+xml', size: 5, offset: 0, dataB64: 'PHN2Zz4=' })).toBeUndefined()
    expect(parseAttachmentPart({ mime: 'image/png', size: 5, offset: 0, dataB64: '<script>' })).toBeUndefined()
    expect(parseAttachmentPart({ mime: 'image/png', size: 2, offset: 0, dataB64: btoa('abc') })).toBeUndefined()
    expect(parseBotMessage({ seq: 1, id: 'm', author: 'owner', text: '', attachments: [{ name: 'a.png', mime: 'image/png', image: true }, { name: 'b.pdf' }] })?.attachments).toEqual([{ name: 'a.png', mime: 'image/png', image: true }, { name: 'b.pdf' }])
    expect(parseBotMessage({ seq: 1, id: 'm', author: 'owner', text: 'x', clientRequestId: 'r1' })?.clientRequestId).toBe('r1')
  })
})

describe('bot chat helpers', () => {
  it('quotes the first line of a message', () => {
    expect(quoteOf({ seq: 1, id: 'm', at: 'now', author: 'bot', kind: 'text', text: '\n  First line\nSecond', chips: [] })).toEqual({ id: 'm', author: 'bot', text: 'First line' })
  })
  it('says times and elapsed work plainly', () => {
    const now = new Date('2026-11-11T12:00:00')
    expect(botMessageTime('2026-11-10T09:00:00', now)).toBe('Yesterday')
    expect(workElapsed(new Date(now.getTime() - 30_000).toISOString(), now.getTime())).toBe('just now')
    expect(workElapsed(new Date(now.getTime() - 80 * 60_000).toISOString(), now.getTime())).toBe('1 h 20 min')
  })
})

describe('the bot chat’s groups, pins and pictures', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 12, 10, minutes)).toISOString()
  it('groups one sender’s messages within ten minutes, with a day line per day', () => {
    const places = placeMessages([
      { author: 'bot', at: at(0) }, { author: 'bot', at: at(5) }, { author: 'owner', at: at(6) }, { author: 'owner', at: at(30) },
    ], new Date(at(40)))
    expect(places.map((place) => [place.starts, place.ends])).toEqual([[true, false], [false, true], [true, true], [true, true]])
    expect(places[0].day).toBe('Today')
    expect(places[1].day).toBeUndefined()
  })
  it('labels reminders and work reports', () => {
    expect(botMessageLabel({ id: 'bm_rem_1', kind: 'run_report', author: 'bot' })).toBe('Reminder')
    expect(botMessageLabel({ id: 'bm_x', kind: 'run_report', author: 'bot' })).toBe('Work report')
    expect(botMessageLabel({ id: 'bm_x', kind: 'text', author: 'bot' })).toBeUndefined()
  })
  it('pins the newest open ask and the bot’s error, each pointing at its message', () => {
    const messages = [
      { seq: 1, id: 'a', at: at(0), author: 'bot' as const, kind: 'text' as const, text: '', chips: [], ask: { askId: 'k', title: 'read Gmail', note: '', status: 'open' as const } },
      { seq: 2, id: 'e', at: at(1), author: 'bot' as const, kind: 'error' as const, text: '', chips: [], error: { text: 'Gmail sign-in expired' } },
    ]
    expect(pinnedOf(messages, { name: 'Pip', error: { text: 'Gmail sign-in expired' } })).toEqual([
      { kind: 'ask', id: 'a', text: 'Pip wants to read Gmail' },
      { kind: 'error', id: 'e', text: 'Gmail sign-in expired' },
    ])
    expect(pinnedOf([], { name: 'Pip' })).toEqual([])
  })
  it('keeps each message once, in order', () => {
    const one = { seq: 2, id: 'b', at: at(0), author: 'bot' as const, kind: 'text' as const, text: 'old', chips: [] }
    const merged = upsertMessages([one], [{ ...one, text: 'new' }, { ...one, seq: 1, id: 'a' }])
    expect(merged.map((message) => `${message.id}:${message.text}`)).toEqual(['a:old', 'b:new'])
  })
  it('shows only raster data images, and never loads a web image', () => {
    expect(botImageSource('data:image/png;base64,iVBORw0KGgo=').kind).toBe('data')
    expect(botImageSource('data:image/svg+xml;base64,PHN2Zz4=').kind).toBe('blocked')
    expect(botImageSource('https://example.com/a.png').kind).toBe('link')
    expect(botImageSource('/Users/me/a.png').kind).toBe('blocked')
  })
})

describe('bots on the phone', () => {
  it('shows the chat in groups, with labels, pictures and the open ask pinned', async () => {
    // jsdom has no object URLs.
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:picture'), revokeObjectURL: vi.fn() })
    renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'bot', nodeId: 'node-studio', botId: 'bot-inbox' }] })
    expect(await screen.findByText('Reminder')).toBeInTheDocument()
    expect(screen.getAllByRole('separator').map((line) => line.textContent)).toContain('Today')
    // The owner's attached picture is read from the computer; the reply's data image shows inline; the web one is a link.
    expect(await screen.findByRole('button', { name: 'Open image: receipt.png' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open image: Mail this week' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'the bank’s site' })).toBeInTheDocument()
    expect(within(screen.getByRole('status', { name: 'Waiting on you' })).getByRole('button', { name: 'Pip wants to read your Gmail' })).toBeInTheDocument()
    // One face per group: Pip's first two messages share one.
    expect(document.querySelectorAll('.bot-msg--bot.is-group-start').length).toBeLessThan(document.querySelectorAll('.bot-msg--bot').length)
  })

  it('lists reminders and memory in About, each removable', async () => {
    renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'bot', nodeId: 'node-studio', botId: 'bot-inbox' }] })
    fireEvent.click(await screen.findByRole('button', { name: 'About Pip' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel reminder: Pay the electricity bill' }))
    await waitFor(() => expect(screen.queryByText('Pay the electricity bill')).not.toBeInTheDocument())
    fireEvent.click(await screen.findByRole('button', { name: 'Remove memory: No em dashes in summaries.' }))
    await waitFor(() => expect(screen.queryByText('No em dashes in summaries.')).not.toBeInTheDocument())
    expect(screen.getByText('Mail from the bank always needs me.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove search the web' }))
    await waitFor(() => expect(screen.queryByText('Search the web')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Remove every day · 08:00' }))
    expect(await screen.findByText(/Only when you message it/)).toBeInTheDocument()
  })

  it('lists the bots in the Chats tab and opens a bot’s chat', async () => {
    renderApp({ signedIn: true })
    fireEvent.click(await screen.findByRole('tab', { name: 'Chats' }))
    const roster = await screen.findByRole('region', { name: 'Bots' })
    expect(within(roster).getByRole('button', { name: 'Message Pip' })).toBeInTheDocument()
    expect(screen.getAllByLabelText('1 unread').length).toBeGreaterThan(0)
    expect(within(roster).getByLabelText('1 unread')).toBeInTheDocument()
    fireEvent.click(within(roster).getByRole('button', { name: 'Message Pip' }))
    expect(await screen.findByText(/sort your inbox/)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Pip wants to read your Gmail' })).toBeInTheDocument()
  })

  it('sends a message and shows the bot’s reply', async () => {
    renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'bot', nodeId: 'node-studio', botId: 'bot-release' }] })
    const input = await screen.findByPlaceholderText('Message Juno')
    fireEvent.change(input, { target: { value: 'Is Windows slow again?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect([...document.querySelectorAll('.bot-you-bubble')].map((bubble) => bubble.textContent)).toContain('Is Windows slow again?'))
    await waitFor(() => expect(screen.getByText(/I noted/)).toBeInTheDocument(), { timeout: 4000 })
  })

  it('answers an ask from the chat', async () => {
    renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'bot', nodeId: 'node-studio', botId: 'bot-inbox' }] })
    const ask = await screen.findByRole('group', { name: 'Pip wants to read your Gmail' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Allow' }))
    expect(await within(ask).findByText('Allowed')).toBeInTheDocument()
  })

  it('makes a new bot and opens its chat', async () => {
    renderApp({ signedIn: true })
    fireEvent.click(await screen.findByRole('tab', { name: 'Chats' }))
    fireEvent.click(await screen.findByRole('button', { name: 'New bot' }))
    const create = await screen.findByRole('button', { name: 'Create bot' })
    expect(create).toBeDisabled()
    fireEvent.change(screen.getByLabelText('What should it do?'), { target: { value: 'Tell me which PRs wait for me.' } })
    fireEvent.click(create)
    expect(await screen.findByPlaceholderText(/^Message /)).toBeInTheDocument()
  })
})
