import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { installMatchMedia, renderApp } from './helpers'
import { parentFolders } from '../../src/ui/sidebar/NewProjectSheet'
import { ACCENT_COLORS, accentInk, contrastRatio } from '../../src/ui/theme/appearance'

beforeEach(() => installMatchMedia())

const dock = () => screen.getByRole('navigation', { name: 'Home' })

describe('home dock', () => {
  it('holds the tabs and a button that makes what the open tab lists', async () => {
    renderApp({ signedIn: true })
    await screen.findByText('Phone app redesign')
    const nav = dock()
    const tabs = within(nav).getByRole('tablist', { name: 'Sidebar view' })
    expect(within(tabs).getByRole('tab', { name: 'Threads' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'm-sidebar-tab-threads')
    // The top bar names the tab and keeps only Settings; there is one New thread button, in the dock.
    expect(screen.getByRole('heading', { level: 1, name: 'Threads' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New thread' })).toEqual([within(nav).getByRole('button', { name: 'New thread' })])

    fireEvent.click(within(tabs).getByRole('tab', { name: 'Projects' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'New project' })).toBeEnabled()

    // Arrow keys still move between tabs.
    fireEvent.keyDown(within(tabs).getByRole('tab', { name: 'Projects' }), { key: 'ArrowRight' })
    fireEvent.keyDown(within(tabs).getByRole('tab', { name: 'Threads' }), { key: 'ArrowRight' })
    expect(within(tabs).getByRole('tab', { name: 'Chats' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { level: 1, name: 'Chats' })).toBeInTheDocument()
    // New bot is the dock's button now, not a + beside the Bots heading.
    expect(screen.getAllByRole('button', { name: 'New bot' })).toEqual([within(nav).getByRole('button', { name: 'New bot' })])
  })

  it('is not on a thread', async () => {
    renderApp({ signedIn: true })
    fireEvent.click(await screen.findByText('Landing page copy'))
    expect(await screen.findByLabelText('Message')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Home' })).not.toBeInTheDocument()
  })
})

describe('new project', () => {
  it('opens a folder on the computer as a project, and shows its refusal', async () => {
    renderApp({ signedIn: true })
    await screen.findByText('Phone app redesign')
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }))
    fireEvent.click(within(dock()).getByRole('button', { name: 'New project' }))
    const sheet = await screen.findByRole('dialog', { name: 'New project on Studio Mac' })
    const field = within(sheet).getByLabelText('Folder on Studio Mac')
    const open = within(sheet).getByRole('button', { name: 'Open folder' })
    expect(open).toBeDisabled()

    // The computer refuses a path that is not a full one; the sheet stays open with its reason.
    fireEvent.change(field, { target: { value: 'code/notes' } })
    fireEvent.click(open)
    expect(await within(sheet).findByText('Enter the full path of a folder, starting from the root.')).toBeInTheDocument()

    // The folder holding the computer's projects is offered to start from.
    fireEvent.click(within(sheet).getByRole('button', { name: '~/code/' }))
    expect(field).toHaveValue('~/code/')
    fireEvent.change(field, { target: { value: '~/code/notes' } })
    fireEvent.click(open)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('button', { name: /^notes Studio Mac/ })).toBeInTheDocument()
  })

  it('offers the folders that hold the projects, the most used first', () => {
    expect(parentFolders(['/home/a/code/x', '/home/a/code/y/', '/srv/z', 'C:\\work\\app', 'relative'])).toEqual(['/home/a/code/', '/srv/', 'C:\\work\\'])
  })
})

describe('create button ink', () => {
  it('is readable on every accent', () => {
    for (const { label, value } of ACCENT_COLORS) {
      expect(contrastRatio(value, accentInk(value)), label).toBeGreaterThanOrEqual(4.5)
    }
  })
})
