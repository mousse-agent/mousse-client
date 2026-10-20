import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { installMatchMedia, renderApp } from './helpers'

beforeEach(() => installMatchMedia())

const thread = (threadId: string) => [
  { name: 'computers' as const },
  { name: 'thread' as const, nodeId: 'node-studio', threadId }
]

async function sendMessage(text: string) {
  const field = await screen.findByLabelText('Message')
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading thread' })).not.toBeInTheDocument())
  fireEvent.change(field, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('thread chat', () => {
  it('sends a message and streams the reply', async () => {
    renderApp({ signedIn: true, routes: thread('t-voices') })
    await sendMessage('Add a voice picker')

    expect(await screen.findByText('Add a voice picker')).toBeInTheDocument()
    // While the reply streams, the send button turns into Stop.
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument()
    // The tool call is collapsed until tapped.
    const tool = await screen.findByRole('button', { name: /search_files/ })
    expect(tool).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(tool)
    expect(tool).toHaveAttribute('aria-expanded', 'true')

    await waitFor(() => expect(screen.getByText(/Here is the plan for "Add a voice picker"/)).toBeInTheDocument(), { timeout: 3000 })
    await waitFor(() => {
      const replies = screen.getAllByTestId('chat-item').filter((item) => item.dataset.role === 'assistant')
      expect(replies[replies.length - 1]).toHaveAttribute('data-status', 'done')
    }, { timeout: 3000 })
    expect(await screen.findByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('stops a running turn', async () => {
    renderApp({ signedIn: true, tickMs: 200, routes: thread('t-voices') })
    await sendMessage('Refactor the relay')
    const stop = await screen.findByRole('button', { name: 'Stop' })
    fireEvent.click(stop)

    expect(await screen.findByText('Stopped')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })
})
