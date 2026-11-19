import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ComputerView } from '../../connection/computerStore'
import { deviceNetworkSignals } from '../../connection/networkSignals'
import type { ListBot } from '../../connection/bots'
import type { Computer, ListChat, ListProject, ListThread, Project } from '../../connection/types'
import { useAutoJoin, useComputer, useComputers, useComputerViews, useConnection } from '../hooks/connection'
import { useIsWide } from '../hooks/useMediaQuery'
import { useRouter } from '../state/router'
import { EmptyState } from '../components/EmptyState'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ChevronLeft, FolderPlus, MessageSquarePlus, MoreHorizontal, Plus, Settings } from '../components/icons'
import { Button, IconButton, MousseLogo, Notice, Spinner, TopBar } from '../components/primitives'
import { Sidebar, type RowComputer } from '../sidebar/Sidebar'
import { HomeDock, TAB_META, type DockAction } from '../sidebar/HomeDock'
import { NewProjectSheet } from '../sidebar/NewProjectSheet'
import { mergedKey, mergeLists, savedTab, saveTab, splitKey, type SidebarTab } from '../sidebar/model'
import { loadLastComputer, saveLastComputer } from '../lib/composerPrefs'
import { threadComputers } from '../lib/newThread'
import { ThreadView } from './ThreadView'
import { ThreadOptionsHost } from '../sidebar/ThreadOptionsHost'
import type { ThreadOptionsResult } from '../sidebar/ThreadOptionsSheet'
import { BotHeader } from '../bots/BotHeader'
import { BotBoundary } from '../bots/BotBoundary'
import { BotThreadHeader } from '../bots/BotThreadHeader'
import { Mascot } from '../bots/Mascot'
import type { BotMenuView } from '../bots/BotMenuSheet'

