import { memo, useState } from 'react'
import type { ChatItem } from '../../connection/types'
import { ChevronRight, CircleAlert, Wrench } from './icons'

function toolSummary(item: ChatItem): string {
  const first = item.text.split('\n').find((line) => line.trim()) ?? ''
  return first.length > 64 ? `${first.slice(0, 63)}…` : first
}

function ToolItem({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false)
  const running = item.status === 'streaming'
  return (
    <div className="m-tool" data-open={open || undefined} data-status={item.status}>
      <button type="button" className="m-tool__header" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Wrench size={17} className="m-tool__icon" />
        <span className={`m-tool__label${running ? ' m-shimmer' : ''}`}>{item.toolName ?? 'Tool'}</span>
        <span className="m-tool__detail">{toolSummary(item)}</span>
        <ChevronRight size={16} className="m-tool__chevron" />
      </button>
      {open && <pre className="m-tool__body">{item.text}</pre>}
    </div>
  )
}

export const ChatItemView = memo(function ChatItemView({ item }: { item: ChatItem }) {
  if (item.role === 'user') {
    return (
      <div className="m-msg m-msg--user" data-testid="chat-item" data-role="user">
        <div className="m-msg__bubble">{item.text}</div>
      </div>
    )
  }
  if (item.role === 'tool') return <div data-testid="chat-item" data-role="tool"><ToolItem item={item} /></div>
  if (item.role === 'system') {
    return <div className="m-msg m-msg--system" data-testid="chat-item" data-role="system">{item.text}</div>
  }
  const streaming = item.status === 'streaming'
  return (
    <div className="m-msg m-msg--assistant" data-testid="chat-item" data-role="assistant" data-status={item.status} aria-busy={streaming || undefined}>
      {item.text ? (
        <div className="m-msg__text">{item.text}{streaming && <span className="m-caret" aria-hidden="true" />}</div>
      ) : (
        <div className="m-msg__thinking m-shimmer">Thinking</div>
      )}
      {item.status === 'error' && <div className="m-msg__error"><CircleAlert size={15} /> The reply stopped with an error.</div>}
    </div>
  )
})
