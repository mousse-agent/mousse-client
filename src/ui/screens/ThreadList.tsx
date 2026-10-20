import { useEffect, useMemo, useState } from 'react'
import type { ComputerSession, Project, ThreadSummary } from '../../connection/types'
import { useAsync } from '../hooks/useAsync'
import { Folder, Pin, Plus } from '../components/icons'
import { Button, ListRow, Notice, SearchField, SectionHeading, Spinner, StatusDot } from '../components/primitives'
import { Sheet } from '../components/Sheet'

function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

export interface ThreadListProps {
  session: ComputerSession
  selectedId?: string
  /** Bumped by the parent to refetch, e.g. after a turn ends. */
  refreshKey?: number
  onOpen(thread: ThreadSummary): void
}

export function ThreadList({ session, selectedId, refreshKey = 0, onOpen }: ThreadListProps) {
  const [query, setQuery] = useState('')
  const [projectId, setProjectId] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()
  const [showSettled, setShowSettled] = useState(false)
  const search = useDebounced(query.trim(), 200)

  const projects = useAsync(() => session.listProjects(), [session])
  const threads = useAsync(() => session.listThreads({ projectId, query: search || undefined }), [session, projectId, search, refreshKey])

  const projectNames = useMemo(() => new Map((projects.data ?? []).map((project) => [project.id, project.name])), [projects.data])
  const all = threads.data ?? []
  const pinned = all.filter((thread) => thread.pinned && !thread.settled)
  const recent = all.filter((thread) => !thread.pinned && !thread.settled)
  const settled = all.filter((thread) => thread.settled)

  async function create(project: Project) {
    setCreateError(undefined)
    try {
      const thread = await session.createThread({ projectId: project.id })
      setCreating(false)
      threads.reload()
      onOpen(thread)
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : 'Could not start a thread.')
    }
  }

  const row = (thread: ThreadSummary) => (
    <ListRow
      key={thread.id}
      active={thread.id === selectedId}
      leading={thread.active ? <StatusDot state="running" label="Working" /> : thread.pinned ? <Pin size={16} className="m-faint" /> : <span className="m-dot m-dot--idle" aria-hidden="true" />}
      title={thread.title}
      detail={[thread.projectId && !projectId ? projectNames.get(thread.projectId) : undefined, thread.active ? 'Working' : undefined].filter(Boolean).join(' · ') || undefined}
      trailing={<span className="m-row__time">{relativeTime(thread.updatedAt)}</span>}
      onClick={() => onOpen(thread)}
    />
  )

  return (
    <div className="m-threadlist">
      <div className="m-threadlist__tools">
        <SearchField value={query} onChange={setQuery} placeholder="Search threads" />
        {(projects.data?.length ?? 0) > 1 && (
          <div className="m-chips" role="group" aria-label="Filter by project">
            <button type="button" className="m-chip" aria-pressed={!projectId} onClick={() => setProjectId(undefined)}>All</button>
            {projects.data!.map((project) => (
              <button key={project.id} type="button" className="m-chip" aria-pressed={projectId === project.id} onClick={() => setProjectId(project.id)}>
                {project.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {threads.error && <Notice>{threads.error}</Notice>}
      {threads.loading && !threads.data && <div className="m-loading"><Spinner label="Loading threads" /></div>}
      {threads.data && all.length === 0 && (
        <p className="m-muted m-pad">{search ? `No threads match “${search}”.` : 'No threads yet.'}</p>
      )}

      {pinned.length > 0 && <><SectionHeading>Pinned</SectionHeading><div className="m-list">{pinned.map(row)}</div></>}
      {recent.length > 0 && <><SectionHeading>Recent</SectionHeading><div className="m-list">{recent.map(row)}</div></>}
      {settled.length > 0 && (
        <>
          <SectionHeading action={<button type="button" className="m-link" onClick={() => setShowSettled((value) => !value)}>{showSettled ? 'Hide' : `Show ${settled.length}`}</button>}>
            Settled
          </SectionHeading>
          {showSettled && <div className="m-list">{settled.map(row)}</div>}
        </>
      )}

      <div className="m-threadlist__new">
        <Button variant="primary" block icon={<Plus />} disabled={!projects.data?.length} onClick={() => setCreating(true)}>New thread</Button>
      </div>

      <Sheet open={creating} title="New thread in…" onClose={() => setCreating(false)}>
        {createError && <Notice>{createError}</Notice>}
        <div className="m-list">
          {(projects.data ?? []).map((project) => (
            <ListRow key={project.id} leading={<Folder />} title={project.name} detail={project.path} onClick={() => void create(project)} />
          ))}
        </div>
      </Sheet>
    </div>
  )
}
