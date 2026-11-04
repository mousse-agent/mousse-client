import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { installMatchMedia, renderApp } from './helpers'
import type { FakeMousseConnection } from '../../src/ui/dev/fakeConnection'

beforeEach(() => installMatchMedia())

const thread = (threadId: string) => [
  { name: 'home' as const },
  { name: 'thread' as const, nodeId: 'node-studio', threadId }
]

async function open(threadId = 't-voices', options: { tickMs?: number } = {}) {
  const { connection } = renderApp({ signedIn: true, routes: thread(threadId), ...options })
  await screen.findByLabelText('Message')
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading thread' })).not.toBeInTheDocument())
  // The computer's controls arrive after the thread opens.
  await screen.findByRole('button', { name: /^Model: / })
  const session = () => (connection as FakeMousseConnection).lastSession!
  return { connection, session }
}

function type(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } })
}

describe('composer controls', () => {
  it('shows the model and its level on one button, and stores a picked model on the thread', async () => {
    const { session } = await open()
    // As the desktop's model button: the short name, then the reasoning level. No mode or effort pills.
    expect(screen.getByRole('button', { name: 'Model: Opus 4.8 High' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Mode: / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Reasoning effort: / })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Model: Opus 4.8 High' }))
    const models = await screen.findByRole('menu', { name: 'Models' })
    // Grouped by provider like the desktop: a rail with All and each provider.
    expect(screen.getByRole('tab', { name: /OpenAI/ })).toBeInTheDocument()
    fireEvent.click(within(models).getByRole('menuitemradio', { name: 'GPT 5.5, OpenAI' }))

    // The level carries over when the new model has it.
    expect(await screen.findByRole('button', { name: 'Model: GPT 5.5 High' })).toBeInTheDocument()
    await waitFor(async () => expect((await session().getThread('t-voices')).model).toEqual({ instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5.5:high' }))

    // The picker's reasoning levels are the selected model's.
    fireEvent.click(screen.getByRole('button', { name: 'Model: GPT 5.5 High' }))
    const levels = await screen.findByRole('radiogroup', { name: 'Reasoning for GPT 5.5' })
    fireEvent.click(within(levels).getByRole('radio', { name: 'Extra high' }))
    expect(await screen.findByRole('button', { name: 'Model: GPT 5.5 Extra high' })).toBeInTheDocument()
    await waitFor(async () => expect((await session().getThread('t-voices')).model?.model).toBe('gpt-5.5:xhigh'))
  })

  it('offers Fast and long-context variants, shows the permission mode, and filters by search and favorites', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: /^Model: / }))
    // Under the list, as in the desktop picker's footer: the speed, then the thread's permission mode.
    expect(await screen.findByRole('note', { name: 'Permission mode: Auto-accept edits' })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Speed' })).getByRole('radio', { name: 'Fast' }))
    expect(await screen.findByRole('button', { name: 'Model: Opus 4.8 Fast High' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Model: / }))
    fireEvent.click(await screen.findByRole('button', { name: '1M' }))
    expect(await screen.findByRole('button', { name: /^Model: Sonnet 4.6 · 1M/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Model: / }))
    fireEvent.change(await screen.findByLabelText('Search models'), { target: { value: 'mini' } })
    expect(within(screen.getByRole('menu', { name: 'Models' })).getAllByRole('menuitemradio').map((row) => row.getAttribute('aria-label'))).toEqual(['GPT 5.5 mini, OpenAI'])
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Claude Haiku 4.5 to favorites' }))
    fireEvent.click(screen.getByRole('button', { name: 'Favorites only' }))
    expect(within(screen.getByRole('menu', { name: 'Models' })).getAllByRole('menuitemradio').map((row) => row.getAttribute('aria-label'))).toEqual(['Claude Haiku 4.5, Anthropic'])
  })

  it('sends an image with no chat mode, as the desktop does', async () => {
    const { session } = await open()
    const png = new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], 'shot.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [png] } })
    expect(await screen.findByRole('button', { name: 'Remove shot.png' })).toBeInTheDocument()
    type('What is wrong here?')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(session().sent).toHaveLength(1))
    expect(session().sent[0]).toMatchObject({
      kind: 'send',
      text: 'What is wrong here?',
      options: { images: [{ name: 'shot.png', mimeType: 'image/png', data: 'iVBORwECAw==' }] }
    })
    expect(session().sent[0].options).not.toHaveProperty('mode')
    expect(screen.queryByRole('button', { name: 'Remove shot.png' })).not.toBeInTheDocument()
  })

  it('lists slash commands and picks a skill for one message', async () => {
    const { session } = await open()
    type('/')
    const list = await screen.findByRole('listbox', { name: 'Commands' })
    const names = within(list).getAllByRole('option').map((option) => option.textContent ?? '')
    expect(names.some((name) => name.startsWith('/new'))).toBe(true)
    // Usage opens a desktop panel; the phone leaves it out.
    expect(names.some((name) => name.startsWith('/usage'))).toBe(false)
    type('/sk')
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Commands' })).getByRole('option', { name: /\/skills/ }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Code review/ }))
    expect(await screen.findByRole('button', { name: 'Remove skill Code review' })).toBeInTheDocument()
    type('Check the diff')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(session().sent).toHaveLength(1))
    expect(session().sent[0].options).toEqual({ mode: { type: 'skill', skillId: 'skill-review' } })
  })

  it('queues a message while a turn runs and runs it after', async () => {
    const { session } = await open('t-voices', { tickMs: 40 })
    type('First')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Stop' })
    type('Second')
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    const queue = await screen.findByRole('region', { name: 'Queued messages' })
    expect(within(queue).getByText('Second')).toBeInTheDocument()
    await waitFor(() => expect(session().sent.map((entry) => [entry.kind, entry.text])).toEqual([['send', 'First'], ['queue', 'Second'], ['send', 'Second']]), { timeout: 8000 })
  })

  it('stops a turn with /stop', async () => {
    await open('t-voices', { tickMs: 200 })
    type('Long job')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Stop' })
    type('/stop')
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    expect(await screen.findByText('Stopped')).toBeInTheDocument()
  })
})
