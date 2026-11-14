import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComputerSession } from '../../connection/types'
import { useThread } from '../hooks/useThread'
import { useThreadQueue } from '../hooks/useThreadQueue'
import { JumpToLatest, Timeline } from '../timeline/Timeline'
import { planApprovalText } from '../timeline/context'
import { ThreadComposer } from '../components/ThreadComposer'
import { QueuedMessages } from '../components/QueuedMessages'
import { MousseLogoOutline } from '../components/MousseLogoOutline'
import { Button, Notice, Spinner } from '../components/primitives'
import { SpeechProvider } from '../speech/readAloud'
import { ShowQuotedContext } from '../components/SentQuotes'
import { QUOTE_SOURCE_ATTRIBUTE } from '../components/SelectionReplyButton'

export interface ThreadViewProps {
  session: ComputerSession
  threadId: string
  /** Called when a turn starts or ends so lists can refresh their indicators. */
  onActivityChange?(active: boolean): void
  /** The computer's name, for the composer's permission note. */
  computerName?: string
}

/**
 * How far from the end (px) the reader must be before the composer folds (the desktop's 120px plus the
 * phone's taller fold). Folding gives the view about 48px more height, which brings the end that much
 * closer; this keeps it clear of the 80px follow threshold, so the composer never unfolds again there.
 */
const COMPOSER_FOLD_DISTANCE = 160

const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()) })

export function ThreadView({ session, threadId, onActivityChange, computerName }: ThreadViewProps) {
  const thread = useThread(session, threadId)
  // While a compaction runs it holds the queue; Send now on the first message skips it.
  const compacting = thread.active && thread.items.some((item) => item.kind === 'compaction' && item.status === 'streaming')
  const hold = useMemo(() => (compacting ? {} : null), [compacting])
  const queue = useThreadQueue(session, threadId, thread.active, hold)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [away, setAway] = useState(false)
  const [folded, setFolded] = useState(false)
  const [addition, setAddition] = useState<{ text: string; key: number }>()
  /**
   * The scroll height and the oldest message shown when a page of older messages was asked for: once that message
   * is no longer the oldest, the page is in front, and the reader is moved down by what it added.
   */
  const prepended = useRef<{ height: number; first: string | undefined }>()
  const oldest = thread.items.find((entry) => entry.id !== 'local-earlier')?.id
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

  // Follow the stream while the reader is at the bottom; leave them alone if they scrolled up. Older messages put in
  // front keep what the reader looks at in place.
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const held = prepended.current
    if (held && held.first !== oldest) {
      prepended.current = undefined
      if (!stick.current) {
        element.scrollTop += element.scrollHeight - held.height
        return
      }
    }
    if (stick.current) element.scrollTop = element.scrollHeight
  }, [thread.items, thread.display, queue.items, oldest])
  useEffect(() => { if (!thread.loadingEarlier) prepended.current = undefined }, [thread.loadingEarlier])

  // Near the top of a long thread, the page before the oldest message shown comes from the computer.
  const loadEarlier = thread.loadEarlier
  const earlierLoadable = thread.display.earlier?.loadable === true
  const readEarlier = useCallback(() => {
    const element = scroller.current
    if (!element || !loadEarlier || !earlierLoadable || thread.loadingEarlier) return
    if (element.scrollTop > 200) return
    prepended.current = { height: element.scrollHeight, first: oldest }
    void loadEarlier()
  }, [loadEarlier, earlierLoadable, thread.loadingEarlier, oldest])
  // A thread shorter than the screen has nothing to scroll: read on until it fills the screen or nothing is left.
  useEffect(() => {
    const element = scroller.current
    if (element && element.scrollHeight <= element.clientHeight) readEarlier()
  }, [thread.items, readEarlier])

  useEffect(() => { stick.current = true; setFolded(false) }, [threadId])

  // A sent reply's quote goes to the message it quoted; one not loaded yet is loaded first, page by page, as the
  // bot chat's quotes do.
  const latest = useRef(thread)
  latest.current = thread
  const showQuoted = useCallback(async (id: string) => {
    const find = () => scroller.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`) ?? null
    let element = find()
    for (let pages = 0; !element && pages < 40; pages += 1) {
      const before = latest.current
      if (!before.loadEarlier || before.display.earlier?.loadable !== true || before.items.some((item) => item.id === id)) break
      const first = before.items[0]?.id
      await before.loadEarlier()
      for (let frame = 0; frame < 10 && latest.current.items[0]?.id === first; frame += 1) await nextFrame()
      if (latest.current.items[0]?.id === first) break
      element = find()
    }
    for (let frame = 0; frame < 10 && !(element = find()); frame += 1) await nextFrame()
    if (!element) return
    stick.current = false
    setAway(true)
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element.classList.remove('is-shown')
    void element.offsetWidth
    element.classList.add('is-shown')
    window.setTimeout(() => element!.classList.remove('is-shown'), 1400)
  }, [])
  const onShowQuoted = useCallback((id: string) => { void showQuoted(id) }, [showQuoted])

  // The view shrinks when the composer unfolds or grows (or the keyboard opens): a reader at the end stays there.
  useEffect(() => {
    const element = scroller.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => { if (stick.current) element.scrollTop = element.scrollHeight })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <SpeechProvider speech={session.speech}>
    <ShowQuotedContext.Provider value={onShowQuoted}>
    <div className="m-thread m-thread--timeline">
      <div
        ref={scroller}
        className="m-thread__scroll"
        {...{ [QUOTE_SOURCE_ATTRIBUTE]: '' }}
        onScroll={(event) => {
          const element = event.currentTarget
          // Stay pinned within 80px of the bottom, like the desktop.
          const distance = element.scrollHeight - element.scrollTop - element.clientHeight
          stick.current = distance < 80
          setAway(!stick.current)
          // The composer folds once the reader is well up, and unfolds back at the end; between the two it stays as it is.
          if (stick.current) setFolded(false)
          else if (distance > COMPOSER_FOLD_DISTANCE) setFolded(true)
          readEarlier()
        }}
      >
        <div className="m-transcript" role="log" aria-live="polite" aria-busy={thread.active || undefined}>
          {thread.loading && <div className="m-loading m-loading--late"><Spinner label="Loading thread" /></div>}
          {thread.loadingEarlier && <div className="m-loading"><Spinner label="Loading earlier messages" /></div>}
          {!thread.loading && thread.openError && thread.items.length === 0 && (
            <div className="m-empty" role="alert">
              <h2 className="m-empty__title">Could not open this thread</h2>
              <p className="m-empty__body">{thread.openError}</p>
              <div className="m-empty__actions"><Button onClick={thread.retry}>Try again</Button></div>
            </div>
          )}
          {!thread.loading && !thread.openError && thread.items.length === 0 && (
            <div className="m-start-hero">
              <MousseLogoOutline className="m-new-thread__logo" />
              <h2 className="m-new-thread__title">What should we build?</h2>
            </div>
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
          {thread.active && <div className="m-tl-reply-gap" data-reply-gap aria-hidden />}
          {!thread.loading && <QueuedMessages queue={queue} />}
        </div>
      </div>
      <div className="m-thread__composer">
        {thread.items.length > 0 && <JumpToLatest live={thread.active} shown={away} onClick={jump} />}
        {thread.error && <Notice>{thread.error}</Notice>}
        {queue.error && <Notice>{queue.error}</Notice>}
        <ThreadComposer session={session} threadId={threadId} thread={thread} queue={queue} addition={addition} computerName={computerName} folded={folded} />
      </div>
    </div>
    </ShowQuotedContext.Provider>
    </SpeechProvider>
  )
}
