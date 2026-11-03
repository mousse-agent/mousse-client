// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AutoJoin, joinQueue, type AutoJoinOptions } from '../../src/connection/autoJoin'
import { manualNetworkSignals } from '../../src/connection/networkSignals'
import type { EnrollmentProgress, JoinPlan } from '../../src/connection/types'
import { until } from './helpers'

const NEEDED: JoinPlan = { status: 'needed', target: { nodeId: 'node-auth', name: 'Studio', online: true } }

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** An AutoJoin over scripted plans and enrollments that records what it asked. */
function harness(plans: JoinPlan[], options: Partial<AutoJoinOptions> = {}) {
  const asked: string[] = []
  let plansRead = 0
  let running = 0
  let overlapped = false
  const enrollments: Array<ReturnType<typeof deferred>> = []
  const network = manualNetworkSignals()
  const joined: number[] = []
  const join = new AutoJoin({
    plan: async () => plans[Math.min(plansRead++, plans.length - 1)],
    enroll: async (nodeId: string, onProgress: (progress: EnrollmentProgress) => void) => {
      asked.push(nodeId)
      running++
      if (running > 1) overlapped = true
      const pending = deferred()
      enrollments.push(pending)
      onProgress({ stage: 'waiting-approval' })
      try {
        await pending.promise
      } finally {
        running--
      }
    },
    network,
    onJoined: () => joined.push(Date.now()),
    retryMs: [20],
    ...options,
  })
  return { join, asked, network, enrollments, joined, plansRead: () => plansRead, overlapped: () => overlapped }
}

describe('joining the computers on its own', () => {
  it('asks the authority once after sign-in and goes quiet once joined', async () => {
    const h = harness([NEEDED, { status: 'joined' }])
    h.join.start()
    await until(() => h.asked.length === 1)
    expect(h.asked).toEqual(['node-auth'])
    expect(h.join.view()).toEqual({ state: 'joining', computer: 'Studio' })
    h.enrollments[0].resolve()
    await until(() => h.join.view().state === 'idle')
    expect(h.joined).toHaveLength(1)
    // Joined: no timer asks again.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.asked).toHaveLength(1)
    expect(h.plansRead()).toBe(1)
    h.join.dispose()
  })

  it('does nothing when the phone is already among the computers', async () => {
    const h = harness([{ status: 'joined' }])
    h.join.start()
    await until(() => h.plansRead() === 1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.asked).toEqual([])
    expect(h.join.view()).toEqual({ state: 'idle' })
    // A network change only checks again.
    h.network.fire()
    await until(() => h.plansRead() === 2)
    expect(h.asked).toEqual([])
    h.join.dispose()
  })

  it('never runs two requests at once, even when asked again or from another AutoJoin on the same queue', async () => {
    const queue = joinQueue()
    const first = harness([NEEDED, { status: 'joined' }], { queue })
    first.join.start()
    await until(() => first.asked.length === 1)
    first.join.check()
    first.network.fire()
    first.join.start()
    // A remount replaces the AutoJoin while the first request is still out.
    first.join.dispose()
    const second = harness([NEEDED, { status: 'joined' }], { queue })
    second.join.start()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(first.asked).toHaveLength(1)
    expect(second.plansRead()).toBe(0)
    first.enrollments[0].resolve()
    await until(() => second.asked.length === 1)
    expect(first.overlapped()).toBe(false)
    second.enrollments[0].resolve()
    await until(() => second.join.view().state === 'idle')
    second.join.dispose()
  })

  it('waits while the authority is offline and retries on its own', async () => {
    const offline: JoinPlan = { status: 'needed', target: { nodeId: 'node-auth', name: 'Studio', online: false } }
    const h = harness([offline, offline, NEEDED])
    h.join.start()
    await until(() => h.plansRead() === 1)
    expect(h.join.view()).toEqual({ state: 'waiting', computer: 'Studio' })
    expect(h.asked).toEqual([])
    await until(() => h.asked.length === 1, 500)
    h.enrollments[0].resolve()
    await until(() => h.join.view().state === 'idle')
    h.join.dispose()
  })

  it('retries after a failed request, and at once when the network comes back', async () => {
    const h = harness([NEEDED], { retryMs: [60_000] })
    h.join.start()
    await until(() => h.asked.length === 1)
    h.enrollments[0].reject(new Error('The request expired before the computer approved it.'))
    await until(() => h.join.view().state === 'waiting')
    expect(h.join.view()).toEqual({ state: 'waiting', computer: 'Studio' })
    h.network.fire()
    await until(() => h.asked.length === 2)
    h.enrollments[1].resolve()
    await until(() => h.join.view().state === 'idle')
    h.join.dispose()
  })

  it('says what to do when the computer has not answered for a while', async () => {
    const h = harness([NEEDED], { slowMs: 10 })
    h.join.start()
    await until(() => h.join.view().state === 'joining' && (h.join.view() as { slow?: boolean }).slow === true, 200)
    expect(h.join.view()).toEqual({ state: 'joining', computer: 'Studio', slow: true })
    h.join.dispose()
  })

  it('stays out after the computers removed the phone', async () => {
    const h = harness([{ status: 'removed', computer: 'Studio' }])
    h.join.start()
    await until(() => h.join.view().state === 'removed')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.asked).toEqual([])
    expect(h.plansRead()).toBe(1)
    h.join.dispose()
  })

  it('retries when Mousse ID cannot be read', async () => {
    let calls = 0
    const h = harness([NEEDED], {
      plan: async () => {
        calls++
        if (calls === 1) throw new Error('offline')
        return { status: 'joined' }
      },
    })
    h.join.start()
    await until(() => calls === 2, 500)
    expect(h.join.view()).toEqual({ state: 'idle' })
    h.join.dispose()
  })
})
