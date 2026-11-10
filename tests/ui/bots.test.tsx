import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { parseBot, parseBotMessage, parseLook, SessionBots } from '../../src/connection/bots'
import { parseLists } from '../../src/connection/lists'
import { mergeLists } from '../../src/ui/sidebar/model'
import { botMessageTime, quoteOf, workElapsed } from '../../src/ui/bots/BotChat'
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

describe('bots on the phone', () => {
  it('lists the bots in the Chats tab and opens a bot’s chat', async () => {
    renderApp({ signedIn: true })
    fireEvent.click(await screen.findByRole('tab', { name: 'Chats' }))
    const roster = await screen.findByRole('region', { name: 'Bots' })
    expect(within(roster).getByRole('button', { name: 'Message Pip' })).toBeInTheDocument()
    expect(screen.getByLabelText('1 unread')).toBeInTheDocument()
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
