import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComputerSession, QueuedMessage } from '../../connection/types'
import { errorMessage } from './useAsync'

const QUEUE_POLL_MS = 4_000

/** An open edit of a queued message: the text it started from (a save expects the message still has it) and the draft. */
export interface QueueEditDraft {
  itemId: string
  base: string
  draft: string
  saving?: boolean
}

/** What holds the queue: a compaction that runs now. Send now on the first message skips it. */
export interface QueueHold {
  historyTokens?: number
}

export interface ThreadQueue {
  /** The messages waiting, in order; one still on its way to the computer shows last, busy. */
  items: QueuedMessage[]
  busyIds: ReadonlySet<string>
  error?: string
  clearError(): void
  hold: QueueHold | null
  editDraft?: QueueEditDraft
  refresh(): void
  /** Queues through `work`, with the text shown last in the queue until the computer lists it. */
  enqueue(text: string, work: () => Promise<unknown>): Promise<boolean>
  /** Sends the message into the running reply now (or starts it when nothing runs); it leaves the list at once. */
  steer(itemId: string): void
  remove(itemId: string): void
  move(itemId: string, delta: -1 | 1): void
  startEdit(item: QueuedMessage): void
  updateEdit(patch: Partial<Omit<QueueEditDraft, 'itemId'>>): void
  closeEdit(): void
  /** Saves the edit in place; text changed elsewhere meanwhile keeps the editor open with the draft. */
  saveEdit(item: QueuedMessage, text: string): void
}

export const isOptimisticQueueItem = (item: QueuedMessage): boolean => item.id.startsWith('optimistic:')

/** Whether the queue lets this item's text change: a pending message a person wrote. */
export function canEditQueued(item: QueuedMessage): boolean {
  return !isOptimisticQueueItem(item) && item.state === 'pending' && item.intent !== 'steer'
}

/** Open edits by thread, so a visit to another thread and back keeps the editor and its draft. */
const openEdits = new Map<string, QueueEditDraft>()

/**
 * The thread's message queue on the computer, as the desktop's useThreadQueue: read on open, when a
 * turn starts or ends, and every few seconds while a turn runs or messages wait.
 */
