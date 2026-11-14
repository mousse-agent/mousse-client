// A thread's menu on the computer that runs it: rename, pin, archive, regenerate its title and set when it deletes
// itself. The methods are the ones the computer offers phones (mousse/src/mms/bridge/remote/capabilities.ts,
// BRIDGE_REMOTE_METHODS); each answers with the changed thread, and the lists stream then shows the change.
// Deleting is not here: only the computer that runs a thread deletes it.

/** Which of the menu's actions a computer offers phones, from its `net.info`. Rename, pin and archive are always there. */
export interface ThreadActionSupport {
  regenerateTitle: boolean
  expiry: boolean
}

export interface ThreadActions {
  /** Read once per session; an older computer offers neither extra. */
  support(): Promise<ThreadActionSupport>
  rename(threadId: string, name: string): Promise<void>
  pin(threadId: string, pinned: boolean): Promise<void>
  /** The desktop's Archive (`true`) and Unarchive (`false`). Archiving stops what still runs in the thread. */
  settle(threadId: string, settled: boolean): Promise<void>
  /** Asks the computer's title model for a new title; resolves once the thread has it. */
  regenerateTitle(threadId: string): Promise<void>
  /** When the thread deletes itself (an ISO time), or null to keep it. `stopsRun` stops a running turn at that time. */
  setExpiry(threadId: string, expiresAt: string | null, stopsRun: boolean): Promise<void>
}

/** The longest name the computer accepts. */
export const THREAD_NAME_MAX = 512

type Rpc = (method: string, params: Record<string, unknown>, options?: { idem?: string }) => Promise<unknown>

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const NONE: ThreadActionSupport = { regenerateTitle: false, expiry: false }

/** A failed menu action in plain words. The computer's own words stay there: only a code crosses the wire. */
export function plainThreadError(error: unknown): Error {
  const code = (error as { code?: unknown } | undefined)?.code
  switch (code) {
    case 'forbidden':
      return new Error('This phone may not change threads on the computer. Check its devices in Mousse there (Settings, Devices).')
    case 'stream_unknown':
      return new Error('This thread is gone from the computer.')
    case 'bad_request':
      return new Error('The computer didn’t accept this request.')
    case 'outcome_uncertain':
    case 'internal':
      return new Error('The computer couldn’t confirm this. Check the thread list, then try again.')
    case 'peer_offline':
    case 'route_unreachable':
    case 'deadline_exceeded':
    case 'unavailable':
    case 'offline':
      return new Error('Couldn’t reach the computer. Try again.')
  }
  return error instanceof Error ? error : new Error('The computer couldn’t do this.')
}

/** `threads.*` menu actions over a computer session. */
export class SessionThreadActions implements ThreadActions {
  private supported?: Promise<ThreadActionSupport>

  constructor(private readonly rpc: Rpc) {}

  support(): Promise<ThreadActionSupport> {
    this.supported ??= this.rpc('net.info', {}).then(
      (value) => {
        const methods = isObject(value) && Array.isArray(value.remote) ? new Set(value.remote.filter((entry) => typeof entry === 'string')) : undefined
        return methods ? { regenerateTitle: methods.has('threads.regenerateTitle'), expiry: methods.has('threads.setExpiry') } : NONE
      },
      // A computer from before net.info refuses it: it has neither.
      () => NONE,
    )
    return this.supported
  }

  private async call(method: string, params: Record<string, unknown>): Promise<void> {
    let value: unknown
    try {
      value = await this.rpc(method, params, { idem: crypto.randomUUID() })
    } catch (error) {
      throw plainThreadError(error)
    }
    if (isObject(value) && value.ok === false) throw new Error(typeof value.error === 'string' && value.error ? value.error : 'The computer refused the request.')
  }

  rename(threadId: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return Promise.reject(new Error('Write a name first.'))
    if (trimmed.length > THREAD_NAME_MAX) return Promise.reject(new Error(`A name can be at most ${THREAD_NAME_MAX} characters.`))
    return this.call('threads.rename', { threadId, name: trimmed })
  }

  pin(threadId: string, pinned: boolean): Promise<void> {
    return this.call('threads.pin', { threadId, pinned })
  }

  settle(threadId: string, settled: boolean): Promise<void> {
    return this.call('threads.settle', { threadId, settled })
  }

  regenerateTitle(threadId: string): Promise<void> {
    return this.call('threads.regenerateTitle', { threadId })
  }

  setExpiry(threadId: string, expiresAt: string | null, stopsRun: boolean): Promise<void> {
    return this.call('threads.setExpiry', { threadId, expiresAt, ...(expiresAt && stopsRun ? { stopsRun: true } : {}) })
  }
}
