// The home screen's footer: the Projects / Threads / Chats tab pill and, beside it, a round button that
// makes what the open tab lists (a project, a thread, a bot). Both float over the list at the bottom.
import { useRef, type KeyboardEvent } from 'react'
import { FolderKanban, ListTree, MessagesSquare, type IconComponent } from '../components/icons'
import { SIDEBAR_TABS, type SidebarTab } from './model'
import './homeDock.css'

export const TAB_META: Record<SidebarTab, { label: string; icon: IconComponent }> = {
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
            <Icon size={19} strokeWidth={1.8} />
            {active && <span>{label}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** What the round button makes on the open tab. */
export interface DockAction {
  label: string
  icon: IconComponent
  onClick(): void
  disabled?: boolean
}

export function HomeDock({ tab, onTab, action }: { tab: SidebarTab; onTab(tab: SidebarTab): void; action: DockAction }) {
  const Icon = action.icon
  return (
    <nav className="m-dock" aria-label="Home">
      <SidebarTabs value={tab} onChange={onTab} />
      <button type="button" className="m-dock__create" aria-label={action.label} title={action.label} disabled={action.disabled} onClick={action.onClick}>
        {/* Keyed by tab so the new icon eases in when the tab changes. */}
        <Icon key={tab} size={22} strokeWidth={2} className="m-dock__create-icon" />
      </button>
    </nav>
  )
}