export function useThreadQueue(session: ComputerSession, threadId: string, active: boolean, hold: QueueHold | null = null): ThreadQueue {
  const editKey = `${session.nodeId}.${threadId}`
  const [listed, setListed] = useState<QueuedMessage[]>([])
  const [optimistic, setOptimistic] = useState<QueuedMessage[]>([])
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string>()
  const [editDraft, setEditDraft] = useState<QueueEditDraft | undefined>(() => openEdits.get(editKey))
  const alive = useRef(true)
  const generation = useRef(0)

  useEffect(() => {
    alive.current = true
    setListed([])
    setOptimistic([])
    setHidden(new Set())
    setBusyIds(new Set())
    setError(undefined)
    setEditDraft(openEdits.get(editKey))
    return () => { alive.current = false; generation.current++ }
  }, [session, threadId, editKey])

  const refresh = useCallback(() => {
    const asked = generation.current
    session.listQueue(threadId).then((items) => {
      if (!alive.current || asked !== generation.current) return
      setListed(items)
      // A message sent now that the computer still lists stays hidden only while that call runs.
      setHidden((current) => current.size ? new Set([...current].filter((id) => items.some((item) => item.id === id))) : current)
    }, () => undefined)
  }, [session, threadId])

  const waiting = listed.length > 0 || optimistic.length > 0
  useEffect(() => {
    refresh()
    if (!active && !waiting) return undefined
    const timer = setInterval(refresh, QUEUE_POLL_MS)
    return () => clearInterval(timer)
  }, [active, waiting, refresh])

  const setEdit = useCallback((next: QueueEditDraft | undefined) => {
    if (next) openEdits.set(editKey, next)
    else openEdits.delete(editKey)
    setEditDraft(next)
  }, [editKey])

  // The edited message left the queue (it started, or was removed elsewhere): the editor closes.
  useEffect(() => {
    if (editDraft && !editDraft.saving && listed.length && !listed.some((item) => item.id === editDraft.itemId)) setEdit(undefined)
  }, [listed, editDraft, setEdit])

  const markBusy = (id: string, busy: boolean) => setBusyIds((current) => {
    const next = new Set(current)
    if (busy) next.add(id)
    else next.delete(id)
    return next
  })

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setError(undefined)
    try {
      await work()
      return true
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause))
      return false
    } finally {
      if (alive.current) refresh()
    }
  }

  const enqueue = async (text: string, work: () => Promise<unknown>) => {
    const item: QueuedMessage = { id: `optimistic:${crypto.randomUUID()}`, content: text, imageCount: 0, enqueuedAt: Date.now(), intent: 'normal', state: 'pending' }
    setOptimistic((current) => [...current, item])
    try {
      return await run(work)
    } finally {
      // Dropped once the list that has the message is read (a moment later), never before.
      const asked = generation.current
      session.listQueue(threadId).then((items) => {
        if (!alive.current || asked !== generation.current) return
        setListed(items)
        setOptimistic((current) => current.filter((entry) => entry.id !== item.id))
      }, () => { if (alive.current) setOptimistic((current) => current.filter((entry) => entry.id !== item.id)) })
    }
  }

  const steer = (itemId: string) => {
    // A second tap while the first is on its way sends nothing more.
    if (busyIds.has(itemId)) return
    markBusy(itemId, true)
    setHidden((current) => new Set(current).add(itemId))
    void run(() => session.steerQueued(threadId, itemId)).then((ok) => {
      if (!alive.current) return
      markBusy(itemId, false)
      if (!ok) setHidden((current) => { const next = new Set(current); next.delete(itemId); return next })
    })
  }

  const remove = (itemId: string) => {
    if (busyIds.has(itemId)) return
    markBusy(itemId, true)
    setHidden((current) => new Set(current).add(itemId))
    void run(() => session.removeQueued(threadId, itemId)).then((ok) => {
      if (!alive.current) return
      markBusy(itemId, false)
      if (!ok) setHidden((current) => { const next = new Set(current); next.delete(itemId); return next })
    })
  }

  const move = (itemId: string, delta: -1 | 1) => {
    const ids = listed.map((entry) => entry.id)
    const from = ids.indexOf(itemId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    setListed(ids.map((id) => listed.find((entry) => entry.id === id)!))
    void run(() => session.reorderQueue(threadId, ids))
  }

  const saveEdit = (item: QueuedMessage, text: string) => {
    const draft = editDraft
    if (!draft || draft.itemId !== item.id) return
    if (text.trim() === item.content.trim()) { setEdit(undefined); return }
    setEdit({ ...draft, saving: true })
    setError(undefined)
    session.editQueued(threadId, item.id, text, draft.base).then((result) => {
      if (!alive.current) return
      setListed((current) => current.map((entry) => (entry.id === item.id ? result.item : entry)))
      if (result.changed) {
        // Changed elsewhere: a draft with no changes of its own follows the new text; otherwise it is kept.
        const untouched = draft.draft.trim() === draft.base.trim()
        setEdit(untouched ? { itemId: item.id, base: result.item.content, draft: result.item.content } : { ...draft, saving: false })
        return
      }
      setEdit(undefined)
      refresh()
    }, (cause) => {
      if (!alive.current) return
      setError(errorMessage(cause))
      setEdit({ ...draft, saving: false })
      refresh()
    })
  }

  const items = useMemo(() => [...listed.filter((item) => !hidden.has(item.id)), ...optimistic], [listed, hidden, optimistic])

  return {
    items,
    busyIds,
    error,
    clearError: () => setError(undefined),
    hold,
    editDraft,
    refresh,
    enqueue,
    steer,
    remove,
    move,
    startEdit: (item) => setEdit({ itemId: item.id, base: item.content, draft: item.content }),
    updateEdit: (patch) => { if (editDraft) setEdit({ ...editDraft, ...patch }) },
    closeEdit: () => setEdit(undefined),
    saveEdit,
  }
}
