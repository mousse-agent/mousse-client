// Adds this phone to the account's computers on its own once the user is signed in: no computer
// to pick and no code to compare. The computer that adds devices (the roster authority) approves a
// request from its own Mousse ID account by itself, and one join reaches every computer of the
// account. When that computer is offline or the request fails, the phone tries again later: after a
// growing wait, when the network changes, and when the app comes back to the foreground.
import type { NetworkSignals } from './networkSignals'
import type { EnrollmentProgress, JoinPlan } from './types'

/**
 * - `idle`: nothing to do (the phone is among the computers, or not signed in).
 * - `none`: the account has no computer yet.
 * - `joining`: a request is with `computer`; `slow` once it waited a while without an answer.
 * - `waiting`: `computer` is offline or did not answer; the phone tries again on its own.
 * - `removed`: the user's computers removed this phone; it stays out until the user signs in again.
 */
export type AutoJoinView =
  | { state: 'idle' }
  | { state: 'none' }
  | { state: 'joining'; computer: string; slow?: boolean }
  | { state: 'waiting'; computer: string }
  | { state: 'removed'; computer?: string }

/** Waits before each new try. After the last one the phone keeps trying at the last wait. */
export const JOIN_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000]
/** How long a request may wait for the computer before the phone says what to do. */
export const JOIN_SLOW_MS = 30_000

export interface AutoJoinOptions {
  plan(): Promise<JoinPlan>
  enroll(nodeId: string, onProgress: (progress: EnrollmentProgress) => void): Promise<void>
  /** Network changes and app resumes start a new try at once. */
  network?: NetworkSignals
  /** Called after the phone joined, so the computers' threads can show. */
  onJoined?(): void
  retryMs?: number[]
  slowMs?: number
  /**
   * Runs checks one at a time across every AutoJoin that shares it: one that was replaced (the
   * account changed, the screen remounted) may still be waiting on a request.
   */
  queue?: JoinQueue
}

/** Runs tasks one after another. */
export type JoinQueue = <T>(task: () => Promise<T>) => Promise<T>

export function joinQueue(): JoinQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.catch(() => undefined).then(task)
    tail = next
    return next
  }
}

export class AutoJoin {
  private current: AutoJoinView = { state: 'idle' }
  private readonly listeners = new Set<() => void>()
  private running = false
  private started = false
  private disposed = false
  private attempts = 0
  private timer?: ReturnType<typeof setTimeout>
  private slowTimer?: ReturnType<typeof setTimeout>
  private offNetwork?: () => void

  constructor(private readonly options: AutoJoinOptions) {}

  view = (): AutoJoinView => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Starts watching; the first check runs at once. Later calls only check again. */
  start(): void {
    if (this.disposed) return
    if (!this.started) {
      this.started = true
      this.offNetwork = this.options.network?.onChange(() => this.check())
    }
    this.check()
  }

  /** Checks now unless a check or a request is already running. A phone that joined, or that was removed, only checks when asked. */
  check(): void {
    if (this.disposed || this.running) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.attempts = 0
    void this.run()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    clearTimeout(this.slowTimer)
    this.offNetwork?.()
    this.listeners.clear()
  }

  private async run(): Promise<void> {
    this.running = true
    try {
      await (this.options.queue ?? ((task) => task()))(() => this.attempt())
    } finally {
      this.running = false
    }
  }

  /** One check, and a request when the phone has to join. */
  private async attempt(): Promise<void> {
    if (this.disposed) return
    let plan: JoinPlan
    try {
      plan = await this.options.plan()
    } catch {
      // Mousse ID could not be read (no network): keep what the screen says and try again later.
      if (!this.disposed) this.retryLater()
      return
    }
    if (this.disposed) return
    if (plan.status === 'joined') return this.set({ state: 'idle' })
    if (plan.status === 'removed') return this.set({ state: 'removed', ...(plan.computer ? { computer: plan.computer } : {}) })
    if (plan.status === 'none') {
      // A computer may sign in later.
      this.set({ state: 'none' })
      return this.retryLater()
    }
    const { target } = plan
    if (!target.online) {
      this.set({ state: 'waiting', computer: target.name })
      return this.retryLater()
    }
    this.set({ state: 'joining', computer: target.name })
    let denied = false
    try {
      await this.options.enroll(target.nodeId, (progress) => {
        if (progress.stage === 'denied') denied = true
        if (progress.stage !== 'waiting-approval' || this.slowTimer !== undefined || this.disposed) return
        this.slowTimer = setTimeout(() => {
          if (this.current.state === 'joining') this.set({ state: 'joining', computer: target.name, slow: true })
        }, this.options.slowMs ?? JOIN_SLOW_MS)
      })
    } catch {
      if (this.disposed) return
      this.set({ state: 'waiting', computer: target.name })
      // Someone said no on the computer (an older Mousse asks): ask again only rarely.
      if (denied) this.attempts = Math.max(this.attempts, (this.options.retryMs ?? JOIN_RETRY_MS).length - 1)
      return this.retryLater()
    } finally {
      clearTimeout(this.slowTimer)
      this.slowTimer = undefined
    }
    if (this.disposed) return
    this.attempts = 0
    this.set({ state: 'idle' })
    this.options.onJoined?.()
  }

  private retryLater(): void {
    const delays = this.options.retryMs ?? JOIN_RETRY_MS
    const delay = delays[Math.min(this.attempts, delays.length - 1)]
    this.attempts++
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.disposed || this.running) return
      void this.run()
    }, delay)
  }

  private set(next: AutoJoinView): void {
    const same = JSON.stringify(next) === JSON.stringify(this.current)
    if (same) return
    this.current = next
    for (const listener of [...this.listeners]) listener()
  }
}
