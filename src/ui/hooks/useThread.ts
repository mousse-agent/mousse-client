import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ChatItem, ComputerSession, QuestionAnswers, SendOptions, ThreadDisplayState } from '../../connection/types'
import { errorMessage } from './useAsync'

export interface ThreadState {
  items: ChatItem[]
  loading: boolean
  error: string | undefined
  /** True while the computer is working on a turn in this thread. */
  active: boolean
  sending: boolean
  /** Turn phase, pending questions and provider failures, when the computer reports them. */
  display: ThreadDisplayState
  send(text: string, options?: SendOptions): Promise<boolean>
  stop(): Promise<void>
  /** Answers pending questions; undefined when this computer cannot take answers from the phone. */
  answer?: (requestId: string, answers: QuestionAnswers) => Promise<void>
  dismiss?: (requestId: string) => Promise<void>
  /** Shows the page of messages before the oldest one shown, when `display.earlier` is loadable. */
  loadEarlier?: () => Promise<void>
  /** True while a page of older messages is on its way. */
  loadingEarlier: boolean
}

const NO_DISPLAY: ThreadDisplayState = { questions: [] }
const WORKING_PHASES = new Set(['queued', 'thinking', 'streaming', 'tool_running', 'finalizing'])

/** An older computer refuses the answer methods; say where to answer instead. */
function questionError(cause: unknown): string {
  const code = (cause as { code?: unknown } | undefined)?.code
  if (code === 'forbidden' || code === 'not_found' || code === 'unknown_method')
    return 'This computer does not take answers from the phone yet. Answer on the computer.'
  return errorMessage(cause)
}

/**
 * Subscribes to one thread. A turn counts as active when we have just sent a
 * message (optimistic), when any item is still streaming, or when the session
 * says so. The session is asked again shortly after items settle.
 */
export function useThread(session: ComputerSession | undefined, threadId: string): ThreadState {
  const [items, setItems] = useState<ChatItem[]>([])
  const [display, setDisplay] = useState<ThreadDisplayState>(NO_DISPLAY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [remoteActive, setRemoteActive] = useState(false)
  const [pending, setPending] = useState(false)
  const [sending, setSending] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const earlierRead = useRef<Promise<void>>()
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

  // A layout effect: a thread the session holds in memory draws on the first frame, with no spinner.
  useLayoutEffect(() => {
    alive.current = true
    if (!session) return
    let unsubscribe: (() => void) | undefined
    let cancelled = false
    setLoading(true)
    setError(undefined)
    setItems([])
    setDisplay(NO_DISPLAY)
    session.openThread(threadId, (next, state) => {
      if (cancelled) return
      setItems(next)
      if (state) setDisplay(state)
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
  const working = display.phase !== undefined && WORKING_PHASES.has(display.phase)
  const active = pending || streaming || remoteActive || working

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

  const answer = useCallback(async (requestId: string, answers: QuestionAnswers) => {
    if (!session?.answerQuestions) return
    setError(undefined)
    try {
      if (!(await session.answerQuestions(threadId, requestId, answers))) setError('These questions were already answered or expired.')
    } catch (cause) {
      setError(questionError(cause))
    }
  }, [session, threadId])
  const dismiss = useCallback(async (requestId: string) => {
    if (!session?.dismissQuestions) return
    setError(undefined)
    try {
      await session.dismissQuestions(threadId, requestId)
    } catch (cause) {
      setError(questionError(cause))
    }
  }, [session, threadId])

  const loadEarlier = useCallback((): Promise<void> => {
    if (!session?.loadEarlier) return Promise.resolve()
    if (earlierRead.current) return earlierRead.current
    setLoadingEarlier(true)
    const read = session.loadEarlier(threadId)
      .catch((cause: unknown) => { if (alive.current) setError(errorMessage(cause)) })
      .finally(() => {
        earlierRead.current = undefined
        if (alive.current) setLoadingEarlier(false)
      })
    earlierRead.current = read
    return read
  }, [session, threadId])

  return {
    items,
    loading,
    error,
    active,
    sending,
    display,
    send,
    stop,
    loadingEarlier,
    ...(session?.loadEarlier ? { loadEarlier } : {}),
    ...(session?.answerQuestions ? { answer } : {}),
    ...(session?.dismissQuestions ? { dismiss } : {}),
  }
}
