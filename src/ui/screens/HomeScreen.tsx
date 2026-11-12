import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ComputerView } from '../../connection/computerStore'
import { deviceNetworkSignals } from '../../connection/networkSignals'
import type { ListBot } from '../../connection/bots'
import type { Computer, ListChat, ListProject, ListThread } from '../../connection/types'
import { useAutoJoin, useComputer, useComputers, useComputerViews } from '../hooks/connection'
import { useIsWide } from '../hooks/useMediaQuery'
import { useRouter } from '../state/router'
import { EmptyState } from '../components/EmptyState'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ChevronLeft, Info, MessageSquarePlus, Settings } from '../components/icons'
import { Button, IconButton, MousseLogo, Notice, Spinner, TopBar } from '../components/primitives'
import { Sidebar, type RowComputer } from '../sidebar/Sidebar'
import { mergedKey, mergeLists, savedTab, saveTab, splitKey, type SidebarTab } from '../sidebar/model'
import { loadLastComputer, saveLastComputer } from '../lib/composerPrefs'
import { threadComputers } from '../lib/newThread'
import { ThreadView } from './ThreadView'
import { BotAboutSheet, BotChat } from '../bots/BotChat'
import { NewBotSheet } from '../bots/NewBotSheet'
import { BotBoundary } from '../bots/BotBoundary'

/** How often the home screen reads the account's computers again, to notice one coming online. */
export const COMPUTERS_REFRESH_MS = 30_000

/** A computer that cannot be reached right now: Mousse ID says it is offline, or the link failed. */
function isOffline(computer: Computer, view: ComputerView | undefined): boolean {
  return !computer.online || view?.link === 'error' || view?.link === 'closed'
}

/** Why the link to a computer is down, as the per-computer screen said it. */
function lostMessage(name: string, view: ComputerView): string {
  if (view.link === 'error') return view.error ?? `Could not connect to ${name}.`
  return view.error ? `Lost the connection to ${name}: ${view.error}` : `Lost the connection to ${name}.`
}

/** The one quiet line about adding this phone to the account's computers. */
function JoinLine() {
  const join = useAutoJoin()
  let text: string | undefined
  if (join.state === 'joining') text = join.slow ? `Open Mousse on ${join.computer} to finish adding this phone.` : 'Adding this phone to your computers…'
  else if (join.state === 'waiting') text = `Open Mousse on ${join.computer} to finish adding this phone.`
  else if (join.state === 'removed') text = `${join.computer ?? 'Your computers'} removed this phone. Add it again in Settings.`
  if (!text) return null
  return (
    <div className="m-sb-banner" role="status">
      {join.state === 'joining' && !join.slow && <Spinner size={14} />}
      <span>{text}</span>
    </div>
  )
}

/**
 * The home screen: one list of threads from all the user's computers, like the desktop sidebar.
 * Each row names its computer; a computer that is offline keeps its threads listed from the lists
 * saved on this phone. Opening a thread shows it on its computer, side by side at 768px and wider.
 */
