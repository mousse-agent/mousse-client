// A thread's options on the phone: the desktop's thread menu (mousse/src/renderer/components/ThreadsContextMenu.tsx)
// as a bottom sheet, opened by pressing and holding a thread in the Threads or Projects tab. Each action goes to the
// computer that runs the thread; Delete stays on that computer, as it does for another computer on the desktop.
import { useEffect, useState, type ReactNode } from 'react'
import type { ListThread } from '../../connection/types'
import { THREAD_NAME_MAX, type ThreadActions, type ThreadActionSupport } from '../../connection/threadActions'
import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Clock, Pencil, Pin, PinOff, RefreshCw, Trash2 } from '../components/icons'
import { Button, Field, Notice, Spinner } from '../components/primitives'
import { Sheet } from '../components/Sheet'

/** The desktop's Delete after choices (mousse/src/shared/threadExpiry.ts EXPIRY_PRESETS). */
export const EXPIRY_PRESETS: readonly { id: string; label: string; ms: number }[] = [
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
]

/** "Deletes in 3 days": when an expiring thread goes, in the largest whole unit. */
export function expiresIn(expiresAt: string, now = Date.now()): string {
  const left = Date.parse(expiresAt) - now
  if (!Number.isFinite(left) || left <= 60_000) return 'Deletes in a minute'
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? '' : 's'}`
  const minutes = Math.round(left / 60_000)
  if (minutes < 60) return `Deletes in ${unit(minutes, 'minute')}`
  const hours = Math.round(left / 3_600_000)
  if (hours < 48) return `Deletes in ${unit(hours, 'hour')}`
  return `Deletes in ${unit(Math.round(left / 86_400_000), 'day')}`
}

/** What a finished action tells the screen behind the sheet: a line to show, and how to take it back. */
export interface ThreadOptionsResult {
  message: string
  undo?: () => void
}

export interface ThreadOptionsSheetProps {
  /** The thread, with its id on its own computer; the sheet is closed without one. */
  thread?: ListThread
  /** The computer that runs the thread. */
  computerName: string
  /** The phone lists several computers: the menu says which one it acts on. */
  showComputer?: boolean
  /** The computer's thread actions; absent while it cannot be reached. */
  actions?: ThreadActions
  /** Why the actions are off, such as the computer being offline. */
  unavailable?: string
  /** Shows a change on the list at once; returns how to put the row back if the computer refuses it. */
  showLocally(threadId: string, patch: Partial<Omit<ListThread, 'id'>>): () => void
  /** A change made after the sheet closed: the result to show, or the error. */
  onResult(result: ThreadOptionsResult | { error: string }): void
  onClose(): void
}

type View = 'menu' | 'rename' | 'expiry'

function OptionRow({ icon, title, detail, onClick, disabled, busy, danger, submenu }: {
  icon: ReactNode
  title: string
  detail?: string
  onClick?(): void
  disabled?: boolean
  busy?: boolean
  danger?: boolean
  submenu?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`m-option m-thread-option${danger ? ' m-thread-option--danger' : ''}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-haspopup={submenu ? 'menu' : undefined}
      onClick={onClick}
    >
      <span className="m-option__leading">{busy ? <Spinner size={16} /> : icon}</span>
      <span className="m-option__body">
        <span className="m-option__title">{title}</span>
        {detail && <span className="m-option__detail">{detail}</span>}
      </span>
      {submenu && <ChevronRight size={16} className="m-thread-option__chevron" aria-hidden="true" />}
    </button>
  )
}

const message = (error: unknown) => (error instanceof Error && error.message ? error.message : 'The computer couldn’t do this.')

