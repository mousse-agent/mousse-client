import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { QueuedMessage } from '../../connection/types'
import { canEditQueued, isOptimisticQueueItem, type ThreadQueue } from '../hooks/useThreadQueue'
import { ArrowDown, ArrowTurnForward, ArrowUp, Check, Image as ImageIcon, Loader2, Pencil, Trash2, X } from './icons'
import { QueueItemSheet } from './ComposerSheets'

/** Send now on the first message a compaction holds: it stops the compaction and sends with the full history. */
export function skipCompactionLabel(historyTokens?: number): string {
  const size = historyTokens ? ` ${historyTokens >= 1000 ? `${Math.round(historyTokens / 1000)}K` : historyTokens}` : ''
  return `Send now: skip compacting and keep the full${size} history`
}

/** Edit in place: a small editor where the bubble was. Save keeps the message's place in the queue. */
function QueuedEditor({ queue, item }: { queue: ThreadQueue; item: QueuedMessage }) {
  const edit = queue.editDraft!
  const ref = useRef<HTMLTextAreaElement>(null)
  // The message's text changed elsewhere after this edit started, and the draft has changes of its own.
  const changed = !edit.saving && item.content !== edit.base && edit.draft.trim() !== edit.base.trim()
  const canSave = !edit.saving && !changed && edit.draft.trim().length > 0
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [edit.draft])
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.focus({ preventScroll: true })
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])
  const save = () => { if (canSave) queue.saveEdit(item, edit.draft) }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); queue.closeEdit() }
  }
  return (
    <>
      <div className="m-queued__editor">
        <textarea
          ref={ref}
          rows={1}
          value={edit.draft}
          aria-label="Edit queued message"
          disabled={edit.saving}
          onChange={(event) => queue.updateEdit({ draft: event.target.value })}
          onKeyDown={onKeyDown}
        />
      </div>
      {changed && (
        <div className="m-queued__changed" role="alert">
          <span>Changed elsewhere</span>
          <button type="button" className="m-queued__text-btn" onClick={() => queue.updateEdit({ base: item.content, draft: item.content })}>Load new</button>
          <button type="button" className="m-queued__text-btn" onClick={() => queue.updateEdit({ base: item.content })}>Keep mine</button>
        </div>
      )}
      <div className="m-queued__line">
        <button type="button" className="m-queued__btn" aria-label="Cancel" onClick={queue.closeEdit}>
          <X size={16} />
        </button>
        <button type="button" className="m-queued__btn m-queued__btn--accent" aria-label="Save" disabled={!canSave} onClick={save}>
          {edit.saving ? <Loader2 size={16} className="m-speech-spin" /> : <Check size={16} />}
        </button>
      </div>
    </>
  )
}

/**
 * The thread's queued messages at the end of the conversation, as on the desktop: each one dimmed in the
 * place it will land, with its full text. The line under each bubble (always shown: a phone has no
 * hover) moves it up or down, sends it now, edits it in place or removes it; a long press opens the
 * same actions in a sheet. One quiet "Queued" on the last line speaks for the group.
 */
export function QueuedMessages({ queue }: { queue: ThreadQueue }) {
  const { items, busyIds, hold, editDraft } = queue
  const [menu, setMenu] = useState<QueuedMessage>()
  const press = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(press.current), [])
  if (items.length === 0) return null
  const movable = items.filter((item) => !isOptimisticQueueItem(item))
  const firstHeld = movable.find((item) => item.state === 'pending')?.id
  const menuIndex = menu ? movable.findIndex((item) => item.id === menu.id) : -1
  const openMenu = (item: QueuedMessage) => { if (!isOptimisticQueueItem(item) && editDraft?.itemId !== item.id) setMenu(item) }

  return (
    <section className="m-queued" aria-label="Queued messages">
      {items.map((item, index) => {
        const optimistic = isOptimisticQueueItem(item)
        const busy = optimistic || busyIds.has(item.id)
        const last = index === items.length - 1
        const editing = editDraft?.itemId === item.id
        const at = movable.indexOf(item)
        // A pending steer item is the running reply's to take; it cannot be sent now.
        const fixed = item.intent === 'steer'
        const skipsCompaction = hold !== null && item.id === firstHeld
        const sendLabel = fixed ? 'Sent into the running reply' : skipsCompaction ? skipCompactionLabel(hold?.historyTokens) : 'Send now'
        const label = last && (
          <span className="m-queued__state" data-held={hold ? '' : undefined}>
            {hold && <Loader2 size={12} className="m-speech-spin" aria-hidden="true" />}
            {hold ? 'Queued · after compacting' : 'Queued'}
          </span>
        )
        return (
          <div key={item.id} className="m-queued__item" data-editing={editing || undefined} data-busy={busy || undefined}>
            {editing ? (
              <>
                <QueuedEditor queue={queue} item={item} />
                {label && <div className="m-queued__line m-queued__line--label">{label}</div>}
              </>
            ) : (
              <>
                <div
                  className="m-tl-user__bubble m-queued__bubble"
                  onContextMenu={(event) => { event.preventDefault(); openMenu(item) }}
                  onPointerDown={(event) => {
                    if (event.pointerType === 'mouse') return
                    clearTimeout(press.current)
                    press.current = setTimeout(() => openMenu(item), 500)
                  }}
                  onPointerUp={() => clearTimeout(press.current)}
                  onPointerCancel={() => clearTimeout(press.current)}
                  onPointerMove={() => clearTimeout(press.current)}
                >
                  {item.content}
                  {item.imageCount > 0 && (
                    <span className="m-queued__images" aria-label={`${item.imageCount} ${item.imageCount === 1 ? 'image' : 'images'}`}>
                      <ImageIcon size={13} />{item.imageCount}
                    </span>
                  )}
                </div>
                <div className="m-queued__line">
                  {movable.length > 1 && !optimistic && (
                    <>
                      <button type="button" className="m-queued__btn" aria-label="Move up" disabled={busy || at <= 0} onClick={() => queue.move(item.id, -1)}>
                        <ArrowUp size={16} />
                      </button>
                      <button type="button" className="m-queued__btn" aria-label="Move down" disabled={busy || at < 0 || at >= movable.length - 1} onClick={() => queue.move(item.id, 1)}>
                        <ArrowDown size={16} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="m-queued__btn m-queued__btn--accent"
                    aria-label={sendLabel}
                    disabled={busy || fixed}
                    onClick={() => queue.steer(item.id)}
                  >
                    <ArrowTurnForward size={16} />
                  </button>
                  {canEditQueued(item) && (
                    <button type="button" className="m-queued__btn" aria-label="Edit queued message" disabled={busy} onClick={() => queue.startEdit(item)}>
                      <Pencil size={16} />
                    </button>
                  )}
                  <button type="button" className="m-queued__btn" aria-label="Remove queued message" disabled={busy} onClick={() => queue.remove(item.id)}>
                    <Trash2 size={16} />
                  </button>
                  {label}
                </div>
              </>
            )}
          </div>
        )
      })}
      <QueueItemSheet
        item={menu}
        onClose={() => setMenu(undefined)}
        canSteer={!!menu && menu.intent !== 'steer'}
        isFirst={menuIndex <= 0}
        isLast={menuIndex === movable.length - 1}
        onSteer={(item) => queue.steer(item.id)}
        onEdit={(item) => { if (canEditQueued(item)) queue.startEdit(item) }}
        onMove={(item, delta) => queue.move(item.id, delta)}
        onRemove={(item) => queue.remove(item.id)}
      />
    </section>
  )
}