export function HomeScreen({ selected, selectedBot }: { selected?: { nodeId: string; threadId: string }; selectedBot?: { nodeId: string; botId: string } }) {
  const router = useRouter()
  const wide = useIsWide()
  const computers = useComputers()
  const join = useAutoJoin()
  const [tab, setTab] = useState<SidebarTab>(savedTab)
  const [notice, setNotice] = useState<string>()
  const [newBotOpen, setNewBotOpen] = useState(false)

  const enrolled = useMemo(() => threadComputers(computers.data ?? []), [computers.data])
  const byNode = useMemo(() => new Map(enrolled.map((computer) => [computer.nodeId, computer])), [enrolled])
  // Computers Mousse ID reports online connect and stay connected; the others show their saved lists.
  const entries = useMemo(() => enrolled.map((computer) => ({ nodeId: computer.nodeId, connect: computer.online })), [enrolled])
  const views = useComputerViews(entries)
  const reload = computers.reload

  // Notice a computer coming online, or one that removed this phone, without a refresh button.
  useEffect(() => {
    const timer = setInterval(reload, COMPUTERS_REFRESH_MS)
    const off = deviceNetworkSignals.onChange(reload)
    return () => { clearInterval(timer); off() }
  }, [reload])
  const troubled = [...views.values()].filter((view) => view.link === 'error' || view.link === 'removed').map((view) => view.nodeId).join(',')
  useEffect(() => {
    if (troubled) reload()
  }, [troubled, reload])
  // A computer that removed this phone may mean all of them did: ask Mousse ID again.
  const removedAny = [...views.values()].some((view) => view.link === 'removed')
  const checkJoin = join.check
  useEffect(() => {
    if (removedAny) checkJoin()
  }, [removedAny, checkJoin])

  const sources = useMemo(
    () => enrolled.flatMap((computer) => {
      const view = views.get(computer.nodeId)
      return view?.lists && view.link !== 'removed' ? [{ nodeId: computer.nodeId, lists: view.lists }] : []
    }),
    [enrolled, views],
  )
  const lists = useMemo(() => (sources.length ? mergeLists(sources) : undefined), [sources])
  const labelled = enrolled.length > 1
  const computerOf = useCallback((key: string): RowComputer | undefined => {
    const nodeId = splitKey(key)?.nodeId
    const computer = nodeId ? byNode.get(nodeId) : undefined
    if (!computer) return undefined
    return { name: computer.name, offline: isOffline(computer, views.get(computer.nodeId)) }
  }, [byNode, views])

  const changeTab = useCallback((next: SidebarTab) => {
    setTab(next)
    saveTab(next)
    setNotice(undefined)
  }, [])

  const open = selected ?? selectedBot
  const show = useCallback((nodeId: string, threadId: string) => {
    saveLastComputer(nodeId)
    const route = { name: 'thread' as const, nodeId, threadId }
    if (open && wide) router.replace(route)
    else router.push(route)
  }, [open, wide, router])
  const openBot = useCallback((bot: ListBot) => {
    const key = splitKey(bot.id)
    if (!key) return
    const route = { name: 'bot' as const, nodeId: key.nodeId, botId: key.id }
    if (open && wide) router.replace(route)
    else router.push(route)
  }, [open, wide, router])
  // New bot is made on the computer last used, or the first one online.
  const online = enrolled.filter((computer) => !isOffline(computer, views.get(computer.nodeId)))
  const last = loadLastComputer()
  const botComputer = online.find((computer) => computer.nodeId === last) ?? online[0]
  const created = useCallback((bot: ListBot) => {
    setNewBotOpen(false)
    if (!botComputer) return
    const route = { name: 'bot' as const, nodeId: botComputer.nodeId, botId: bot.id }
    if (open && wide) router.replace(route)
    else router.push(route)
  }, [botComputer, open, wide, router])

  const openThread = useCallback((thread: ListThread) => {
    const key = splitKey(thread.id)
    if (key) show(key.nodeId, key.id)
  }, [show])
  const openChat = useCallback((chat: ListChat) => {
    const key = splitKey(chat.id)
    if (!key) return
    if (chat.network || !chat.threadId) {
      setNotice(`“${chat.name}” is a Space conversation. Open it in Mousse on ${byNode.get(key.nodeId)?.name ?? 'the computer'}.`)
      return
    }
    const thread = splitKey(chat.threadId)
    if (thread) show(thread.nodeId, thread.id)
  }, [show, byNode])
  const newThreadIn = useCallback((project: ListProject) => {
    const key = splitKey(project.id)
    if (key) router.push({ name: 'new', nodeId: key.nodeId, projectId: key.id })
  }, [router])

  const settings = <IconButton label="Settings" onClick={() => router.push({ name: 'settings' })}><Settings /></IconButton>
  const compose = (
    <IconButton label="New thread" disabled={!enrolled.length} onClick={() => router.push({ name: 'new' })}>
      <MessageSquarePlus />
    </IconButton>
  )

  const banner = (
    <>
      <JoinLine />
      {enrolled.map((computer) => {
        const view = views.get(computer.nodeId)
        if (!view?.lists || view.link === 'removed') return null
        if (!computer.online) {
          return <div key={computer.nodeId} className="m-sb-banner" role="status"><span>{`${computer.name} is offline. Showing saved lists.`}</span></div>
        }
        if (view.link === 'error' || view.link === 'closed') {
          return (
            <div key={computer.nodeId} className="m-sb-banner m-sb-banner--error" role="status">
              <span>{`${lostMessage(computer.name, view).replace(/\.?$/, '.')} Showing saved lists.`}</span>
              <RetryButton nodeId={computer.nodeId} />
            </div>
          )
        }
        if (view.listsState === 'polling') {
          return <div key={computer.nodeId} className="m-sb-banner" role="status"><span>{`Mousse on ${computer.name} is older: lists refresh every few seconds instead of instantly.`}</span></div>
        }
        return null
      })}
      {notice && <Notice tone="info">{notice}</Notice>}
    </>
  )

  let list: ReactNode
  if (lists) {
    list = (
      <ErrorBoundary what={tab === 'chats' ? 'the Chats tab' : tab === 'projects' ? 'the Projects tab' : 'the thread list'} resetKey={tab}>
      <Sidebar
        lists={lists}
        tab={tab}
        onTab={changeTab}
        selectedId={selected ? mergedKey(selected.nodeId, selected.threadId) : undefined}
        onOpenThread={openThread}
        onOpenChat={openChat}
        onNewThread={newThreadIn}
        onOpenBot={openBot}
        {...(botComputer ? { onNewBot: () => setNewBotOpen(true) } : {})}
        {...(selectedBot ? { selectedBotId: mergedKey(selectedBot.nodeId, selectedBot.botId) } : {})}
        banner={banner}
        order="recent"
        {...(labelled ? { computerOf } : {})}
      />
      </ErrorBoundary>
    )
  } else if (!computers.data) {
    list = computers.error
      ? <><Notice>{computers.error}</Notice><Button onClick={reload}>Try again</Button></>
      : <div className="m-loading"><Spinner label="Loading" /></div>
  } else if (!enrolled.length) {
    const anyComputer = computers.data.some((computer) => computer.kind === 'computer')
    list = (
      <>
        <JoinLine />
        {anyComputer || join.state === 'joining' || join.state === 'waiting'
          ? <EmptyState title="Your threads will show here" body="They appear once this phone is added to your computers." />
          : <EmptyState title="No computers yet" body="Open Mousse on your computer and sign in with the same Mousse ID." />}
      </>
    )
  } else {
    // Computers this phone can open, none with lists yet: connecting, or every one failed.
    const failed = enrolled.flatMap((computer) => {
      const view = views.get(computer.nodeId)
      return view && (view.link === 'error' || view.link === 'closed') ? [{ computer, view }] : []
    })
    const connecting = enrolled.some((computer) => {
      const link = views.get(computer.nodeId)?.link
      return computer.online && (link === 'connecting' || link === 'idle' || link === 'open')
    })
    list = (
      <>
        <JoinLine />
        {failed.map(({ computer, view }) => (
          <div key={computer.nodeId} className="m-form">
            <Notice>{lostMessage(computer.name, view)}</Notice>
            <RetryButton nodeId={computer.nodeId} />
          </div>
        ))}
        {connecting
          ? <div className="m-loading"><Spinner label="Connecting to your computers" /><span>Connecting…</span></div>
          : !failed.length && <EmptyState title="Your computers are offline" body="Open Mousse on one of them to see its threads." />}
      </>
    )
  }

  const selectedComputer = selected ? byNode.get(selected.nodeId) : undefined
  const botComputerName = selectedBot ? byNode.get(selectedBot.nodeId)?.name : undefined
  const pane = selected
    ? <ThreadPane nodeId={selected.nodeId} threadId={selected.threadId} name={selectedComputer?.name ?? 'Computer'} wide={wide} />
    : selectedBot ? <ErrorBoundary what="this bot's chat" resetKey={selectedBot.botId}><BotPane nodeId={selectedBot.nodeId} botId={selectedBot.botId} name={botComputerName ?? 'Computer'} labelled={labelled} wide={wide} /></ErrorBoundary> : null
  const newBot = botComputer && (
    <NewBotHost
      key={botComputer.nodeId}
      open={newBotOpen}
      nodeId={botComputer.nodeId}
      computerName={labelled ? botComputer.name : undefined}
      onClose={() => setNewBotOpen(false)}
      onCreated={created}
    />
  )

  if (!wide) {
    if (pane) return pane
    return (
      <main className="m-screen">
        <TopBar leading={<span className="m-topbar__brand"><MousseLogo size={24} /></span>} title="Threads" trailing={<>{compose}{settings}</>} />
        <div className="m-scroll"><div className="m-content">{list}</div></div>
        {newBot}
      </main>
    )
  }

  return (
    <main className="m-screen m-split">
      <aside className="m-split__list">
        <TopBar leading={<span className="m-topbar__brand"><MousseLogo size={24} /></span>} title="Threads" trailing={<>{compose}{settings}</>} />
        <div className="m-scroll"><div className="m-content">{list}</div></div>
      </aside>
      <section className="m-split__detail">
        {pane ?? (
          <div className="m-split__empty">
            <EmptyState title="Pick a thread" body="Choose a thread or chat, or start a new one." />
          </div>
        )}
      </section>
      {newBot}
    </main>
  )
}

