import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatItem, ComputerSession, SendOptions } from '../../connection/types'
import { errorMessage } from './useAsync'

export interface ThreadState {
  items: ChatItem[]
  loading: boolean
  error: string | undefined
  /** True while the computer is working on a turn in this thread. */
  active: boolean
  sending: boolean
  send(text: string, options?: SendOptions): Promise<boolean>
  stop(): Promise<void>
}

/**
 * Subscribes to one thread. A turn counts as active when we have just sent a
 * message (optimistic), when any item is still streaming, or when the session
 * says so. The session is asked again shortly after items settle.
 */
export function useThread(session: ComputerSession | undefined, threadId: string): ThreadState {
  const [items, setItems] = useState<ChatItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [remoteActive, setRemoteActive] = useState(false)
  const [pending, setPending] = useState(false)
  const [sending, setSending] = useState(false)
  const recheck = useRef<ReturnType<typeof setTimeout>>()
  /** Number of items present when the last message was sent. */
  const baseline = useRef<number | null>(null)
  const alive = useRef(true)

  const askActive = useCallback((delay: number) => {
    if (!session) return
    clearTimeout(recheck.current)
    recheck.current = setTimeout(() => {
      session.isTurnActive(threadId).then((value) => { if (alive.current) setRemoteActive(value) }, () => undefined)
    }, delay)
  }, [session, threadId])

  useEffect(() => {
    alive.current = true
    if (!session) return
    let unsubscribe: (() => void) | undefined
    let cancelled = false
    setLoading(true)
    setError(undefined)
    setItems([])
    session.openThread(threadId, (next) => {
      if (cancelled) return
      setItems(next)
      setLoading(false)
      // The optimistic flag ends once the computer answers with anything.
      if (baseline.current !== null && next.slice(baseline.current).some((item) => item.role !== 'user')) {
        baseline.current = null
        setPending(false)
      }
      askActive(300)
    }).then((unsub) => {
      if (cancelled) unsub()
      else { unsubscribe = unsub; setLoading(false) }
    }, (cause) => { if (!cancelled) { setError(errorMessage(cause)); setLoading(false) } })
    askActive(0)
    return () => {
      cancelled = true
      alive.current = false
      clearTimeout(recheck.current)
      unsubscribe?.()
    }
  }, [session, threadId, askActive])

  const itemCount = useRef(0)
  itemCount.current = items.length
  const streaming = items.some((item) => item.status === 'streaming')
  const active = pending || streaming || remoteActive

  const send = useCallback(async (text: string, options?: SendOptions) => {
    const trimmed = text.trim()
    if (!session || !trimmed) return false
    setSending(true)
    setError(undefined)
    setPending(true)
    baseline.current = itemCount.current
    try {
      await session.send(threadId, trimmed, options)
      return true
    } catch (cause) {
      setPending(false)
      baseline.current = null
      setError(errorMessage(cause))
      return false
    } finally {
      if (alive.current) setSending(false)
    }
  }, [session, threadId])

  const stop = useCallback(async () => {
    if (!session) return
    try {
      await session.abort(threadId)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
      baseline.current = null
      setRemoteActive(false)
      askActive(300)
    }
  }, [session, threadId, askActive])

  return { items, loading, error, active, sending, send, stop }
}
