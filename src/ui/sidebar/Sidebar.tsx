// The phone's version of the desktop sidebar: the Projects / Threads / Chats tab pill and the three
// lists, drawn from a computer's live lists. Rows, status icons and colours follow
// mousse/src/renderer/components/ThreadsSidebar.tsx and chats/ChatsSidebar.tsx.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import '../bots/bots.css'
import type { ListBot } from '../../connection/bots'
import type { ComputerLists, ListChat, ListProject, ListThread, ThreadStatus } from '../../connection/types'
import { BotFace } from '../bots/face/BotFace'
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Folder,
  FolderKanban,
  FolderOpen,
  GitBranch,
  ListTree,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  Monitor,
  Pin,
  Plus,
  type IconComponent,
} from '../components/icons'
import { IconButton, SearchField, SectionHeading } from '../components/primitives'
import {
  chatColor,
  chatPreview,
  PROJECT_PREVIEW_LIMIT,
  projectHue,
  projectInitials,
  SIDEBAR_TABS,
  sidebarModel,
  threadAge,
  type SidebarTab,
} from './model'
import './sidebar.css'

const TAB_META: Record<SidebarTab, { label: string; icon: IconComponent }> = {
  projects: { label: 'Projects', icon: FolderKanban },
  threads: { label: 'Threads', icon: ListTree },
  chats: { label: 'Chats', icon: MessagesSquare },
}

