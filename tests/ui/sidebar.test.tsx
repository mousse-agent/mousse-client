import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { installMatchMedia, renderApp } from './helpers'
import { chatPreview, mergedKey, mergeLists, projectHue, projectInitials, sidebarModel, splitKey, threadAge } from '../../src/ui/sidebar/model'
import type { ComputerLists } from '../../src/connection/types'

beforeEach(() => installMatchMedia())

const computer = [{ name: 'home' as const }]

describe('thread list', () => {
  it('has Projects, Threads and Chats tabs that all work', async () => {
    renderApp({ signedIn: true, routes: computer })
    const tabs = await screen.findByRole('tablist', { name: 'Sidebar view' })
    const threadsTab = within(tabs).getByRole('tab', { name: 'Threads' })
    expect(threadsTab).toHaveAttribute('aria-selected', 'true')
    // Only the active tab shows its label, as on the desktop.
    expect(threadsTab).toHaveTextContent('Threads')
    expect(within(tabs).getByRole('tab', { name: 'Projects' })).toHaveTextContent('')

    // Threads: flat cards with the desktop's statuses; settled threads are folded away.
    const working = (await screen.findByText('Phone app redesign')).closest('button')!
    expect(working).toHaveTextContent(/Working/)
    expect(screen.getByText('Relay reconnect backoff').closest('button')).toHaveTextContent('Done')
    expect(screen.getByText('Fetch extra Kokoro voices on first use').closest('button')).toHaveTextContent('Waiting')
    expect(screen.queryByText('Swap lucide for Hugeicons')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Settled/ }))
    expect(screen.getByText('Swap lucide for Hugeicons')).toBeInTheDocument()

    // Projects: tap a project to see its threads.
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Projects' }))
    const project = screen.getByRole('button', { name: /^mousse Studio Mac( \d+)?$/ })
    expect(project).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(project)
    expect(project).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Relay reconnect backoff')).toBeInTheDocument()

    // Chats: groups and direct chats; a chat opens in the thread view.
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Chats' }))
    expect(screen.getByText('Release crew')).toBeInTheDocument()
    expect(screen.getByText('Space conversation')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Team space'))
    expect(await screen.findByText(/is a Space conversation/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Reviewer'))
    expect(await screen.findByRole('heading', { name: 'Reviewer' })).toBeInTheDocument()
    expect(screen.getByText('Chat · Studio Mac')).toBeInTheDocument()
  })

  it('goes back to the lists without reconnecting or reloading', async () => {
    renderApp({ signedIn: true, routes: computer, latencyMs: 30 })
    fireEvent.click(await screen.findByText('Landing page copy'))
    expect(await screen.findByRole('heading', { name: 'Landing page copy' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    // Drawn straight from the store: no spinner, no "Connecting".
    expect(screen.getByText('Landing page copy')).toBeInTheDocument()
    expect(screen.queryByText(/Connecting to/)).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /Loading/ })).not.toBeInTheDocument()
  })

  it('updates a thread status live when a reply runs and finishes', async () => {
    renderApp({ signedIn: true, routes: computer })
    fireEvent.click(await screen.findByText('Landing page copy'))
    const field = await screen.findByLabelText('Message')
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading thread' })).not.toBeInTheDocument())
    fireEvent.change(field, { target: { value: 'Tighten the hero copy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Tighten the hero copy')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    const card = () => screen.getByText('Landing page copy').closest('button')!
    await waitFor(() => expect(card()).toHaveTextContent('Working'))
    await waitFor(() => expect(card()).toHaveTextContent('Done'), { timeout: 4000 })
  })
})

describe('sidebar model', () => {
  const lists: ComputerLists = {
    projects: [{ id: 'p', name: 'mousse-client', order: 0, pinned: false }],
    threads: [
      { id: 'b', title: 'Second', projectId: 'p', createdAt: 0, updatedAt: 0, order: 2, pinned: false, settled: false, started: true },
      { id: 'a', title: 'First', projectId: 'p', createdAt: 0, updatedAt: 0, order: 1, pinned: false, settled: false, started: true },
      { id: 'draft', title: 'New thread', createdAt: 0, updatedAt: 0, order: 0, pinned: false, settled: false, started: false },
      { id: 'chat', title: 'Reviewer', createdAt: 0, updatedAt: 0, order: 0, pinned: false, settled: false, started: true },
      { id: 'loose', title: 'Loose', createdAt: 0, updatedAt: 0, order: 3, pinned: false, settled: false, started: true },
    ],
    chats: [{ id: 'c', kind: 'direct', name: 'Reviewer', threadId: 'chat', network: false, agents: ['Reviewer'], updatedAt: 0 }],
    status: {},
    receivedAt: 0,
  }

  it('orders threads like the desktop and hides drafts and chat threads', () => {
    const model = sidebarModel(lists)
    expect(model.threads.map((thread) => thread.id)).toEqual(['a', 'b', 'loose'])
    expect(model.byProject.get('p')!.map((thread) => thread.id)).toEqual(['a', 'b'])
    expect(model.standalone.map((thread) => thread.id)).toEqual(['loose'])
    expect(sidebarModel(lists, 'sec').threads.map((thread) => thread.id)).toEqual(['b'])
  })

  it('formats like the desktop', () => {
    const now = 10 * 86_400_000
    expect(threadAge(now - 10_000, now)).toBe('now')
    expect(threadAge(now - 5 * 60_000, now)).toBe('5m')
    expect(threadAge(now - 30 * 3_600_000, now)).toBe('30h')
    expect(threadAge(now - 3 * 86_400_000, now)).toBe('3d')
    expect(projectInitials('mousse-client')).toBe('MC')
    expect(projectInitials('mousse')).toBe('MO')
    expect(chatPreview({ ...lists.chats[0], run: { id: 'r', state: 'running', startedAt: 0 } })).toBe('Working…')
    expect(chatPreview({ ...lists.chats[0], network: true })).toBe('Space conversation')
    expect(chatPreview(lists.chats[0])).toBe('1 agent')
  })

  it('merges several computers into one list ordered by recent activity, pinned first', () => {
    const other: ComputerLists = {
      projects: [{ id: 'p', name: 'notes', order: 0, pinned: false }],
      threads: [
        { id: 'a', title: 'Newest', projectId: 'p', createdAt: 0, updatedAt: 50, order: 9, pinned: false, settled: false, started: true },
      ],
      chats: [],
      status: { a: { state: 'processing' } },
      receivedAt: 7,
    }
    const dated = { ...lists, threads: lists.threads.map((thread, index) => ({ ...thread, updatedAt: index * 10, pinned: thread.id === 'loose' })) }
    const merged = mergeLists([{ nodeId: 'n1', lists: dated }, { nodeId: 'n2', lists: other }])
    // The same thread id on two computers stays two threads.
    expect(merged.threads.filter((thread) => splitKey(thread.id)?.id === 'a')).toHaveLength(2)
    expect(merged.status[mergedKey('n2', 'a')]).toEqual({ state: 'processing' })
    expect(merged.status[mergedKey('n1', 'a')]).toBeUndefined()
    expect(merged.chats[0].threadId).toBe(mergedKey('n1', 'chat'))
    expect(projectHue(mergedKey('n1', 'p'))).toBe(projectHue('p'))
    const model = sidebarModel(merged, '', 'recent')
    expect(model.threads.map((thread) => thread.id)).toEqual([mergedKey('n1', 'loose'), mergedKey('n2', 'a'), mergedKey('n1', 'a'), mergedKey('n1', 'b')])
    // Each computer's project keeps its own threads in the desktop order.
    expect(model.byProject.get(mergedKey('n1', 'p'))!.map((thread) => splitKey(thread.id)?.id)).toEqual(['a', 'b'])
    expect(merged.projects.map((project) => project.name)).toEqual(['mousse-client', 'notes'])
  })
})
