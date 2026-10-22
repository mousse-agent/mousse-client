import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatItem, ThreadDisplayState } from '../../src/connection/types'
import { APPLET_EVENT } from '../../src/ui/applets/appletDocument'
import { Timeline } from '../../src/ui/timeline/Timeline'

afterEach(() => cleanup())

const idle: ThreadDisplayState = { questions: [] }
const source = {
  schemaVersion: 1 as const,
  title: 'Budget',
  description: 'Adjust monthly income.',
  html: '<main id="m">Income</main>',
  css: 'main{padding:16px}',
  js: "document.getElementById('m').textContent='ready'",
  stateVersion: 1,
}
const reply = (id: string, applet: Partial<{ source: typeof source }> = { source }): ChatItem => ({
  id,
  role: 'assistant',
  kind: 'message',
  text: 'Here is a budget tool.\n\nMove the slider.',
  createdAt: 1_000,
  status: 'done',
  parts: [
    { type: 'text', text: 'Here is a budget tool.' },
    { type: 'applet', applet: { appletId: `applet_${id}`, revisionId: 'rev_1', title: 'Budget', description: 'Adjust monthly income.', ...applet } },
    { type: 'text', text: 'Move the slider.' },
  ],
})
const post = (frame: HTMLIFrameElement, type: string, payload: unknown, from: Window | null = frame.contentWindow) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { [APPLET_EVENT]: JSON.stringify({ type, payload }) }, source: from }))
  })

describe('in-response applets', () => {
  it('runs a published applet in a sandboxed frame after a tap', async () => {
    const onAddToDraft = vi.fn()
    render(<Timeline items={[reply('a1')]} display={idle} active={false} onAddToDraft={onAddToDraft} />)
    expect(screen.getByText('Here is a budget tool.')).toBeInTheDocument()
    expect(screen.getByText('Move the slider.')).toBeInTheDocument()
    expect(screen.queryByText(/schemaVersion/)).not.toBeInTheDocument()
    const card = screen.getByRole('region', { name: 'Interactive applet: Budget' })
    expect(card.querySelector('iframe')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const frame = card.querySelector('iframe')!
    // Scripts only: an opaque origin, with no same-origin access, popups, forms or top navigation.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    const html = frame.getAttribute('srcdoc')!
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain('<main id="m">Income</main>')

    // The frame asks to add text to the message; nothing is sent until the user agrees.
    post(frame, 'conversation-input', 'Income is 4000')
    expect(screen.getByText('Income is 4000')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(onAddToDraft).toHaveBeenCalledWith('From applet "Budget":\nIncome is 4000')

    // Events from anywhere but this frame are ignored.
    post(frame, 'conversation-input', 'forged', window)
    expect(screen.queryByText('forged')).not.toBeInTheDocument()

    post(frame, 'resize', 10_000)
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(frame.style.height).toBe('540px')

    // A runtime error stops the applet and offers a repair request.
    post(frame, 'error', 'x is not defined')
    expect(screen.getByRole('alert')).toHaveTextContent('x is not defined')
    expect(card.querySelector('iframe')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ask the assistant to fix this' }))
    expect(onAddToDraft).toHaveBeenLastCalledWith(expect.stringContaining('Please fix applet "Budget" (appletId: applet_a1, expectedRevision: rev_1)'))
  })

  it('restores the state an applet saved when it runs again', () => {
    render(<Timeline items={[reply('a2')]} display={idle} active={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const card = screen.getByRole('region', { name: 'Interactive applet: Budget' })
    post(card.querySelector('iframe')!, 'state', { income: '7000' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(card.querySelector('iframe')!.getAttribute('srcdoc')).toContain('"income":"7000"')
  })

  it('says when an applet cannot run on the phone, and shows a placeholder while one is written', () => {
    const streaming: ChatItem = { ...reply('a3'), status: 'streaming', parts: [{ type: 'text', text: 'Here:' }, { type: 'applet-pending' }] }
    render(<Timeline items={[reply('a4', { source: undefined }), streaming]} display={idle} active />)
    expect(screen.getByText(/could not be read on the phone/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument()
    expect(screen.getByText('Generating interactive applet…')).toBeInTheDocument()
  })
})