/** The desktop's segmented tab pill: icon-only tabs, the active one raised with its label. */
export function SidebarTabs({ value, onChange }: { value: SidebarTab; onChange(tab: SidebarTab): void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = SIDEBAR_TABS.indexOf(value)
    const next =
      event.key === 'ArrowRight' ? SIDEBAR_TABS[(index + 1) % SIDEBAR_TABS.length]
      : event.key === 'ArrowLeft' ? SIDEBAR_TABS[(index + SIDEBAR_TABS.length - 1) % SIDEBAR_TABS.length]
      : event.key === 'Home' ? SIDEBAR_TABS[0]
      : event.key === 'End' ? SIDEBAR_TABS[SIDEBAR_TABS.length - 1]
      : undefined
    if (!next) return
    event.preventDefault()
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div className="m-sidebar-tabs" role="tablist" aria-label="Sidebar view" onKeyDown={move}>
      {SIDEBAR_TABS.map((tab) => {
        const { label, icon: Icon } = TAB_META[tab]
        const active = tab === value
        return (
          <button
            key={tab}
            ref={(element) => { refs.current[tab] = element }}
            type="button"
            role="tab"
            id={`m-sidebar-tab-${tab}`}
            aria-selected={active}
            aria-controls={`m-sidebar-panel-${tab}`}
            aria-label={label}
            title={label}
            tabIndex={active ? 0 : -1}
            className={`m-sidebar-tab${active ? ' is-active' : ''}`}
            onClick={() => onChange(tab)}
          >
            <Icon size={17} strokeWidth={1.8} />
            {active && <span>{label}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** The status icon of a compact row (Projects tab). Idle threads show nothing. */
export function StatusIcon({ status }: { status?: ThreadStatus }) {
  switch (status?.state) {
    case 'processing':
      return <Loader2 size={15} className="m-sb-status m-sb-status--running m-sb-spin" aria-label="Working" />
    case 'awaiting_input':
      return <CircleAlert size={15} className="m-sb-status m-sb-status--waiting" aria-label="Agent has a question" />
    case 'completed':
      return <CircleCheck size={15} className="m-sb-status m-sb-status--done" aria-label="Agent finished" />
    case 'failed':
      return <CircleAlert size={15} className="m-sb-status m-sb-status--error" aria-label={status.error ? `Failed: ${status.error}` : 'Failed'} />
    default:
      return null
  }
}

/** The right side of a card's meta line: Working 3m, Waiting, Done, Failed, or the age. */
function CardStatus({ thread, status, now }: { thread: ListThread; status?: ThreadStatus; now: number }) {
  switch (status?.state) {
    case 'processing': {
      const age = threadAge(status.since ?? thread.updatedAt, now)
      return (
        <span className="m-sb-card__status m-sb-card__status--working">
          <Loader2 size={12} strokeWidth={2} className="m-sb-spin" aria-hidden="true" />
          Working{age && age !== 'now' ? ` ${age}` : ''}
        </span>
      )
    }
    case 'awaiting_input':
      return <span className="m-sb-card__status m-sb-card__status--waiting"><CircleAlert size={12} strokeWidth={2} aria-hidden="true" />Waiting</span>
    case 'completed':
      return <span className="m-sb-card__status m-sb-card__status--done"><CircleCheck size={12} strokeWidth={2} aria-hidden="true" />Done</span>
    case 'failed':
      return <span className="m-sb-card__status m-sb-card__status--error" title={status.error}><CircleAlert size={12} strokeWidth={2} aria-hidden="true" />Failed</span>
    default:
      return <span className="m-sb-card__age">{threadAge(thread.updatedAt, now)}</span>
  }
}

/** Which computer a row is on, as the desktop marks a thread of another computer. */
export interface RowComputer {
  name: string
  /** The computer cannot be reached; the row comes from the saved lists. */
  offline?: boolean
}

/** The computer's name beside its icon, and "offline" when the row comes from the saved lists. */
function ComputerMark({ computer }: { computer: RowComputer }) {
  const title = computer.offline ? `Runs on ${computer.name} · Offline` : `Runs on ${computer.name}`
  return (
    <span className="m-sb-computer" data-state={computer.offline ? 'offline' : 'online'} title={title}>
      <Monitor size={11} strokeWidth={2} aria-hidden="true" />
      <span className="m-sb-computer__name">{computer.name}</span>
      {computer.offline && <span className="m-sb-computer__state">offline</span>}
    </span>
  )
}

function ThreadCard({ thread, projectName, status, active, now, computer, onOpen }: {
  thread: ListThread
  projectName?: string
  status?: ThreadStatus
  active: boolean
  now: number
  computer?: RowComputer
  onOpen(): void
}) {
  return (
    <button type="button" className={`m-sb-card${active ? ' is-active' : ''}${thread.settled ? ' is-settled' : ''}`} aria-current={active ? 'true' : undefined} onClick={onOpen}>
      {projectName && thread.projectId ? (
        <span className="m-sb-card__mark" style={{ color: `var(--hue-${projectHue(thread.projectId)})` }} aria-hidden="true">{projectInitials(projectName)}</span>
      ) : (
        <span className="m-sb-card__mark m-sb-card__mark--empty" aria-hidden="true"><Folder size={13} strokeWidth={1.8} /></span>
      )}
      <span className="m-sb-card__body">
        <span className="m-sb-card__meta">
          <span className="m-sb-card__project">{projectName ?? 'No project'}</span>
          <CardStatus thread={thread} status={status} now={now} />
        </span>
        <span className="m-sb-card__title">
          {thread.pinned && <Pin size={11} strokeWidth={2} aria-label="Pinned" />}
          {thread.title}
        </span>
        {(thread.worktree || computer) && (
          <span className="m-sb-card__sub">
            {computer && <ComputerMark computer={computer} />}
            {thread.worktree && <><GitBranch size={11} strokeWidth={2} aria-hidden="true" />Worktree</>}
          </span>
        )}
      </span>
    </button>
  )
}

function ThreadRow({ thread, status, active, onOpen }: { thread: ListThread; status?: ThreadStatus; active: boolean; onOpen(): void }) {
  return (
    <button type="button" className={`m-sb-row${active ? ' is-active' : ''}`} aria-current={active ? 'true' : undefined} onClick={onOpen}>
      {thread.pinned && <Pin size={12} strokeWidth={2} className="m-sb-row__pin" aria-label="Pinned" />}
      <span className="m-sb-row__title">{thread.title}</span>
      <span className="m-sb-row__trailing">
        <StatusIcon status={status} />
        {thread.worktree && <GitBranch size={13} className="m-faint" aria-label="Worktree" />}
      </span>
    </button>
  )
}

function Collapsible({ title, count, open, onToggle, children }: { title: string; count: number; open: boolean; onToggle(): void; children: ReactNode }) {
  return (
    <section className="m-sb-section">
      <button type="button" className="m-sb-section__toggle" aria-expanded={open} onClick={onToggle}>
        <ChevronDown size={14} className={`m-sb-chevron${open ? ' is-open' : ''}`} aria-hidden="true" />
        <span>{title}</span>
        <span className="m-sb-section__count">{count}</span>
      </button>
      {open && children}
    </section>
  )
}

function ProjectGroup({ project, threads, lists, selectedId, computer, expanded, onToggle, onOpen, onNewThread }: {
  project: ListProject
  threads: ListThread[]
  lists: ComputerLists
  selectedId?: string
  computer?: RowComputer
  expanded: boolean
  onToggle(): void
  onOpen(thread: ListThread): void
  onNewThread?(project: ListProject): void
}) {
  const [all, setAll] = useState(false)
  const shown = all ? threads : threads.slice(0, PROJECT_PREVIEW_LIMIT)
  const busy = threads.some((thread) => lists.status[thread.id]?.state === 'processing')
  return (
    <div className="m-sb-project" style={{ ['--project-hue' as string]: `var(--hue-${projectHue(project.id)})` }}>
      <div className="m-sb-project__head">
        <button type="button" className="m-sb-project__row" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? <FolderOpen size={17} className="m-sb-project__icon" aria-hidden="true" /> : <Folder size={17} className="m-sb-project__icon" aria-hidden="true" />}
          <span className="m-sb-project__name">{project.name}</span>
          {computer && <ComputerMark computer={computer} />}
          {!expanded && busy && <Loader2 size={14} className="m-sb-status m-sb-status--running m-sb-spin" aria-label="Working" />}
          {!expanded && threads.length > 0 && <span className="m-sb-project__count">{threads.length}</span>}
        </button>
        {onNewThread && (
          <button type="button" className="m-sb-project__new" aria-label={`New thread in ${project.name}`} title="New thread" onClick={() => onNewThread(project)}>
            <MessageSquarePlus size={17} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="m-sb-children">
          {threads.length === 0 && <p className="m-sb-empty">No threads yet.</p>}
          {shown.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} status={lists.status[thread.id]} active={thread.id === selectedId} onOpen={() => onOpen(thread)} />
          ))}
          {threads.length > PROJECT_PREVIEW_LIMIT && (
            <button type="button" className="m-sb-more" onClick={() => setAll((value) => !value)}>{all ? 'Show less' : `Show ${threads.length - PROJECT_PREVIEW_LIMIT} more`}</button>
          )}
        </div>
      )}
    </div>
  )
}

export function ChatAvatar({ chat }: { chat: ListChat }) {
  const group = chat.kind === 'group'
  return <span className={`m-chat-avatar m-chat-color-${chatColor(chat.name)}${group ? ' is-group' : ''}`} aria-hidden="true">{group ? '#' : chat.name.slice(0, 1).toUpperCase()}</span>
}

function ChatRow({ chat, active, computer, onOpen }: { chat: ListChat; active: boolean; computer?: RowComputer; onOpen(): void }) {
  const working = chat.run?.state === 'running'
  return (
    <button type="button" className={`m-chat-row${active ? ' is-active' : ''}${chat.network ? ' is-network' : ''}`} aria-current={active ? 'true' : undefined} onClick={onOpen}>
      <ChatAvatar chat={chat} />
      <span className="m-chat-row__text">
        <span className="m-chat-row__name">{chat.name}</span>
        <span className="m-chat-row__preview">{computer && <span>{`${computer.name}${computer.offline ? ' (offline)' : ''} · `}</span>}{chatPreview(chat)}</span>
      </span>
      {working && <span className="m-chat-working-dot" role="img" aria-label="Working" />}
      {!working && chat.run?.state === 'failed' && <CircleAlert size={14} className="m-sb-status m-sb-status--error" aria-label="Failed" />}
    </button>
  )
}

/** A bot's row: its face holds the state's pose, and the row says the state in words. */
function BotRow({ bot, active, computer, onOpen }: { bot: ListBot; active: boolean; computer?: RowComputer; onOpen(): void }) {
  return (
    <button type="button" className={`m-chat-row${active ? ' is-active' : ''}`} aria-current={active ? 'true' : undefined} onClick={onOpen}>
      <BotFace look={bot.look} state={bot.state} size={40} view="head" still />
      <span className="m-chat-row__text">
        <span className="m-chat-row__name">{bot.name}</span>
        <span className="m-chat-row__preview">{computer && <span>{`${computer.name}${computer.offline ? ' (offline)' : ''} · `}</span>}{bot.stateText || bot.last?.text || bot.description}</span>
      </span>
      {bot.unread > 0 && <span className="bot-unread" aria-label={`${bot.unread} unread`}>{bot.unread}</span>}
    </button>
  )
}

export interface SidebarProps {
  lists: ComputerLists
  tab: SidebarTab
  onTab(tab: SidebarTab): void
  selectedId?: string
  onOpenThread(thread: ListThread): void
  onOpenChat(chat: ListChat): void
  onNewThread?(project: ListProject): void
  /** Opens a bot's chat; without it the Chats tab lists no bots. */
  onOpenBot?(bot: ListBot): void
  /** New bot; without it there is no + beside Bots. */
  onNewBot?(): void
  /** The open bot's id. */
  selectedBotId?: string
  /** Shown above the list, under the tabs: connection notices and the like. */
  banner?: ReactNode
  /** For lists merged from several computers: the computer of a row, by its id. Rows then name their computer. */
  computerOf?(id: string): RowComputer | undefined
  /** `recent` orders the Threads tab by activity, for merged lists. */
  order?: 'desktop' | 'recent'
}

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

export function Sidebar({ lists, tab, onTab, selectedId, onOpenThread, onOpenChat, onNewThread, onOpenBot, onNewBot, selectedBotId, banner, computerOf, order = 'desktop' }: SidebarProps) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [settledOpen, setSettledOpen] = useState(false)
  const [standaloneOpen, setStandaloneOpen] = useState(false)
  const now = useNow()
  const model = useMemo(() => sidebarModel(lists, query, order), [lists, query, order])

  // Like the desktop, the project holding the open thread starts expanded.
  const selectedProject = lists.threads.find((thread) => thread.id === selectedId)?.projectId
  useEffect(() => {
    if (selectedProject) setExpanded((current) => (current.has(selectedProject) ? current : new Set(current).add(selectedProject)))
  }, [selectedProject])
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current)
    if (!next.delete(id)) next.add(id)
    return next
  })
  const searching = !!query.trim()
  const needle = query.trim().toLowerCase()
  const bots = onOpenBot ? (lists.bots ?? []).filter((bot) => !needle || bot.name.toLowerCase().includes(needle)) : []
  // Recent: bot chats and direct chats together, the latest first (like the desktop).
  const recent = [
    ...model.direct.map((chat) => ({ at: chat.updatedAt, key: chat.id, row: () => <ChatRow key={chat.id} chat={chat} active={!!chat.threadId && chat.threadId === selectedId} computer={computerOf?.(chat.id)} onOpen={() => onOpenChat(chat)} /> })),
    ...bots.map((bot) => ({ at: Date.parse(bot.last?.at ?? bot.createdAt) || 0, key: bot.id, row: () => <BotRow key={`bot:${bot.id}`} bot={bot} active={bot.id === selectedBotId} computer={computerOf?.(bot.id)} onOpen={() => onOpenBot!(bot)} /> })),
  ].sort((a, b) => b.at - a.at)
  const projects = [...lists.projects].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  const card = (thread: ListThread) => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      projectName={thread.projectId ? model.projectNames.get(thread.projectId) : undefined}
      status={lists.status[thread.id]}
      active={thread.id === selectedId}
      now={now}
      computer={computerOf?.(thread.id)}
      onOpen={() => onOpenThread(thread)}
    />
  )

  return (
    <div className="m-sidebar">
      <div className="m-sidebar__top">
        <SidebarTabs value={tab} onChange={onTab} />
        <SearchField value={query} onChange={setQuery} placeholder={tab === 'chats' ? 'Search chats' : 'Search threads'} />
      </div>
      {banner}
      <div className="m-sidebar__panel" role="tabpanel" id={`m-sidebar-panel-${tab}`} aria-labelledby={`m-sidebar-tab-${tab}`}>
        {tab === 'projects' && (
          <>
            {projects.length === 0 && <p className="m-sb-empty">No projects yet.</p>}
            {projects.map((project) => {
              const threads = model.byProject.get(project.id) ?? []
              if (searching && !threads.length && !project.name.toLowerCase().includes(query.trim().toLowerCase())) return null
              return (
                <ProjectGroup
                  key={project.id}
                  project={project}
                  threads={threads}
                  lists={lists}
                  selectedId={selectedId}
                  computer={computerOf?.(project.id)}
                  expanded={searching || expanded.has(project.id)}
                  onToggle={() => toggle(project.id)}
                  onOpen={onOpenThread}
                  onNewThread={onNewThread}
                />
              )
            })}
            {model.standalone.length > 0 && (
              <Collapsible title="Recent chats" count={model.standalone.length} open={searching || standaloneOpen} onToggle={() => setStandaloneOpen((value) => !value)}>
                <div className="m-sb-children m-sb-children--flat">
                  {model.standalone.map((thread) => (
                    <ThreadRow key={thread.id} thread={thread} status={lists.status[thread.id]} active={thread.id === selectedId} onOpen={() => onOpenThread(thread)} />
                  ))}
                </div>
              </Collapsible>
            )}
          </>
        )}

        {tab === 'threads' && (
          <>
            {model.threads.length === 0 && <p className="m-sb-empty">{searching ? `No threads match “${query.trim()}”.` : 'No threads yet.'}</p>}
            <div className="m-sb-feed">{model.threads.map(card)}</div>
            {model.settled.length > 0 && (
              <Collapsible title="Settled" count={model.settled.length} open={settledOpen} onToggle={() => setSettledOpen((value) => !value)}>
                <div className="m-sb-feed">{model.settled.map(card)}</div>
              </Collapsible>
            )}
          </>
        )}

        {tab === 'chats' && (
          <>
            {onOpenBot && (
              <section aria-label="Bots">
                <SectionHeading action={onNewBot && <IconButton label="New bot" onClick={onNewBot}><Plus size={18} /></IconButton>}>Bots</SectionHeading>
                {bots.length > 0 ? (
                  <div className="bot-roster">
                    {bots.map((bot) => (
                      <button key={bot.id} type="button" className={bot.id === selectedBotId ? 'is-active' : ''} aria-label={`Message ${bot.name}`} onClick={() => onOpenBot(bot)}>
                        <BotFace look={bot.look} state={bot.state} size={48} view="head" />
                        <span>{bot.name}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="m-sb-empty">{searching ? `No bots match “${query.trim()}”.` : onNewBot ? 'No bots yet. Press + to make one.' : 'No bots yet.'}</p>
                )}
              </section>
            )}
            {model.groups.length + recent.length === 0 && (
              <p className="m-sb-empty">{searching ? `No chats match “${query.trim()}”.` : 'No chats yet. Start one with an agent on the computer.'}</p>
            )}
            {model.groups.length > 0 && (
              <>
                <SectionHeading>Groups</SectionHeading>
                <div className="m-chat-list">{model.groups.map((chat) => <ChatRow key={chat.id} chat={chat} active={!!chat.threadId && chat.threadId === selectedId} computer={computerOf?.(chat.id)} onOpen={() => onOpenChat(chat)} />)}</div>
              </>
            )}
            {recent.length > 0 && (
              <>
                <SectionHeading>Recent</SectionHeading>
                <div className="m-chat-list">{recent.map((entry) => entry.row())}</div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
