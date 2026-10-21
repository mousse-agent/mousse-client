import { useState } from 'react'
import type { QueuedMessage } from '../../connection/types'
import { Image as ImageIcon, MoreHorizontal, Steer } from './icons'
import { QueueItemSheet } from './ComposerSheets'

/** Messages waiting for the current turn to end, as in the desktop's queue above the composer. */
export function QueuedMessages({ items, canSteer, onSteer, onEdit, onRemove, onMove }: {
  items: QueuedMessage[]
  canSteer: boolean
  onSteer(item: QueuedMessage): void
  onEdit(item: QueuedMessage): void
  onRemove(item: QueuedMessage): void
  onMove(item: QueuedMessage, delta: -1 | 1): void
}) {
  const [open, setOpen] = useState<QueuedMessage>()
  const index = open ? items.findIndex((item) => item.id === open.id) : -1
  return (
    <section className="m-queue" aria-label="Queued messages">
      <h3 className="m-queue__heading">Queued · {items.length}</h3>
      <ul>
        {items.map((item) => (
          <li key={item.id} className="m-queue__item" data-intent={item.intent}>
            <span className="m-queue__text">{item.content}</span>
            {item.imageCount > 0 && <span className="m-queue__badge" aria-label={`${item.imageCount} images`}><ImageIcon size={13} />{item.imageCount}</span>}
            {canSteer && item.intent !== 'steer' && (
              <button type="button" className="m-composer__icon" aria-label="Steer into the current turn" onClick={() => onSteer(item)}>
                <Steer size={16} />
              </button>
            )}
            <button type="button" className="m-composer__icon" aria-label="Queued message actions" onClick={() => setOpen(item)}>
              <MoreHorizontal size={16} />
            </button>
          </li>
        ))}
      </ul>
      <QueueItemSheet
        item={open}
        onClose={() => setOpen(undefined)}
        canSteer={canSteer}
        isFirst={index === 0}
        isLast={index === items.length - 1}
        onSteer={onSteer}
        onEdit={onEdit}
        onMove={onMove}
        onRemove={onRemove}
      />
    </section>
  )
}
