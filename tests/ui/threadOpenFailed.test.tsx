import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatItem } from '../../src/connection/types'
import { NetError } from '../../src/net/errors'
import { createFakeConnection } from '../../src/ui/dev/fakeConnection'
import { ThreadView } from '../../src/ui/screens/ThreadView'
import { RouterProvider } from '../../src/ui/state/router'
import { installMatchMedia } from './helpers'

let root: Root | undefined
let host: HTMLElement | undefined
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

beforeEach(() => {
  installMatchMedia()
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('a thread the computer could not open', () => {
  it('says so with the reason and a way to try again, not as an empty new thread', async () => {
    const connection = createFakeConnection({ signedIn: true, latencyMs: 0 })
    const session = await connection.openComputer('node-studio')
    const answer: ChatItem = { id: 'm1', role: 'assistant', text: 'All of the thread', createdAt: 1, kind: 'message', status: 'done' }
    let opens = 0
    session.isTurnActive = () => Promise.resolve(false)
    session.openThread = (_threadId, onItems) => {
      opens++
      // An older computer answers a read it could not do with "may have partly happened".
      if (opens === 1) return Promise.reject(new NetError('outcome_uncertain'))
      onItems([answer], { questions: [] })
      return Promise.resolve(() => undefined)
    }
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => root!.render(<RouterProvider><ThreadView session={session} threadId="t-long" /></RouterProvider>))
    expect(host.textContent).toContain('Could not open this thread')
    expect(host.textContent).toContain('The computer could not read it.')
    expect(host.textContent).not.toContain('What should we build?')
    expect(host.textContent).not.toContain('may have partly happened')
    // Nothing runs: the composer offers no Stop.
    expect(host.querySelector('[aria-label="Stop"]')).toBeNull()

    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
    await act(async () => retry.click())
    expect(opens).toBe(2)
    expect(host.textContent).toContain('All of the thread')
    expect(host.textContent).not.toContain('Could not open this thread')
  })
})
