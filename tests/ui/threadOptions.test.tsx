import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ComputerLists } from '../../src/connection/types'
import type { FakeMousseConnection, FakeSession } from '../../src/ui/dev/fakeConnection'
import { LONG_PRESS_MS } from '../../src/ui/hooks/useLongPress'
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

/** jsdom has no PointerEvent: a MouseEvent that carries what the hold reads (where, which finger, what kind). */
class TestPointerEvent extends MouseEvent {
  readonly pointerType: string
  readonly isPrimary: boolean
  readonly pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? 'mouse'
    this.isPrimary = init.isPrimary ?? true
    this.pointerId = init.pointerId ?? 1
  }
}

beforeEach(() => {
  if (typeof window.PointerEvent === 'undefined') vi.stubGlobal('PointerEvent', TestPointerEvent)
  vi.stubGlobal('localStorage', memoryStorage())
  installMatchMedia()
})
afterEach(() => vi.unstubAllGlobals())

/** The app on the demo computers, and the demo connection to inspect what each computer was asked. */
const renderFake = () => renderApp({ signedIn: true }).connection as FakeMousseConnection

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

/** The card of a thread in the Threads tab, by title (and computer, when two computers list the same title). */
function card(title: string, computer?: string): HTMLElement {
  const all = [...document.querySelectorAll('.m-sb-card')] as HTMLElement[]
  const found = all.find((element) => element.querySelector('.m-sb-card__title')?.textContent === title && (!computer || element.textContent?.includes(computer)))
  if (!found) throw new Error(`no card ${title}`)
  return found
}