function RetryButton({ nodeId }: { nodeId: string }) {
  const { store } = useComputer(nodeId)
  return <Button variant="ghost" onClick={() => store.retry()}>Try again</Button>
}

/** One thread on its computer: the timeline and composer once connected, or why it cannot open. */
function ThreadPane({ nodeId, threadId, name, wide }: { nodeId: string; threadId: string; name: string; wide: boolean }) {
  const router = useRouter()
  const computer = useComputer(nodeId)
  const { link, lists, session, store } = computer
  const chat = lists?.chats.find((entry) => entry.threadId === threadId)
  const title = chat?.name ?? lists?.threads.find((entry) => entry.id === threadId)?.title ?? 'Thread'
  const subtitle = chat ? `Chat · ${name}` : name
  const back = wide ? undefined : <IconButton label="Back" onClick={router.pop}><ChevronLeft size={22} /></IconButton>

  let body: ReactNode
  if (link === 'removed') {
    body = (
      <div className="m-scroll"><div className="m-content">
        <Notice>{`${name} removed this phone.`}</Notice>
        <Button onClick={() => router.reset()}>Back to threads</Button>
      </div></div>
    )
  } else if (session) {
    body = <ThreadView session={session} threadId={threadId} computerName={name} />
  } else {
    const failed = link === 'error' || link === 'closed'
    body = (
      <div className="m-scroll"><div className="m-content">
        {failed ? (
          <>
            <Notice>{lostMessage(name, computer)}</Notice>
            <Button onClick={() => store.retry()}>Try again</Button>
          </>
        ) : <div className="m-loading"><Spinner label={`Connecting to ${name}`} /><span>Connecting to {name}…</span></div>}
      </div></div>
    )
  }

  if (wide) {
    return <><TopBar title={title} subtitle={subtitle} />{body}</>
  }
  return (
    <main className="m-screen">
      <TopBar leading={back} title={title} subtitle={subtitle} />
      {body}
    </main>
  )
}

