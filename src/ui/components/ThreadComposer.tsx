import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComposerOptions, ComputerSession, ContextUsage, ModelSelection, PermissionMode, QueuedMessage, SendOptions } from '../../connection/types'
import type { ThreadState } from '../hooks/useThread'
import { errorMessage } from '../hooks/useAsync'
import { useRouter } from '../state/router'
import { loadFavorites, saveFavorites } from '../lib/composerPrefs'
import { Composer, type ComposerControls } from './Composer'
import { QueuedMessages } from './QueuedMessages'
import { shownPermission } from './ComposerSheets'
import { Notice } from './primitives'

const QUEUE_POLL_MS = 4_000
const USAGE_POLL_MS = 5_000

/** Options are per computer; reuse them across threads of one session. */
const optionsCache = new WeakMap<ComputerSession, Promise<ComposerOptions>>()

function composerOptions(session: ComputerSession, threadId: string): Promise<ComposerOptions> {
  let pending = optionsCache.get(session)
  if (!pending) {
    pending = session.composerOptions(threadId)
    optionsCache.set(session, pending)
    pending.catch(() => { if (optionsCache.get(session) === pending) optionsCache.delete(session) })
  }
  return pending
}

/**
 * The thread's composer with the computer's controls: model and effort (stored on the thread, so
 * every device sees the same choice), mode, skills, slash commands, images, the queue and context.
 * A computer without these controls (an older Mousse) still gets a working text composer.
 */
export function ThreadComposer({ session, threadId, thread, addition, computerName }: { session: ComputerSession; threadId: string; thread: ThreadState; addition?: { text: string; key: number }; computerName?: string }) {
  const router = useRouter()
  const [options, setOptions] = useState<ComposerOptions>()
  const [model, setModel] = useState<ModelSelection>()
  const [projectId, setProjectId] = useState<string>()
  const [permissionMode, setPermissionMode] = useState<PermissionMode>()
  const [favorites, setFavorites] = useState(() => loadFavorites(session.nodeId))
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [usage, setUsage] = useState<ContextUsage>()
  const [error, setError] = useState<string>()
  const [prefill, setPrefill] = useState<{ text: string; key: number; append?: boolean }>()
  useEffect(() => {
    if (addition) setPrefill({ ...addition, append: true })
  }, [addition])
  const alive = useRef(true)
  const { active } = thread

  useEffect(() => {
    alive.current = true
    let cancelled = false
    setModel(undefined)
    setPermissionMode(undefined)
    setQueue([])
    setUsage(undefined)
    setError(undefined)
    composerOptions(session, threadId).then((value) => { if (!cancelled) setOptions(value) }, () => undefined)
    session.getThread(threadId).then((details) => {
      if (cancelled) return
      setModel(details.model)
      setProjectId(details.projectId)
      setPermissionMode(details.permissionMode)
    }, () => undefined)
    return () => { cancelled = true; alive.current = false }
  }, [session, threadId])

  const refreshQueue = useCallback(() => {
    session.listQueue(threadId).then((items) => { if (alive.current) setQueue(items) }, () => undefined)
  }, [session, threadId])

  const refreshUsage = useCallback(() => {
    session.contextUsage(threadId).then((value) => { if (alive.current && value) setUsage(value) }, () => undefined)
  }, [session, threadId])

  // The queue drains and the context grows as turns run: read both on open, when a turn starts or
  // ends, and regularly while one runs (as the desktop polls its context ring).
  useEffect(() => {
    if (!options) return undefined
    refreshQueue()
    refreshUsage()
    if (!active && queue.length === 0) return undefined
    const queueTimer = setInterval(refreshQueue, QUEUE_POLL_MS)
    const usageTimer = active ? setInterval(refreshUsage, USAGE_POLL_MS) : undefined
    return () => { clearInterval(queueTimer); clearInterval(usageTimer) }
    // queue.length: keep polling while messages wait, stop once it is empty.
  }, [options, active, queue.length > 0, refreshQueue, refreshUsage]) // eslint-disable-line react-hooks/exhaustive-deps

  const selection = model ?? options?.defaultModel
  const providerId = useMemo(() => {
    if (!selection || !options) return selection?.llmProvider
    // A stored selection names the instance; the menus group by provider id.
    return options.providers.find((provider) => selection.instanceId && provider.instanceId === selection.instanceId)?.id ?? selection.llmProvider
  }, [selection, options])

  const selectModel = useCallback((nextProvider: string, modelId: string) => {
    const provider = options?.providers.find((entry) => entry.id === nextProvider)
    const next: ModelSelection = { ...(provider?.instanceId ? { instanceId: provider.instanceId } : {}), llmProvider: nextProvider, model: modelId }
    const previous = model
    setModel(next)
    session.setThreadModel(threadId, next).then(() => refreshUsage(), (cause) => {
      if (!alive.current) return
      setModel(previous)
      setError(errorMessage(cause))
    })
  }, [options, model, session, threadId, refreshUsage])

  const controls: ComposerControls | undefined = options && {
    providers: options.providers,
    providerId,
    modelId: selection?.model,
    onSelectModel: selectModel,
    permission: shownPermission(options.permission, permissionMode, computerName),
    skills: options.skills,
    commands: options.commands,
    usage,
    favorites,
    onToggleFavorite: (key) => setFavorites((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveFavorites(session.nodeId, next)
      return next
    })
  }

  const attempt = async (work: () => Promise<unknown>): Promise<boolean> => {
    setError(undefined)
    try {
      await work()
      return true
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause))
      return false
    } finally {
      refreshQueue()
    }
  }

  const send = async (text: string, extras: SendOptions): Promise<boolean> => {
    // Like the desktop, a message written while a turn runs waits in the thread's queue.
    if (active && options) return attempt(() => session.enqueue(threadId, text, extras))
    return thread.send(text, extras)
  }

  const newThread = (title: string) => {
    void attempt(async () => {
      const created = await session.createThread({ projectId: projectId ?? '', ...(title ? { title } : {}) })
      router.replace({ name: 'thread', nodeId: session.nodeId, threadId: created.id })
    })
  }

  return (
    <>
      {error && <Notice>{error}</Notice>}
      {queue.length > 0 && (
        <QueuedMessages
          items={queue}
          canSteer={active}
          onSteer={(item) => void attempt(() => session.steerQueued(threadId, item.id))}
          onRemove={(item) => void attempt(() => session.removeQueued(threadId, item.id))}
          onEdit={(item) => void attempt(async () => {
            await session.removeQueued(threadId, item.id)
            setPrefill({ text: item.content, key: Date.now() })
          })}
          onMove={(item, delta) => {
            const ids = queue.map((entry) => entry.id)
            const from = ids.indexOf(item.id)
            const to = from + delta
            if (from < 0 || to < 0 || to >= ids.length) return
            ids.splice(to, 0, ...ids.splice(from, 1))
            setQueue(ids.map((id) => queue.find((entry) => entry.id === id)!))
            void attempt(() => session.reorderQueue(threadId, ids))
          }}
        />
      )}
      <Composer
        active={active}
        draftKey={`${session.nodeId}.${threadId}`}
        prefill={prefill}
        controls={controls}
        speech={session.speech}
        onSend={send}
        onStop={() => void thread.stop()}
        onSteer={(text) => attempt(() => session.steer(threadId, text))}
        onNewThread={newThread}
      />
    </>
  )
}
