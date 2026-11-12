import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Computer, ComputerLists } from '../../src/connection/types'
import type { FakeMousseConnection } from '../../src/ui/dev/fakeConnection'
import { defaultComputer, defaultProject, offersModel } from '../../src/ui/lib/newThread'
import { loadProjectChoice } from '../../src/ui/lib/composerPrefs'
import { installMatchMedia, renderApp } from './helpers'

/** A working localStorage: Node's own global hides jsdom's when it has no storage file. */
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

const ACCOUNT = 'acct-demo@mousse.dev'

/** What this phone saved from Travel laptop the last time it was online. */
function saveLaptopLists(updatedAt: number): void {
  const lists: ComputerLists = {
    projects: [{ id: 'p-notes', name: 'notes', order: 0, pinned: false }],
    threads: [{ id: 't-hotel', title: 'Hotel wifi notes', projectId: 'p-notes', createdAt: updatedAt, updatedAt, order: 0, pinned: false, settled: false, started: true }],
    chats: [],
    bots: [],
    status: {},
    receivedAt: updatedAt,
  }
  localStorage.setItem(`mousse.lists.v1:${ACCOUNT}:node-laptop`, JSON.stringify(lists))
}

const cards = () => [...document.querySelectorAll('.m-sb-card')] as HTMLElement[]
const titles = () => cards().map((card) => card.querySelector('.m-sb-card__title')?.textContent)

describe('one thread list', () => {
  it('lists the threads of every computer by recent activity, each with its computer', async () => {
    // Newer than every Studio Mac thread except the pinned ones.
    saveLaptopLists(Date.now() - 60_000)
    renderApp({ signedIn: true })
    expect(await screen.findByText('Phone app redesign')).toBeInTheDocument()
    expect(titles().slice(0, 4)).toEqual(['Phone app redesign', 'Relay reconnect backoff', 'Hotel wifi notes', 'Fetch extra Kokoro voices on first use'])

    const studio = screen.getByText('Phone app redesign').closest('button')!
    expect(within(studio).getByText('Studio Mac')).toBeInTheDocument()
    expect(studio.querySelector('.m-sb-computer')).toHaveAttribute('data-state', 'online')

    // Travel laptop is offline: its threads stay listed from the saved lists, marked offline.
    const laptop = screen.getByText('Hotel wifi notes').closest('button')!
    expect(within(laptop).getByText('Travel laptop')).toBeInTheDocument()
    expect(within(laptop).getByText('offline')).toBeInTheDocument()
    expect(screen.getByText('Travel laptop is offline. Showing saved lists.')).toBeInTheDocument()
  })

  it('opens a thread on its own computer', async () => {
    renderApp({ signedIn: true })
    fireEvent.click(await screen.findByText('Landing page copy'))
    expect(await screen.findByRole('heading', { name: 'Landing page copy' })).toBeInTheDocument()
    // The header says where the thread is: its project, then its computer.
    expect(screen.getByText('website · Studio Mac')).toBeInTheDocument()
    expect(await screen.findByLabelText('Message')).toBeInTheDocument()
  })

  it('keeps projects and search working across computers', async () => {
    saveLaptopLists(Date.now() - 60_000)
    renderApp({ signedIn: true })
    await screen.findByText('Phone app redesign')
    fireEvent.change(screen.getByPlaceholderText('Search threads'), { target: { value: 'wifi' } })
    expect(titles()).toEqual(['Hotel wifi notes'])
    fireEvent.change(screen.getByPlaceholderText('Search threads'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }))
    expect(screen.getByRole('button', { name: /^notes Travel laptop offline/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^website Studio Mac/ })).toBeInTheDocument()
  })
})

