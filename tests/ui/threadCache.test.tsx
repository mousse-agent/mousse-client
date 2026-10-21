import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatItem } from '../../src/connection/types'
import { createFakeConnection } from '../../src/ui/dev/fakeConnection'
import { ThreadView } from '../../src/ui/screens/ThreadView'
import { RouterProvider } from '../../src/ui/state/router'
import { installMatchMedia } from './helpers'

const SAVED: ChatItem[] = [
  { id: 'm1', role: 'user', text: 'Saved question', createdAt: 1, kind: 'message', status: 'done' },
  { id: 'm2', role: 'assistant', text: 'Saved answer', createdAt: 2, kind: 'message', status: 'done' },
]

let root: Root | undefined
let host: HTMLElement | undefined
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

beforeEach(() => installMatchMedia())
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined
})

describe('opening a saved thread', () => {
  it('draws the saved thread in the first commit, with no spinner', async () => {
    const connection = createFakeConnection({ signedIn: true, latencyMs: 0 })
    const session = await connection.openComputer('node-studio')
    // A session that holds the thread in memory answers before openThread returns.
    session.openThread = (_threadId, onItems) => {
      onItems(SAVED, { questions: [] })
      return Promise.resolve(() => undefined)
    }
    host = document.body.appendChild(document.createElement('div'))
    // Outside act, so the DOM shows what the first commit drew, before passive effects run.
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    root = createRoot(host)
    flushSync(() => root!.render(<RouterProvider><ThreadView session={session} threadId="t-saved" /></RouterProvider>))
    expect(host.textContent).toContain('Saved answer')
    expect(host.querySelector('[aria-label="Loading thread"]')).toBeNull()
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })
})
