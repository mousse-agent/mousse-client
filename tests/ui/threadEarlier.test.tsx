import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatItem, ThreadDisplayState } from '../../src/connection/types'
import { createFakeConnection } from '../../src/ui/dev/fakeConnection'
import { ThreadView } from '../../src/ui/screens/ThreadView'
import { RouterProvider } from '../../src/ui/state/router'
import { installMatchMedia } from './helpers'

const item = (n: number): ChatItem => ({ id: `m${n}`, role: 'assistant', text: `Reply ${n}`, createdAt: n, kind: 'message', status: 'done' })

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

describe('a long thread on the phone', () => {
  it('reads the older messages from the computer when the reader reaches the top, until none are left', async () => {
    const connection = createFakeConnection({ signedIn: true, latencyMs: 0 })
    const session = await connection.openComputer('node-studio')
    // The computer holds m0..m9; the phone was given m8 and m9, and each read brings the four before.
    let shown = [8, 9]
    let notify: ((items: ChatItem[], state?: ThreadDisplayState) => void) | undefined
    const publish = () => {
      const earlier = shown[0]!
      const items = shown.map(item)
      notify?.(earlier ? [{ id: 'local-earlier', role: 'system', text: `${earlier} earlier messages`, createdAt: 0 }, ...items] : items, {
        questions: [],
        ...(earlier ? { earlier: { count: earlier, loadable: true } } : {}),
      })
    }
    const reads: number[] = []
    session.openThread = (_threadId, onItems) => {
      notify = onItems
      publish()
      return Promise.resolve(() => undefined)
    }
    session.loadEarlier = async () => {
      reads.push(shown[0]!)
      const start = Math.max(0, shown[0]! - 4)
      shown = [...Array.from({ length: shown[0]! - start }, (_, n) => start + n), ...shown]
      publish()
    }
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => root!.render(<RouterProvider><ThreadView session={session} threadId="t-long" /></RouterProvider>))
    const scroller = host.querySelector('.m-thread__scroll') as HTMLElement
    // A reader scrolled to the top of what is shown: the page before it is read, and the next one when it is shown.
    for (let step = 0; step < 4 && shown[0]; step++)
      await act(async () => {
        scroller.scrollTop = 0
        scroller.dispatchEvent(new Event('scroll'))
      })
    expect(reads).toEqual([8, 4])
    expect(host.textContent).toContain('Reply 0')
    expect(host.textContent).not.toContain('earlier messages')
  })
})
