import { useCallback, useEffect, useState } from 'react'
import type { ListChat, ListProject, ListThread } from '../../connection/types'
import { useComputer, useComputers } from '../hooks/connection'
import { useIsWide } from '../hooks/useMediaQuery'
import { errorMessage } from '../hooks/useAsync'
import { useRouter } from '../state/router'
import { EmptyState } from '../components/EmptyState'
import { ChevronLeft, Folder, MessageSquarePlus, Settings } from '../components/icons'
import { Button, IconButton, ListRow, Notice, Spinner, StatusDot, TopBar } from '../components/primitives'
import { Sheet } from '../components/Sheet'
import { Sidebar } from '../sidebar/Sidebar'
import { savedTab, saveTab, type SidebarTab } from '../sidebar/model'
import { ThreadView } from './ThreadView'

/**
 * One computer: the sidebar (Projects / Threads / Chats) and the open thread or chat. Phones show
 * one or the other; at 768px and wider both sit side by side. The lists draw at once from memory
 * or from what the phone saved, and follow the computer live once connected.
 */
export function ComputerScreen({ nodeId, threadId }: { nodeId: string; threadId?: string }) {
  const router = useRouter()
  const wide = useIsWide()
  const computer = useComputer(nodeId)
  const computers = useComputers()
  const [tab, setTab] = useState<SidebarTab>(savedTab)
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState<string>()
  const [notice, setNotice] = useState<string>()
  /** Titles of threads this phone just created: drafts stay out of the lists until their first message. */
  const [created, setCreated] = useState<Record<string, string>>({})

  const entry = computers.data?.find((row) => row.nodeId === nodeId)
  const name = entry?.name ?? 'Computer'
  const { link, lists, session, store } = computer
  const reloadComputers = computers.reload

  // A dropped or refused link may mean the computer removed this phone; the computer list says.
  useEffect(() => {
    if (link === 'error' || link === 'removed') reloadComputers()
  }, [link, reloadComputers])

  const changeTab = useCallback((next: SidebarTab) => {
    setTab(next)
    saveTab(next)
    setNotice(undefined)
  }, [])

  const show = useCallback((id: string) => {
    const route = { name: 'thread' as const, nodeId, threadId: id }
    if (threadId && wide) router.replace(route)
    else router.push(route)
  }, [nodeId, threadId, wide, router])

  const openThread = useCallback((thread: ListThread) => show(thread.id), [show])
  const openChat = useCallback((chat: ListChat) => {
    if (chat.network || !chat.threadId) {
      setNotice(`“${chat.name}” is a Space conversation. Open it in Mousse on ${name}.`)
      return
    }
    show(chat.threadId)
  }, [show, name])

  const newThread = useCallback(async (project: ListProject) => {
    if (!session) return
    setCreating(project.id)
    setNotice(undefined)
    try {
      const thread = await session.createThread({ projectId: project.id })
      setCreated((current) => ({ ...current, [thread.id]: thread.title }))
      setPicking(false)
      show(thread.id)
    } catch (cause) {
      setNotice(errorMessage(cause))
    } finally {
      setCreating(undefined)
    }
  }, [session, show])

  const back = <IconButton label="Back" onClick={router.pop}><ChevronLeft size={22} /></IconButton>
  const settings = <IconButton label="Settings" onClick={() => router.push({ name: 'settings' })}><Settings /></IconButton>
  const compose = (
    <IconButton label="New thread" disabled={!session || !lists?.projects.length} onClick={() => setPicking(true)}>
      <MessageSquarePlus />
    </IconButton>
  )
  const presence =
    link === 'open' ? <><StatusDot state="online" /> Online</>
    : link === 'connecting' || link === 'idle' ? <><StatusDot state="offline" /> Connecting…</>
    : <><StatusDot state="offline" /> {lists ? 'Offline · saved lists' : 'Offline'}</>

  const removed = link === 'removed' || (link === 'error' && entry?.enrolled === false)
  if (removed) {
    return (
      <main className="m-screen">
        <TopBar leading={back} title={name} />
        <div className="m-scroll"><div className="m-content">
          <Notice>{`${name} removed this phone. Add it again to reconnect.`}</Notice>
          <Button onClick={() => router.reset()}>Back to computers</Button>
        </div></div>
      </main>
    )
  }

  const failed = link === 'error' || link === 'closed'
  /** Why the link is down: the refusal when connecting failed, or why an open session closed. */
  const lost =
    link === 'error' ? computer.error ?? `Could not connect to ${name}.`
    : computer.error ? `Lost the connection to ${name}: ${computer.error}`
    : `Lost the connection to ${name}.`
  const banner = (
    <>
      {failed && lists && (
        <div className="m-sb-banner m-sb-banner--error" role="status">
          <span>{`${lost.replace(/\.?$/, '.')} Showing saved lists.`}</span>
          <Button variant="ghost" onClick={() => store.retry()}>Try again</Button>
        </div>
      )}
      {computer.listsState === 'polling' && (
        <div className="m-sb-banner" role="status"><span>{`Mousse on ${name} is older: lists refresh every few seconds instead of instantly.`}</span></div>
      )}
      {notice && <Notice tone="info">{notice}</Notice>}
    </>
  )

  const sidebar = lists ? (
    <Sidebar
      lists={lists}
      tab={tab}
      onTab={changeTab}
      selectedId={threadId}
      onOpenThread={openThread}
      onOpenChat={openChat}
      onNewThread={session ? (project) => void newThread(project) : undefined}
      banner={banner}
    />
  ) : failed ? (
    <>
      <Notice>{lost}</Notice>
      <Button onClick={() => store.retry()}>Try again</Button>
    </>
  ) : (
    <div className="m-loading"><Spinner label={`Connecting to ${name}`} /><span>Connecting to {name}…</span></div>
  )

  const chat = threadId ? lists?.chats.find((entry) => entry.threadId === threadId) : undefined
  const threadTitle = threadId
    ? chat?.name ?? lists?.threads.find((entry) => entry.id === threadId)?.title ?? created[threadId] ?? 'Thread'
    : undefined
  const pane = threadId ? (
    session ? (
      <ThreadView session={session} threadId={threadId} />
    ) : (
      <div className="m-scroll"><div className="m-content">
        {failed ? (
          <>
            <Notice>{lost}</Notice>
            <Button onClick={() => store.retry()}>Try again</Button>
          </>
        ) : <div className="m-loading"><Spinner label={`Connecting to ${name}`} /><span>Connecting to {name}…</span></div>}
      </div></div>
    )
  ) : null

  const sheet = (
    <Sheet open={picking} title="New thread in…" onClose={() => setPicking(false)}>
      <div className="m-list">
        {[...(lists?.projects ?? [])].sort((a, b) => a.order - b.order).map((project) => (
          <ListRow
            key={project.id}
            leading={creating === project.id ? <Spinner size={16} /> : <Folder />}
            title={project.name}
            detail={project.path}
            disabled={!!creating}
            onClick={() => void newThread(project)}
          />
        ))}
      </div>
    </Sheet>
  )

  if (!wide) {
    if (threadId) {
      return (
        <main className="m-screen">
          <TopBar leading={back} title={threadTitle} subtitle={chat ? `Chat · ${name}` : name} />
          {pane}
        </main>
      )
    }
    return (
      <main className="m-screen">
        <TopBar leading={back} title={name} subtitle={presence} trailing={<>{compose}{settings}</>} />
        <div className="m-scroll"><div className="m-content">{sidebar}</div></div>
        {sheet}
      </main>
    )
  }

  return (
    <main className="m-screen m-split">
      <aside className="m-split__list">
        <TopBar leading={<IconButton label="All computers" onClick={() => router.reset()}><ChevronLeft size={22} /></IconButton>} title={name} subtitle={presence} trailing={<>{compose}{settings}</>} />
        <div className="m-scroll"><div className="m-content">{sidebar}</div></div>
      </aside>
      <section className="m-split__detail">
        {threadId ? (
          <>
            <TopBar title={threadTitle} subtitle={chat ? `Chat · ${name}` : name} />
            {pane}
          </>
        ) : (
          <div className="m-split__empty">
            <EmptyState title="Pick a thread" body={`Choose a thread or chat on ${name}, or start a new one.`} />
          </div>
        )}
      </section>
      {sheet}
    </main>
  )
}