export function ThreadOptionsSheet({ thread, computerName, showComputer = false, actions, unavailable, showLocally, onResult, onClose }: ThreadOptionsSheetProps) {
  const [view, setView] = useState<View>('menu')
  const [support, setSupport] = useState<ThreadActionSupport>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [name, setName] = useState('')
  const threadId = thread?.id

  // Each thread opens on its menu, with nothing left over from the last one.
  useEffect(() => {
    setView('menu')
    setBusy(undefined)
    setError(undefined)
  }, [threadId])

  useEffect(() => {
    let live = true
    setSupport(undefined)
    if (actions) void actions.support().then((value) => { if (live) setSupport(value) })
    return () => { live = false }
  }, [actions])

  if (!thread) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>
  const off = !actions || !!unavailable
  const close = () => { if (!busy) onClose() }

  /** Pin and archive close the menu at once, as on the desktop; the row changes now and comes back if refused. */
  const quick = (patch: Partial<ListThread>, run: (actions: ThreadActions) => Promise<void>, done?: ThreadOptionsResult) => {
    if (!actions) return
    const restore = showLocally(thread.id, patch)
    onClose()
    run(actions).then(
      () => { if (done) onResult(done) },
      (failure: unknown) => { restore(); onResult({ error: message(failure) }) },
    )
  }
  /** Rename, regenerate and the expiry stay open with the row busy, and say why they failed in the sheet. */
  const inSheet = async (key: string, run: (actions: ThreadActions) => Promise<void>, after?: () => void) => {
    if (!actions || busy) return
    setBusy(key)
    setError(undefined)
    try {
      await run(actions)
      after?.()
      setBusy(undefined)
      onClose()
    } catch (failure) {
      setBusy(undefined)
      setError(message(failure))
    }
  }

  const togglePin = () => quick({ pinned: !thread.pinned }, (a) => a.pin(thread.id, !thread.pinned))
  const toggleArchive = () => {
    const settled = !thread.settled
    quick(
      { settled },
      (a) => a.settle(thread.id, settled),
      settled ? { message: `Archived “${thread.title}”.`, undo: () => void actions?.settle(thread.id, false).catch((failure: unknown) => onResult({ error: message(failure) })) } : undefined,
    )
  }
  const submitRename = () => {
    const next = name.trim()
    if (!next || next === thread.title) {
      if (next === thread.title) onClose()
      else setError('Write a name first.')
      return
    }
    void inSheet('rename', (a) => a.rename(thread.id, next), () => showLocally(thread.id, { title: next }))
  }
  const setExpiry = (ms: number | null) => {
    const at = ms === null ? null : new Date(Date.now() + ms).toISOString()
    void inSheet(`expiry:${ms}`, (a) => a.setExpiry(thread.id, at, thread.expiryStopsRun === true), () =>
      showLocally(thread.id, at ? { expiresAt: at } : { expiresAt: undefined, expiryStopsRun: undefined }),
    )
  }

  let body: ReactNode
  if (view === 'rename') {
    body = (
      <form className="m-form m-thread-rename" onSubmit={(event) => { event.preventDefault(); submitRename() }}>
        <Field label="Name">
          <input
            className="m-input"
            autoFocus
            value={name}
            maxLength={THREAD_NAME_MAX}
            enterKeyHint="done"
            disabled={!!busy}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {error && <Notice>{error}</Notice>}
        <div className="m-sheet__actions">
          <Button type="submit" variant="primary" disabled={!!busy || !name.trim()}>{busy ? <><Spinner size={14} /> Saving…</> : 'Save'}</Button>
          <Button variant="ghost" disabled={!!busy} onClick={() => { setView('menu'); setError(undefined) }}>Cancel</Button>
        </div>
      </form>
    )
  } else if (view === 'expiry') {
    body = (
      <div className="m-options" role="menu" aria-label="Delete after">
        <OptionRow icon={<ChevronLeft size={16} />} title="Delete after" detail="Back to the thread's options" disabled={!!busy} onClick={() => { setView('menu'); setError(undefined) }} />
        {thread.expiresAt && <p className="m-sheet__lead">{expiresIn(thread.expiresAt)}. Its subagent threads go with it.</p>}
        {EXPIRY_PRESETS.map((preset) => (
          <OptionRow key={preset.id} icon={<Clock size={16} />} title={`After ${preset.label}`} busy={busy === `expiry:${preset.ms}`} disabled={!!busy} onClick={() => setExpiry(preset.ms)} />
        ))}
        {thread.expiresAt && <OptionRow icon={<Clock size={16} />} title="Keep it" busy={busy === 'expiry:null'} disabled={!!busy} onClick={() => setExpiry(null)} />}
        {error && <Notice>{error}</Notice>}
      </div>
    )
  } else {
    body = (
      <div className="m-options" role="menu" aria-label={`Thread ${thread.title}`}>
        {showComputer && <p className="m-options__heading">On {computerName}</p>}
        {unavailable && <Notice tone="info">{unavailable}</Notice>}
        {!thread.settled && (
          <OptionRow icon={thread.pinned ? <PinOff size={16} /> : <Pin size={16} />} title={thread.pinned ? 'Unpin' : 'Pin'} disabled={off || !!busy} onClick={togglePin} />
        )}
        <OptionRow icon={thread.settled ? <ArchiveRestore size={16} /> : <Archive size={16} />} title={thread.settled ? 'Unarchive' : 'Archive'} disabled={off || !!busy} onClick={toggleArchive} />
        {support?.regenerateTitle && (
          <OptionRow
            icon={<RefreshCw size={16} />}
            title={busy === 'title' ? 'Writing a new title…' : 'Regenerate title'}
            busy={busy === 'title'}
            disabled={off || !!busy}
            onClick={() => void inSheet('title', (a) => a.regenerateTitle(thread.id))}
          />
        )}
        <OptionRow icon={<Pencil size={16} />} title="Rename" disabled={off || !!busy} onClick={() => { setName(thread.title); setError(undefined); setView('rename') }} />
        {support?.expiry && !thread.settled && (
          <OptionRow
            icon={<Clock size={16} />}
            title="Delete after"
            {...(thread.expiresAt ? { detail: expiresIn(thread.expiresAt) } : {})}
            submenu
            disabled={off || !!busy}
            onClick={() => { setError(undefined); setView('expiry') }}
          />
        )}
        {/* Deleting is permanent and stays on the thread's computer, as for another computer's thread on the desktop. */}
        {thread.settled && <OptionRow icon={<Trash2 size={16} />} title="Delete…" detail={`Delete it in Mousse on ${computerName}`} danger disabled />}
        {error && <Notice>{error}</Notice>}
      </div>
    )
  }

  return (
    <Sheet open title={thread.title} onClose={close} dismissible={!busy}>
      {body}
    </Sheet>
  )
}
