import { describe, expect, it, vi } from 'vitest'
import { listThread } from '../../src/connection/lists'
import { SessionThreadActions } from '../../src/connection/threadActions'
import { NetError } from '../../src/net/errors'

// The thread menu's calls, as the computer's phone methods take them (mousse/src/mms/bridge/remote/dto.ts).

function actions(answer: (method: string, params: Record<string, unknown>) => unknown = () => ({ thread: {} })) {
  const rpc = vi.fn(async (method: string, params: Record<string, unknown>, _options?: { idem?: string }) => answer(method, params))
  return { rpc, menu: new SessionThreadActions(rpc) }
}

describe('thread menu calls', () => {
  it('sends each change with the params the computer accepts, once each with its own idem', async () => {
    const { rpc, menu } = actions()
    await menu.rename('t1', '  New name ')
    await menu.pin('t1', true)
    await menu.settle('t1', false)
    await menu.regenerateTitle('t1')
    await menu.setExpiry('t1', '2026-11-21T10:00:00.000Z', true)
    await menu.setExpiry('t1', null, true)
    expect(rpc.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ['threads.rename', { threadId: 't1', name: 'New name' }],
      ['threads.pin', { threadId: 't1', pinned: true }],
      ['threads.settle', { threadId: 't1', settled: false }],
      ['threads.regenerateTitle', { threadId: 't1' }],
      ['threads.setExpiry', { threadId: 't1', expiresAt: '2026-11-21T10:00:00.000Z', stopsRun: true }],
      ['threads.setExpiry', { threadId: 't1', expiresAt: null }],
    ])
    const idems = rpc.mock.calls.map(([, , options]) => options?.idem)
    expect(new Set(idems).size).toBe(idems.length)
  })

  it('refuses an empty name before asking the computer', async () => {
    const { rpc, menu } = actions()
    await expect(menu.rename('t1', '   ')).rejects.toThrow('Write a name first.')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reads what the computer offers from net.info, once, and an older computer offers no extras', async () => {
    const current = actions((method) => (method === 'net.info' ? { v: 1, remote: ['threads.rename', 'threads.regenerateTitle', 'threads.setExpiry'] } : {}))
    expect(await current.menu.support()).toEqual({ regenerateTitle: true, expiry: true })
    await current.menu.support()
    expect(current.rpc).toHaveBeenCalledTimes(1)

    const withoutList = actions(() => ({ v: 1, version: '0.1.2', routed: {} }))
    expect(await withoutList.menu.support()).toEqual({ regenerateTitle: false, expiry: false })

    const beforeNetInfo = actions(() => { throw new NetError('forbidden') })
    expect(await beforeNetInfo.menu.support()).toEqual({ regenerateTitle: false, expiry: false })
  })

  it('says why a change failed in plain words', async () => {
    const refused = actions(() => ({ ok: false, error: 'An expiry must be at least a minute away' }))
    await expect(refused.menu.setExpiry('t1', '2026-11-14T00:00:00.000Z', false)).rejects.toThrow('An expiry must be at least a minute away')
    const gone = actions(() => { throw new NetError('stream_unknown') })
    await expect(gone.menu.pin('t1', true)).rejects.toThrow('This thread is gone from the computer.')
    const unsure = actions(() => { throw new NetError('outcome_uncertain') })
    await expect(unsure.menu.settle('t1', true)).rejects.toThrow('The computer couldn’t confirm this.')
  })
})

describe('a listed thread', () => {
  it('carries when it deletes itself, and only a valid time', () => {
    const base = { id: 't1', name: 'One', updatedAt: '2026-11-14T10:00:00.000Z', startedAt: '2026-11-14T10:00:00.000Z' }
    expect(listThread({ ...base, expiresAt: '2026-11-21T10:00:00.000Z', expiryStopsRun: true })).toMatchObject({ expiresAt: '2026-11-21T10:00:00.000Z', expiryStopsRun: true })
    expect(listThread({ ...base, expiresAt: 'soon', expiryStopsRun: true })).not.toHaveProperty('expiresAt')
    expect(listThread({ ...base, expiresAt: 'soon', expiryStopsRun: true })).not.toHaveProperty('expiryStopsRun')
    expect(listThread(base)).not.toHaveProperty('expiresAt')
  })
})