describe('new thread', () => {
  it('starts on the computer that adds devices, and sends there like the per-computer flow', async () => {
    const { connection } = renderApp({ signedIn: true })
    await screen.findByText('Phone app redesign')
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
    expect(await screen.findByRole('heading', { name: 'New thread' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Computer: Studio Mac' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Project: mousse' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Project: mousse' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Project on Studio Mac' })).getByText('website'))
    expect(screen.getByRole('button', { name: 'Project: website' })).toBeInTheDocument()

    const field = screen.getByLabelText('Message')
    await waitFor(() => expect(field).not.toBeDisabled())
    fireEvent.change(field, { target: { value: 'Write the launch post' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Write the launch post')).toBeInTheDocument()
    const sent = (connection as FakeMousseConnection).lastSession!.sent
    expect(sent).toContainEqual(expect.objectContaining({ kind: 'send', threadId: expect.stringMatching(/^t-new-/), text: 'Write the launch post' }))

    // The next new thread starts where this one went.
    expect(localStorage.getItem('mousse.newThread.computer')).toBe('node-studio')
    expect(localStorage.getItem('mousse.newThread.project.node-studio')).toBe('p-site')
  })

  it('looks like the desktop start page and starts the thread with the picked model and a worktree', async () => {
    const { connection } = renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'new', nodeId: 'node-studio' }] })
    // The desktop's start page: the outline logo and its title over the composer, no orb.
    expect(await screen.findByRole('heading', { name: 'What should we build?' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Mousse' })).toBeInTheDocument()
    expect(document.querySelector('.liquid-orb')).toBeNull()
    expect(screen.getByRole('group', { name: 'New thread workspace' })).toBeInTheDocument()

    // The model is picked before the thread exists, in the same picker as a thread's.
    fireEvent.click(await screen.findByRole('button', { name: 'Model: Opus 4.8 High' }))
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Models' })).getByRole('menuitemradio', { name: 'GPT 5.5, OpenAI' }))
    expect(await screen.findByRole('button', { name: 'Model: GPT 5.5 High' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Project: mousse' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Start in a worktree' }))
    expect(screen.getByRole('button', { name: 'Start in a worktree' })).toHaveAttribute('aria-pressed', 'true')

    const field = screen.getByLabelText('Message')
    await waitFor(() => expect(field).not.toBeDisabled())
    fireEvent.change(field, { target: { value: 'Tidy the build script' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Tidy the build script')).toBeInTheDocument()
    const session = (connection as FakeMousseConnection).lastSession!
    expect(session.created).toEqual([{ projectId: 'p-mousse', worktreeEnabled: true }])
    const threadId = session.sent[0].threadId
    expect((await session.getThread(threadId)).model).toEqual({ instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:high' })
  })

  it('starts the next new thread in a project with the model and worktree last picked there', async () => {
    localStorage.setItem('mousse.newThread.choice.node-studio.p-mousse', JSON.stringify({ model: { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:high' }, worktree: true }))
    const { connection } = renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'new', nodeId: 'node-studio', projectId: 'p-mousse' }] })
    expect(await screen.findByRole('button', { name: 'Model: GPT 5.5 High' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start in a worktree' })).toHaveAttribute('aria-pressed', 'true')

    const field = screen.getByLabelText('Message')
    await waitFor(() => expect(field).not.toBeDisabled())
    fireEvent.change(field, { target: { value: 'Same again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Same again')).toBeInTheDocument()
    const session = (connection as FakeMousseConnection).lastSession!
    expect(session.created).toEqual([{ projectId: 'p-mousse', worktreeEnabled: true }])
    expect((await session.getThread(session.sent[0].threadId)).model).toEqual({ instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:high' })
  })

  it('remembers the model and worktree picked for a project, and drops a remembered model the computer no longer offers', async () => {
    renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'new', nodeId: 'node-studio', projectId: 'p-mousse' }] })
    fireEvent.click(await screen.findByRole('button', { name: 'Model: Opus 4.8 High' }))
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Models' })).getByRole('menuitemradio', { name: 'GPT 5.5, OpenAI' }))
    const field = screen.getByLabelText('Message')
    await waitFor(() => expect(field).not.toBeDisabled())
    fireEvent.change(field, { target: { value: 'Remember this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Remember this')).toBeInTheDocument()
    expect(loadProjectChoice('node-studio', 'p-mousse')).toEqual({ worktree: false, model: { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:high' } })

    expect(offersModel([{ id: 'openai', instanceId: 'pi:openai', label: 'OpenAI', models: [{ id: 'gpt-5.5', label: 'GPT 5.5' }] }], { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:high' })).toBe(true)
    expect(offersModel([{ id: 'openai', instanceId: 'pi:openai', label: 'OpenAI', models: [{ id: 'gpt-5.4', label: 'GPT 5.4' }] }], { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:high' })).toBe(false)
    expect(offersModel([{ id: 'openai', instanceId: 'pi:other', label: 'OpenAI', models: [{ id: 'gpt-5.5', label: 'GPT 5.5' }] }], { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5' })).toBe(false)
  })

  it('offers the user’s computers in its computer menu', async () => {
    renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'new' }] })
    fireEvent.click(await screen.findByRole('button', { name: 'Computer: Studio Mac' }))
    const menu = await screen.findByRole('dialog', { name: 'Run on' })
    expect(within(menu).getByText('Studio Mac')).toBeInTheDocument()
    expect(within(menu).getByText('Travel laptop')).toBeInTheDocument()
    // Linux workstation never added this phone: it cannot run a thread from here.
    expect(within(menu).queryByText('Linux workstation')).not.toBeInTheDocument()
    fireEvent.click(within(menu).getByText('Travel laptop'))
    expect(await screen.findByRole('button', { name: 'Computer: Travel laptop' })).toBeInTheDocument()
  })
})

describe('the default computer of a new thread', () => {
  const computer = (nodeId: string, extra: Partial<Computer> = {}): Computer => ({ nodeId, name: nodeId, kind: 'computer', online: true, enrolled: true, ...extra })
  const list = [
    computer('a', { online: false }),
    computer('b', { authority: true, online: false }),
    computer('c'),
    computer('d', { enrolled: false }),
    { ...computer('phone'), kind: 'phone' as const },
  ]

  it('is the last used, else the authority, else the first online, else the first', () => {
    expect(defaultComputer(list, 'c')?.nodeId).toBe('c')
    expect(defaultComputer(list, 'gone')?.nodeId).toBe('b')
    expect(defaultComputer(list, 'd')?.nodeId).toBe('b')
    expect(defaultComputer(list.filter((entry) => entry.nodeId !== 'b'))?.nodeId).toBe('c')
    expect(defaultComputer([computer('a', { online: false }), computer('z', { online: false })])?.nodeId).toBe('a')
    expect(defaultComputer([list[3], list[4]])).toBeUndefined()
  })

  it('picks the project asked for, else the last used, else the first', () => {
    const projects = [{ id: 'p2', name: 'b', order: 1, pinned: false }, { id: 'p1', name: 'a', order: 0, pinned: false }]
    expect(defaultProject(projects, 'p2', 'p1')).toBe('p2')
    expect(defaultProject(projects, undefined, 'p2')).toBe('p2')
    expect(defaultProject(projects, 'gone', 'gone')).toBe('p1')
    expect(defaultProject(projects, undefined, '')).toBe('')
    expect(defaultProject([], undefined, undefined)).toBe('')
  })
})