function NewBotHost({ open, nodeId, computerName, onClose, onCreated }: { open: boolean; nodeId: string; computerName?: string; onClose(): void; onCreated(bot: ListBot): void }) {
  const { session, lists } = useComputer(nodeId)
  return <BotBoundary resetKey={open}><NewBotSheet open={open} computerName={computerName} bots={session?.bots} existing={lists?.bots ?? []} onClose={onClose} onCreated={onCreated} /></BotBoundary>
}

/** One bot's chat on its computer, or why it cannot open. */
function BotPane({ nodeId, botId, name, labelled, wide }: { nodeId: string; botId: string; name: string; labelled: boolean; wide: boolean }) {
  const router = useRouter()
  const computer = useComputer(nodeId)
  const { link, lists, session, store } = computer
  const [about, setAbout] = useState(false)
  const [error, setError] = useState<string>()
  const bot = lists?.bots?.find((entry) => entry.id === botId)
  const back = wide ? undefined : <IconButton label="Back" onClick={router.pop}><ChevronLeft size={22} /></IconButton>
  const info = bot && session?.bots ? <IconButton label={`About ${bot.name}`} onClick={() => setAbout(true)}><Info /></IconButton> : undefined

  let body: ReactNode
  if (link === 'removed') {
    body = <div className="m-scroll"><div className="m-content"><Notice>{`${name} removed this phone.`}</Notice><Button onClick={() => router.reset()}>Back to threads</Button></div></div>
  } else if (session && lists && !bot) {
    body = <div className="m-scroll"><div className="m-content"><EmptyState title="This bot is gone" body={`It was deleted on ${name}.`} /></div></div>
  } else if (session && bot && !session.bots) {
    body = <div className="m-scroll"><div className="m-content"><Notice tone="info">{`Update Mousse on ${name} to chat with ${bot.name} from this phone.`}</Notice></div></div>
  } else if (session && bot && session.bots) {
    body = <>
      {error && <div className="m-content"><Notice>{error}</Notice></div>}
      <BotBoundary resetKey={botId} fallback={(retry) => (
        <div className="m-scroll"><div className="m-content"><Notice>{`Couldn't show ${bot.name}'s chat.`}</Notice><Button onClick={retry}>Try again</Button></div></div>
      )}>
        <BotChat bot={bot} bots={session.bots} />
      </BotBoundary>
      <BotBoundary resetKey={about}>
        <BotAboutSheet open={about} bot={bot} bots={session.bots} onClose={() => setAbout(false)} onError={setError} />
      </BotBoundary>
    </>
  } else {
    const failed = link === 'error' || link === 'closed'
    body = (
      <div className="m-scroll"><div className="m-content">
        {failed
          ? <><Notice>{lostMessage(name, computer)}</Notice><Button onClick={() => store.retry()}>Try again</Button></>
          : <div className="m-loading"><Spinner label={`Connecting to ${name}`} /><span>Connecting to {name}…</span></div>}
      </div></div>
    )
  }
  // The header shows only the name, as on the desktop (what it does is in About); with several computers, whose it is.
  const title = bot?.name ?? 'Bot'
  const subtitle = !bot || labelled ? name : undefined
  if (wide) return <><TopBar title={title} subtitle={subtitle} trailing={info} />{body}</>
  return (
    <main className="m-screen">
      <TopBar leading={back} title={title} subtitle={subtitle} trailing={info} />
      {body}
    </main>
  )
}