/** Presses and holds like a finger: down, rest, then lift and the click a lift makes. */
async function hold(element: HTMLElement) {
  fireEvent.pointerDown(element, { pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
  await wait(LONG_PRESS_MS + 60)
  fireEvent.pointerUp(element, { pointerType: 'touch', isPrimary: true })
  // As in Chrome, the click of the lift lands on what is under the finger now: the sheet's backdrop once it opened.
  fireEvent.click(document.querySelector('.m-sheet') ?? element)
}

const sheet = () => screen.queryByRole('dialog')
const option = (name: string | RegExp) => within(screen.getByRole('dialog')).getByRole('menuitem', { name })

async function studio(connection: FakeMousseConnection): Promise<FakeSession> {
  await waitFor(() => expect(connection.sessions.get('node-studio')).toBeDefined())
  return connection.sessions.get('node-studio')!
}

describe('pressing and holding a thread', () => {
  it('opens its options, titled with its name, and the lift does not open the thread', async () => {
    renderApp({ signedIn: true })
    await screen.findByText('Landing page copy')
    await hold(card('Landing page copy'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Landing page copy' })).toBeInTheDocument()
    expect(within(dialog).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Pin', 'Archive', 'Regenerate title', 'Rename', 'Delete after'])
    // Still on the list: the thread did not open under the sheet.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Threads' })).toBeInTheDocument()
  })

  it('does not open when the finger moves (a scroll), lifts early, or the browser takes the touch', async () => {
    renderApp({ signedIn: true })
    await screen.findByText('Landing page copy')
    const row = card('Landing page copy')
    // The finger drifts past the slop before the time is up, and is still down when it would have opened.
    fireEvent.pointerDown(row, { pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(row, { pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 124 })
    await wait(LONG_PRESS_MS + 60)
    expect(sheet()).toBeNull()
    fireEvent.pointerUp(row)

    fireEvent.pointerDown(row, { pointerType: 'touch', isPrimary: true, clientX: 10, clientY: 10 })
    fireEvent.pointerCancel(row)
    await wait(LONG_PRESS_MS + 60)
    expect(sheet()).toBeNull()

    fireEvent.pointerDown(row, { pointerType: 'touch', isPrimary: true, clientX: 10, clientY: 10 })
    await wait(LONG_PRESS_MS / 2)
    fireEvent.pointerUp(row)
    await wait(LONG_PRESS_MS)
    expect(sheet()).toBeNull()
  })

  it('opens from the keyboard and from the system long press, never showing the system menu', async () => {
    renderApp({ signedIn: true })
    await screen.findByText('Landing page copy')
    fireEvent.keyDown(card('Landing page copy'), { key: 'F10', shiftKey: true })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(sheet()).toBeNull())

    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => { card('Relay reconnect backoff').dispatchEvent(menu) })
    expect(menu.defaultPrevented).toBe(true)
    expect(within(await screen.findByRole('dialog')).getByRole('heading', { name: 'Relay reconnect backoff' })).toBeInTheDocument()
  })

  it('is reachable by screen readers through a hidden Options button after the row', async () => {
    renderApp({ signedIn: true })
    await screen.findByText('Landing page copy')
    const button = screen.getByRole('button', { name: 'Options for Landing page copy' })
    expect(button).toHaveAttribute('tabindex', '-1')
    fireEvent.click(button)
    expect(within(await screen.findByRole('dialog')).getByRole('heading', { name: 'Landing page copy' })).toBeInTheDocument()
  })

  it('works the same on a thread under a project and in Recent chats', async () => {
    renderApp({ signedIn: true })
    await screen.findByText('Landing page copy')
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }))
    fireEvent.click(screen.getByRole('button', { name: /^website/ }))
    await hold(screen.getByText('Landing page copy').closest('button')!)
    expect(within(await screen.findByRole('dialog')).getByRole('heading', { name: 'Landing page copy' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(sheet()).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /Recent chats/ }))
    await hold(screen.getByText('Scratch notes').closest('button')!)
    expect(within(await screen.findByRole('dialog')).getByRole('heading', { name: 'Scratch notes' })).toBeInTheDocument()
  })
})

describe('each option', () => {
  it('pins and unpins on the computer, and the list shows it', async () => {
    const connection = renderFake()
    await screen.findByText('Landing page copy')
    const session = await studio(connection)
    await hold(card('Landing page copy'))
    fireEvent.click(option('Pin'))
    expect(sheet()).toBeNull()
    await waitFor(() => expect(within(card('Landing page copy')).getByLabelText('Pinned')).toBeInTheDocument())
    expect(session.threadMenu.calls).toEqual([{ method: 'threads.pin', threadId: 't-landing', value: true }])

    await hold(card('Landing page copy'))
    fireEvent.click(option('Unpin'))
    await waitFor(() => expect(within(card('Landing page copy')).queryByLabelText('Pinned')).not.toBeInTheDocument())
    expect(session.threadMenu.calls.at(-1)).toEqual({ method: 'threads.pin', threadId: 't-landing', value: false })
  })

  it('archives into Archived with an Undo, and unarchives from there', async () => {
    const connection = renderFake()
    await screen.findByText('Landing page copy')
    const session = await studio(connection)
    await hold(card('Landing page copy'))
    fireEvent.click(option('Archive'))
    expect(await screen.findByText('Archived “Landing page copy”.')).toBeInTheDocument()
    expect(within(document.querySelector('.m-sb-feed')!).queryByText('Landing page copy')).toBeNull()
    expect(session.threadMenu.calls).toEqual([{ method: 'threads.settle', threadId: 't-landing', value: true }])

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(within(document.querySelector('.m-sb-feed')!).getByText('Landing page copy')).toBeInTheDocument())
    expect(session.threadMenu.calls.at(-1)).toEqual({ method: 'threads.settle', threadId: 't-landing', value: false })

    // An archived thread offers Unarchive, no Pin or Delete after, and Delete only on its computer.
    fireEvent.click(screen.getByRole('button', { name: /Archived/ }))
    await hold(card('Swap lucide for Hugeicons'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('menuitem').map((item) => item.querySelector('.m-option__title')?.textContent)).toEqual(['Unarchive', 'Regenerate title', 'Rename', 'Delete…'])
    expect(option(/Delete…/)).toBeDisabled()
    expect(option(/Delete…/)).toHaveTextContent('Delete it in Mousse on Studio Mac')
    fireEvent.click(option('Unarchive'))
    await waitFor(() => expect(within(document.querySelector('.m-sb-feed')!).getByText('Swap lucide for Hugeicons')).toBeInTheDocument())
  })

  it('renames, and the list shows the new name', async () => {
    const connection = renderFake()
    await screen.findByText('Landing page copy')
    const session = await studio(connection)
    await hold(card('Landing page copy'))
    fireEvent.click(option('Rename'))
    const input = screen.getByLabelText('Name')
    expect(input).toHaveValue('Landing page copy')
    fireEvent.change(input, { target: { value: '  Pricing page copy ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sheet()).toBeNull())
    expect(card('Pricing page copy')).toBeInTheDocument()
    expect(session.threadMenu.calls).toEqual([{ method: 'threads.rename', threadId: 't-landing', value: 'Pricing page copy' }])
  })

  it('says why a change failed: in the sheet, or on the list with the row put back', async () => {
    const connection = renderFake()
    await screen.findByText('Landing page copy')
    const session = await studio(connection)
    session.threadMenu.failNext = 'The computer couldn’t confirm this. Check the thread list, then try again.'
    await hold(card('Landing page copy'))
    fireEvent.click(option('Rename'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('The computer couldn’t confirm this.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(sheet()).toBeNull())

    session.threadMenu.failNext = 'This thread is gone from the computer.'
    await hold(card('Landing page copy'))
    fireEvent.click(option('Archive'))
    expect(await screen.findByText('This thread is gone from the computer.')).toBeInTheDocument()
    expect(within(document.querySelector('.m-sb-feed')!).getByText('Landing page copy')).toBeInTheDocument()
  })

  it('regenerates the title with the computer’s title model', async () => {
    const connection = renderFake()
    await screen.findByText('Landing page copy')
    const session = await studio(connection)
    await hold(card('Landing page copy'))
    fireEvent.click(option('Regenerate title'))
    expect(option('Writing a new title…')).toHaveAttribute('aria-busy', 'true')
    await waitFor(() => expect(sheet()).toBeNull(), { timeout: 3000 })
    expect(card('Tidy the thread list')).toBeInTheDocument()
    expect(session.threadMenu.calls).toEqual([{ method: 'threads.regenerateTitle', threadId: 't-landing' }])
  })

  it('sets and clears when the thread deletes itself', async () => {
    const connection = renderFake()
    await screen.findByText('Landing page copy')
    const session = await studio(connection)
    await hold(card('Landing page copy'))
    fireEvent.click(option('Delete after'))
    expect(within(screen.getByRole('dialog')).queryByRole('menuitem', { name: 'Keep it' })).toBeNull()
    const before = Date.now()
    fireEvent.click(option('After 7 days'))
    await waitFor(() => expect(sheet()).toBeNull())
    const call = session.threadMenu.calls[0]!
    expect(call).toMatchObject({ method: 'threads.setExpiry', threadId: 't-landing' })
    const at = Date.parse(call.value as string)
    expect(at - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000)
    expect(at - before).toBeLessThan(7 * 86_400_000 + 5000)

    await hold(card('Landing page copy'))
    expect(option(/Delete after/)).toHaveTextContent('Deletes in 7 days')
    fireEvent.click(option(/Delete after/))
    fireEvent.click(option('Keep it'))
    await waitFor(() => expect(sheet()).toBeNull())
    expect(session.threadMenu.calls.at(-1)).toEqual({ method: 'threads.setExpiry', threadId: 't-landing', value: null })
  })

  it('leaves out Regenerate title and Delete after on a computer that does not offer them', async () => {
    const connection = renderFake()
    connection.setThreadMenuSupport('node-studio', { regenerateTitle: false, expiry: false })
    await screen.findByText('Landing page copy')
    await hold(card('Landing page copy'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Pin', 'Archive', 'Rename'])
  })
})

describe('threads of several computers', () => {
  /** What this phone saved from Travel laptop the last time it was online. */
  function saveLaptopLists(): void {
    const at = Date.now() - 60_000
    const lists: ComputerLists = {
      projects: [{ id: 'p-notes', name: 'notes', order: 0, pinned: false }],
      threads: [{ id: 't-hotel', title: 'Hotel wifi notes', projectId: 'p-notes', createdAt: at, updatedAt: at, order: 0, pinned: false, settled: false, started: true }],
      chats: [],
      bots: [],
      status: {},
      receivedAt: at,
    }
    localStorage.setItem('mousse.lists.v1:acct-demo@mousse.dev:node-laptop', JSON.stringify(lists))
  }

  it('shows an offline computer’s options off, with the reason', async () => {
    saveLaptopLists()
    renderApp({ signedIn: true })
    await screen.findByText('Hotel wifi notes')
    await hold(card('Hotel wifi notes'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('On Travel laptop')).toBeInTheDocument()
    expect(within(dialog).getByText('Travel laptop is offline. Change this thread when it is back.')).toBeInTheDocument()
    for (const item of within(dialog).getAllByRole('menuitem')) expect(item).toBeDisabled()
  })

  it('sends each change to the computer that runs the thread', async () => {
    saveLaptopLists()
    const connection = renderFake()
    connection.setOnline('node-laptop', true)
    await screen.findByText('Landing page copy')
    // The laptop comes online with its own copy of the demo threads, under the same ids as Studio Mac's.
    await waitFor(() => expect([...document.querySelectorAll('.m-sb-card')].filter((element) => element.textContent?.includes('Landing page copy'))).toHaveLength(2), { timeout: 40_000 })
    const laptop = connection.sessions.get('node-laptop')!
    const studioSession = connection.sessions.get('node-studio')!
    await hold(card('Landing page copy', 'Travel laptop'))
    expect(within(await screen.findByRole('dialog')).getByText('On Travel laptop')).toBeInTheDocument()
    fireEvent.click(option('Pin'))
    await waitFor(() => expect(within(card('Landing page copy', 'Travel laptop')).getByLabelText('Pinned')).toBeInTheDocument())
    expect(laptop.threadMenu.calls).toEqual([{ method: 'threads.pin', threadId: 't-landing', value: true }])
    expect(studioSession.threadMenu.calls).toEqual([])
    expect(within(card('Landing page copy', 'Studio Mac')).queryByLabelText('Pinned')).toBeNull()
  }, 60_000)
})
