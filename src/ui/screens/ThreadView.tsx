import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComputerSession } from '../../connection/types'
import { useThread } from '../hooks/useThread'
import { JumpToLatest, Timeline } from '../timeline/Timeline'
import { planApprovalText } from '../timeline/context'
import { ThreadComposer } from '../components/ThreadComposer'
import { EmptyState } from '../components/EmptyState'
import { Notice, Spinner } from '../components/primitives'
import { SpeechProvider } from '../speech/readAloud'

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
  const [away, setAway] = useState(false)
  const [addition, setAddition] = useState<{ text: string; key: number }>()
  const addToDraft = useCallback((text: string) => setAddition({ text, key: Date.now() }), [])
  const send = thread.send
  const approvePlan = useCallback(async (markdown: string) => {
    // Like the desktop's plan card: approve, then build.
    await send(planApprovalText(markdown), { mode: 'build' })
  }, [send])
  const jump = useCallback(() => {
    const element = scroller.current
    if (!element) return
    stick.current = true
    setAway(false)
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }, [])

  useEffect(() => { onActivityChange?.(thread.active) }, [thread.active, onActivityChange])

  // Follow the stream while the reader is at the bottom; leave them alone if they scrolled up.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [thread.items, thread.display])

  useEffect(() => { stick.current = true }, [threadId])

  return (
    <SpeechProvider speech={session.speech}>
    <div className="m-thread m-thread--timeline">
      <div
        ref={scroller}
        className="m-thread__scroll"
        onScroll={(event) => {
          const element = event.currentTarget
          // Stay pinned within 80px of the bottom, like the desktop.
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
          setAway(!stick.current)
        }}
      >
        <div className="m-transcript" role="log" aria-live="polite" aria-busy={thread.active || undefined}>
          {thread.loading && <div className="m-loading m-loading--late"><Spinner label="Loading thread" /></div>}
          {!thread.loading && thread.items.length === 0 && (
            <EmptyState title="What should we work on?" body="Your message goes to the computer, which runs the work and streams the reply here." />
          )}
          {!thread.loading && (thread.items.length > 0 || thread.display.questions.length > 0) && (
            <Timeline
              items={thread.items}
              display={thread.display}
              active={thread.active}
              onApprovePlan={approvePlan}
              onAddToDraft={addToDraft}
              onAnswer={thread.answer}
              onDismiss={thread.dismiss}
            />
          )}
          {thread.active && <div className="m-tl-breathing" aria-hidden />}
        </div>
      </div>
      {away && <JumpToLatest live={thread.active} onClick={jump} />}
      <div className="m-thread__composer">
        {thread.error && <Notice>{thread.error}</Notice>}
        <ThreadComposer session={session} threadId={threadId} thread={thread} addition={addition} />
      </div>
    </div>
    </SpeechProvider>
  )
}
