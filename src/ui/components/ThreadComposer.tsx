import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComposerOptions, ComputerSession, ContextUsage, ModelSelection, PermissionMode, SendOptions } from '../../connection/types'
import type { ThreadState } from '../hooks/useThread'
import type { ThreadQueue } from '../hooks/useThreadQueue'
import { errorMessage } from '../hooks/useAsync'
import { useRouter } from '../state/router'
import { loadFavorites, loadSendMode, saveFavorites, saveSendMode, type SendMode } from '../lib/composerPrefs'
import { Composer, type ComposerControls } from './Composer'
import { shownPermission } from './ComposerSheets'
import { Notice } from './primitives'

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
 * A computer without these controls (an older Mousse) still gets a working text composer. The queued
 * messages themselves show at the end of the conversation (QueuedMessages).
 */
export function ThreadComposer({ session, threadId, thread, queue, addition, computerName }: { session: ComputerSession; threadId: string; thread: ThreadState; queue: ThreadQueue; addition?: { text: string; key: number }; computerName?: string }) {
  const router = useRouter()
  const [options, setOptions] = useState<ComposerOptions>()
  const [model, setModel] = useState<ModelSelection>()
  const [projectId, setProjectId] = useState<string>()
  const [permissionMode, setPermissionMode] = useState<PermissionMode>()
  const [favorites, setFavorites] = useState(() => loadFavorites(session.nodeId))
  const [usage, setUsage] = useState<ContextUsage>()
  const [error, setError] = useState<string>()
  const [prefill, setPrefill] = useState<{ text: string; key: number; append?: boolean }>()
  const sendModeKey = `${session.nodeId}.${threadId}`
  const [sendMode, setSendMode] = useState<SendMode>(() => loadSendMode(sendModeKey))
  useEffect(() => setSendMode(loadSendMode(sendModeKey)), [sendModeKey])
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

  const refreshUsage = useCallback(() => {
    session.contextUsage(threadId).then((value) => { if (alive.current && value) setUsage(value) }, () => undefined)
  }, [session, threadId])

  // The context grows as turns run: read it on open, when a turn starts or ends, and regularly while
  // one runs (as the desktop polls its context ring).
  useEffect(() => {
    if (!options) return undefined
    refreshUsage()
    if (!active) return undefined
    const usageTimer = setInterval(refreshUsage, USAGE_POLL_MS)
    return () => clearInterval(usageTimer)
  }, [options, active, refreshUsage])

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
      queue.refresh()
    }
  }

  const send = async (text: string, extras: SendOptions): Promise<boolean> => {
    // Like the desktop, a message written while a turn runs, or while messages already wait, goes to the
    // thread's queue (and shows there at once), so it never runs ahead of them.
    if ((active || queue.items.length > 0) && options) {
      setError(undefined)
      return queue.enqueue(text, () => session.enqueue(threadId, text, extras))
    }
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
      <Composer
        active={active}
        draftKey={`${session.nodeId}.${threadId}`}
        prefill={prefill}
        controls={controls}
        speech={session.speech}
        onSend={send}
        onStop={() => void thread.stop()}
        onSteer={(text) => attempt(() => session.steer(threadId, text))}
        sendMode={options ? { mode: sendMode, onSwitch: () => { const next = sendMode === 'steer' ? 'queue' : 'steer'; setSendMode(next); saveSendMode(sendModeKey, next) } } : undefined}
        onNewThread={newThread}
      />
    </>
  )
}