// Bot chat and its heavy sheets load on demand, keeping initial phone startup fast.
const BotChat = lazy(() => import('../bots/BotChat').then((module) => ({ default: module.BotChat })))
const BotAboutSheet = lazy(() => import('../bots/BotAboutSheet').then((module) => ({ default: module.BotAboutSheet })))
const BotMemorySheet = lazy(() => import('../bots/BotMemorySheet').then((module) => ({ default: module.BotMemorySheet })))
const BotPresenceSheet = lazy(() => import('../bots/BotPresenceSheet').then((module) => ({ default: module.BotPresenceSheet })))
const BotTasksSheet = lazy(() => import('../bots/BotTasksSheet').then((module) => ({ default: module.BotTasksSheet })))
const BotMenuSheet = lazy(() => import('../bots/BotMenuSheet').then((module) => ({ default: module.BotMenuSheet })))
const NewBotSheet = lazy(() => import('../bots/NewBotSheet').then((module) => ({ default: module.NewBotSheet })))

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
  const connection = useConnection()
  const join = useAutoJoin()
  const [tab, setTab] = useState<SidebarTab>(savedTab)
  const [notice, setNotice] = useState<string>()
  const [newBotOpen, setNewBotOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  // The bot whose long-press options are open in the Chats tab (merged key).
  const [botOptionsKey, setBotOptionsKey] = useState<string>()
  // The thread whose options are open (its merged key), and what the last option said when it finished.
  const [optionsKey, setOptionsKey] = useState<string>()
  const [optionsNotice, setOptionsNotice] = useState<{ text: string; error?: boolean; undo?: () => void }>()
  const optionsResult = useCallback((result: ThreadOptionsResult | { error: string }) => {
    setOptionsNotice('error' in result ? { text: result.error, error: true } : { text: result.message, ...(result.undo ? { undo: result.undo } : {}) })
  }, [])
  const closeOptions = useCallback(() => setOptionsKey(undefined), [])
  const openOptions = useCallback((thread: ListThread) => { setOptionsNotice(undefined); setOptionsKey(thread.id) }, [])
  useEffect(() => {
    if (!optionsNotice || optionsNotice.error) return
    const timer = setTimeout(() => setOptionsNotice(undefined), 6_000)
    return () => clearTimeout(timer)
  }, [optionsNotice])

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
    const offLan = connection.onComputersChange?.(reload)
    return () => { clearInterval(timer); off(); offLan?.() }
  }, [reload, connection])
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
    setOptionsNotice(undefined)
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
  // New bot and new project are made on the computer last used, or the first one online.
  const online = enrolled.filter((computer) => !isOffline(computer, views.get(computer.nodeId)))
  const last = loadLastComputer()
  const createComputer = online.find((computer) => computer.nodeId === last) ?? online[0]
  const projectCreated = useCallback((_project: Project) => {
    setNewProjectOpen(false)
    // The project shows on the Projects tab once the computer's lists say so.
    changeTab('projects')
  }, [changeTab])
  const created = useCallback((bot: ListBot) => {
    setNewBotOpen(false)
    if (!createComputer) return
    const route = { name: 'bot' as const, nodeId: createComputer.nodeId, botId: bot.id }
    if (open && wide) router.replace(route)
    else router.push(route)
  }, [createComputer, open, wide, router])

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
  // The dock's round button makes what the open tab lists.
  const actions: Record<typeof tab, DockAction> = {
    projects: { label: 'New project', icon: FolderPlus, disabled: !createComputer, onClick: () => setNewProjectOpen(true) },
    threads: { label: 'New thread', icon: MessageSquarePlus, disabled: !enrolled.length, onClick: () => router.push({ name: 'new' }) },
    chats: { label: 'New bot', icon: Plus, disabled: !createComputer, onClick: () => setNewBotOpen(true) },
  }

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
      {optionsNotice && (
        <Notice tone={optionsNotice.error ? 'error' : 'info'}>
          <span className="m-options-notice">
            <span>{optionsNotice.text}</span>
            {optionsNotice.undo && <Button variant="ghost" onClick={() => { optionsNotice.undo?.(); setOptionsNotice(undefined) }}>Undo</Button>}
          </span>
        </Notice>
      )}
    </>
  )

  let list: ReactNode
  if (lists) {
    list = (
      <ErrorBoundary what={tab === 'chats' ? 'the Chats tab' : tab === 'projects' ? 'the Projects tab' : 'the thread list'} resetKey={tab}>
      <Sidebar
        lists={lists}
        tab={tab}
        selectedId={selected ? mergedKey(selected.nodeId, selected.threadId) : undefined}
        onOpenThread={openThread}
        onOpenChat={openChat}
        onNewThread={newThreadIn}
        onOpenBot={openBot}
        onBotOptions={(bot) => setBotOptionsKey(bot.id)}
        onNewBot={() => setNewBotOpen(true)}
        canMakeBots={!!createComputer}
        {...(selectedBot ? { selectedBotId: mergedKey(selectedBot.nodeId, selectedBot.botId) } : {})}
        banner={banner}
        order="recent"
        {...(labelled ? { computerOf } : {})}
        onThreadOptions={openOptions}
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
  const createComputerName = selectedBot ? byNode.get(selectedBot.nodeId)?.name : undefined
  const pane = selected
    ? <ThreadPane nodeId={selected.nodeId} threadId={selected.threadId} name={selectedComputer?.name ?? 'Computer'} wide={wide} />
    : selectedBot ? <ErrorBoundary what="this bot's chat" resetKey={selectedBot.botId}><BotPane nodeId={selectedBot.nodeId} botId={selectedBot.botId} name={createComputerName ?? 'Computer'} labelled={labelled} wide={wide} /></ErrorBoundary> : null
  const threadOptions = (
    <ThreadOptionsHost threadKey={optionsKey} views={views} computerOf={computerOf} showComputer={labelled} onResult={optionsResult} onClose={closeOptions} />
  )
  const botOptions = botOptionsKey ? (() => {
    const key = splitKey(botOptionsKey)
    return key ? <SidebarBotMenuHost key={botOptionsKey} nodeId={key.nodeId} botId={key.id} onClose={() => setBotOptionsKey(undefined)} onOpenBot={() => { setBotOptionsKey(undefined); router.push({ name: 'bot', nodeId: key.nodeId, botId: key.id }) }} /> : null
  })() : null
  const newBot = createComputer && (
    <NewBotHost
      key={createComputer.nodeId}
      open={newBotOpen}
      nodeId={createComputer.nodeId}
      computerName={labelled ? createComputer.name : undefined}
      onClose={() => setNewBotOpen(false)}
      onCreated={created}
    />
  )
  const newProject = createComputer && (
    <NewProjectHost
      key={`project:${createComputer.nodeId}`}
      open={newProjectOpen}
      nodeId={createComputer.nodeId}
      computerName={createComputer.name}
      onClose={() => setNewProjectOpen(false)}
      onCreated={projectCreated}
    />
  )
  const title = TAB_META[tab].label
  // The dock shows with the lists; until then there is nothing for its tabs to show.
  const home = (
    <div className="m-home" data-dock={lists ? '' : undefined}>
      <div className="m-scroll m-home__scroll"><div className="m-content">{list}</div></div>
      {lists && <HomeDock tab={tab} onTab={changeTab} action={actions[tab]} />}
    </div>
  )

  if (!wide) {
    if (pane) return pane
    return (
      <main className="m-screen">
        <TopBar leading={<span className="m-topbar__brand"><MousseLogo size={24} /></span>} title={title} trailing={settings} />
        {home}
        {newBot}
        {newProject}
        {threadOptions}
        {botOptions}
      </main>
    )
  }

  return (
    <main className="m-screen m-split">
      <aside className="m-split__list">
        <TopBar leading={<span className="m-topbar__brand"><MousseLogo size={24} /></span>} title={title} trailing={settings} />
        {home}
      </aside>
      <section className="m-split__detail">
        {pane ?? (
          <div className="m-split__empty">
            {tab === 'chats' ? (
              <div className="bot-empty-page">
                <Mascot size={96} />
                <h2 className="bot-empty-page__title">Talk to your bots and agents</h2>
                <p className="bot-empty-page__body">Pick a bot or chat on the left, or make a new bot.</p>
                {createComputer && <Button variant="primary" onClick={() => setNewBotOpen(true)}>New bot</Button>}
              </div>
            ) : (
              <EmptyState title="Pick a thread" body="Choose a thread or chat, or start a new one." />
            )}
          </div>
        )}
      </section>
      {newBot}
      {newProject}
      {threadOptions}
      {botOptions}
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
  const thread = lists?.threads.find((entry) => entry.id === threadId)
  const title = chat?.name ?? thread?.title ?? 'Thread'
  // Where the thread is, like the desktop title bar's path: its project, then the computer it runs on.
  const projectName = thread?.projectId ? lists?.projects.find((entry) => entry.id === thread.projectId)?.name : undefined
  const subtitle = chat ? `Chat · ${name}` : projectName ? `${projectName} · ${name}` : name
  const back = wide ? undefined : <IconButton label="Back" onClick={router.pop}><ChevronLeft size={22} /></IconButton>
  // If a bot started this thread, show a breadcrumb bar back to that bot's chat (desktop BotThreadHeader).
  const launcher = lists?.bots?.find((entry) => entry.threads?.some((launched) => launched.threadId === threadId))
  const launchedThread = launcher?.threads?.find((launched) => launched.threadId === threadId)
  const botBanner = launcher ? (
    <BotThreadHeader
      bot={launcher}
      thread={launchedThread}
      onBackToBot={() => router.replace({ name: 'bot', nodeId, botId: launcher.id })}
    />
  ) : null

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
    return <><TopBar title={title} subtitle={subtitle} />{botBanner}{body}</>
  }
  return (
    <main className="m-screen">
      <TopBar leading={back} title={title} subtitle={subtitle} />
      {botBanner}
      {body}
    </main>
  )
}

function NewBotHost({ open, nodeId, computerName, onClose, onCreated }: { open: boolean; nodeId: string; computerName?: string; onClose(): void; onCreated(bot: ListBot): void }) {
  const { session, lists } = useComputer(nodeId)
  const [opened, setOpened] = useState(open)
  useEffect(() => { if (open) setOpened(true) }, [open])
  if (!opened && !open) return null
  return <BotBoundary resetKey={open}><Suspense fallback={null}><NewBotSheet open={open} computerName={computerName} bots={session?.bots} existing={lists?.bots ?? []} onClose={onClose} onCreated={onCreated} /></Suspense></BotBoundary>
}

function NewProjectHost({ open, nodeId, computerName, onClose, onCreated }: { open: boolean; nodeId: string; computerName: string; onClose(): void; onCreated(project: Project): void }) {
  const { session, lists } = useComputer(nodeId)
  const projectPaths = useMemo(() => (lists?.projects ?? []).flatMap((project) => (project.path ? [project.path] : [])), [lists?.projects])
  const openProject = session?.openProject?.bind(session)
  return <NewProjectSheet open={open} computerName={computerName} {...(openProject ? { openProject } : {})} projectPaths={projectPaths} onClose={onClose} onCreated={onCreated} />
}

function SidebarBotMenuHost({ nodeId, botId, onClose, onOpenBot }: { nodeId: string; botId: string; onClose(): void; onOpenBot(): void }) {
  const { session, lists } = useComputer(nodeId)
  const bot = lists?.bots?.find((entry) => entry.id === botId)
  if (!bot) return null
  return (
    <BotBoundary resetKey={botId}>
      <Suspense fallback={null}>
        <BotMenuSheet
          open
          bot={bot}
          bots={session?.bots}
          existing={lists?.bots ?? []}
          onClose={onClose}
          onAbout={onOpenBot}
        />
      </Suspense>
    </BotBoundary>
  )
}

/** One bot's chat on its computer, or why it cannot open. */
function BotPane({ nodeId, botId, name, labelled, wide }: { nodeId: string; botId: string; name: string; labelled: boolean; wide: boolean }) {
  const router = useRouter()
  const computer = useComputer(nodeId)
  const { link, lists, session, store } = computer
  const [about, setAbout] = useState(false)
  const [memory, setMemory] = useState<{ open: boolean; focus?: string }>({ open: false })
  const [presenceOpen, setPresenceOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [menu, setMenu] = useState<{ open: boolean; view: BotMenuView }>({ open: false, view: 'menu' })
  const [findSignal, setFindSignal] = useState(0)
  const [prefill, setPrefill] = useState<{ text: string; key: number; append?: boolean }>()
  const [error, setError] = useState<string>()
  const bot = lists?.bots?.find((entry) => entry.id === botId)
  const back = wide ? undefined : <IconButton label="Back" onClick={router.pop}><ChevronLeft size={22} /></IconButton>
  const more = bot && session?.bots
    ? <IconButton label="Bot menu" onClick={() => setMenu({ open: true, view: 'menu' })}><MoreHorizontal /></IconButton>
    : undefined

  const openThread = useCallback((threadId: string) => {
    router.push({ name: 'thread', nodeId, threadId })
  }, [router, nodeId])

  const openMemory = useCallback((focus?: string) => {
    setMemory({ open: true, ...(focus ? { focus } : {}) })
  }, [])

  const askAboutMemory = useCallback((text: string) => {
    setPrefill({ text: `"${text}"\n\n`, key: Date.now(), append: true })
  }, [])

  let body: ReactNode
  if (link === 'removed') {
    body = <div className="m-scroll"><div className="m-content"><Notice>{`${name} removed this phone.`}</Notice><Button onClick={() => router.reset()}>Back to threads</Button></div></div>
  } else if (session && lists && !bot) {
    body = <div className="m-scroll"><div className="m-content"><EmptyState title="This bot is gone" body={`It was deleted on ${name}.`} /></div></div>
  } else if (session && bot && !session.bots) {
    body = <div className="m-scroll"><div className="m-content"><Notice tone="info">{`Update Mousse on ${name} to chat with ${bot.name} from this phone.`}</Notice></div></div>
  } else if (session && bot && session.bots) {
    const botsApi = session.bots
    body = <>
      {error && <div className="m-content"><Notice>{error}</Notice></div>}
      <BotBoundary resetKey={botId} fallback={(retry) => (
        <div className="m-scroll"><div className="m-content"><Notice>{`Couldn't show ${bot.name}'s chat.`}</Notice><Button onClick={retry}>Try again</Button></div></div>
      )}>
        <Suspense fallback={<div className="m-scroll"><div className="m-content"><div className="m-loading"><Spinner label="Loading" /></div></div></div>}>
          <BotChat
            bot={bot}
            allBots={lists?.bots ?? []}
            bots={botsApi}
            findSignal={findSignal}
            prefill={prefill}
            onOpenMemory={openMemory}
            onOpenAbout={() => setAbout(true)}
            onOpenThread={openThread}
          />
        </Suspense>
      </BotBoundary>
      <BotBoundary resetKey={about}>
        <Suspense fallback={null}>
          <BotAboutSheet
            open={about}
            bot={bot}
            bots={botsApi}
            onClose={() => setAbout(false)}
            onError={setError}
            onOpenMemory={() => openMemory()}
            onOpenRename={() => setMenu({ open: true, view: 'rename' })}
            onOpenLook={() => setMenu({ open: true, view: 'look' })}
          />
        </Suspense>
      </BotBoundary>
      {memory.open && (
        <BotBoundary resetKey={memory.open}>
          <Suspense fallback={null}>
            <BotMemorySheet
              open={memory.open}
              bot={bot}
              bots={botsApi}
              focus={memory.focus}
              onClose={() => setMemory({ open: false })}
              onAskAbout={askAboutMemory}
            />
          </Suspense>
        </BotBoundary>
      )}
      {presenceOpen && (
        <BotBoundary resetKey={presenceOpen}>
          <Suspense fallback={null}>
            <BotPresenceSheet
              open={presenceOpen}
              bot={bot}
              onClose={() => setPresenceOpen(false)}
              onStopWork={(workId) => void botsApi.stopWork(bot.id, workId).catch((failure) => setError(failure instanceof Error ? failure.message : 'Something went wrong.'))}
              onOpenThread={openThread}
            />
          </Suspense>
        </BotBoundary>
      )}
      {tasksOpen && (
        <BotBoundary resetKey={tasksOpen}>
          <Suspense fallback={null}>
            <BotTasksSheet
              open={tasksOpen}
              botName={bot.name}
              tasks={bot.tasks}
              onClose={() => setTasksOpen(false)}
            />
          </Suspense>
        </BotBoundary>
      )}
      {menu.open && (
        <BotBoundary resetKey={`${menu.open}:${menu.view}`}>
          <Suspense fallback={null}>
            <BotMenuSheet
              open={menu.open}
              initialView={menu.view}
              bot={bot}
              bots={botsApi}
              existing={lists?.bots ?? []}
              onClose={() => setMenu({ open: false, view: 'menu' })}
              onAbout={() => setAbout(true)}
              onFind={() => setFindSignal((value) => value + 1)}
            />
          </Suspense>
        </BotBoundary>
      )}
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
  const title = bot?.name ?? 'Bot'
  const subtitle = !bot || labelled ? name : undefined
  const header = (
    <BotHeader
      bot={bot}
      name={title}
      {...(subtitle ? { computer: subtitle } : {})}
      leading={back}
      trailing={more}
      onAbout={bot && session?.bots ? () => setAbout(true) : undefined}
      onPresence={bot ? () => setPresenceOpen(true) : undefined}
      onTasks={bot ? () => setTasksOpen(true) : undefined}
    />
  )
  if (wide) return <div className="bot-screen">{header}{body}</div>
  return (
    <main className="m-screen bot-screen">
      {header}
      {body}
    </main>
  )
}
