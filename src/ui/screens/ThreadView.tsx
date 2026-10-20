import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ComputerSession } from '../../connection/types'
import { useThread } from '../hooks/useThread'
import { ChatItemView } from '../components/ChatItemView'
import { Composer } from '../components/Composer'
import { EmptyState } from '../components/EmptyState'
import { Notice, Spinner } from '../components/primitives'

export interface ThreadViewProps {
  session: ComputerSession
  threadId: string
  /** Called when a turn starts or ends so lists can refresh their indicators. */
  onActivityChange?(active: boolean): void
}

export function ThreadView({ session, threadId, onActivityChange }: ThreadViewProps) {
  const thread = useThread(session, threadId)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => { onActivityChange?.(thread.active) }, [thread.active, onActivityChange])

  // Follow the stream while the reader is at the bottom; leave them alone if they scrolled up.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [thread.items])

  useEffect(() => { stick.current = true }, [threadId])

  return (
    <div className="m-thread">
      <div
        ref={scroller}
        className="m-thread__scroll"
        onScroll={(event) => {
          const element = event.currentTarget
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
        }}
      >
        <div className="m-transcript" role="log" aria-live="polite" aria-busy={thread.active || undefined}>
          {thread.loading && <div className="m-loading"><Spinner label="Loading thread" /></div>}
          {!thread.loading && thread.items.length === 0 && (
            <EmptyState title="What should we work on?" body="Your message goes to the computer, which runs the work and streams the reply here." />
          )}
          {thread.items.map((item) => <ChatItemView key={item.id} item={item} />)}
        </div>
      </div>
      <div className="m-thread__composer">
        {thread.error && <Notice>{thread.error}</Notice>}
        <Composer active={thread.active} onSend={thread.send} onStop={() => void thread.stop()} />
      </div>
    </div>
  )
}
