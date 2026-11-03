import { useEffect, useMemo, useState } from 'react'
import type { Computer } from '../../connection/types'
import { useComputer, useComputers } from '../hooks/connection'
import { errorMessage } from '../hooks/useAsync'
import { useRouter } from '../state/router'
import { Composer, type SendExtras } from '../components/Composer'
import { EmptyState } from '../components/EmptyState'
import { Check, ChevronDown, ChevronLeft, Folder, Monitor } from '../components/icons'
import { IconButton, ListRow, Notice, StatusDot, TopBar } from '../components/primitives'
import { Sheet } from '../components/Sheet'
import { loadLastComputer, loadLastProject, saveLastComputer, saveLastProject } from '../lib/composerPrefs'
import { defaultComputer, defaultProject, sortedProjects, threadComputers } from '../lib/newThread'

/**
 * A new thread, like the desktop composer: a computer item and a project item above the message.
 * The computer starts as the one last used; sending creates the thread on it and opens it.
 */
export function NewThreadScreen({ nodeId: askedNode, projectId: askedProject }: { nodeId?: string; projectId?: string }) {
  const router = useRouter()
  const computers = useComputers()
  const usable = useMemo(() => threadComputers(computers.data ?? []), [computers.data])
  const [nodeId, setNodeId] = useState<string | undefined>(() => askedNode ?? defaultComputer(computers.data ?? [], loadLastComputer())?.nodeId)
  const [picking, setPicking] = useState(false)

  // The list may arrive after the screen opened.
  useEffect(() => {
    if (!nodeId && usable.length) setNodeId(defaultComputer(usable, loadLastComputer())?.nodeId)
  }, [nodeId, usable])

  const computer = usable.find((entry) => entry.nodeId === nodeId)
  const back = <IconButton label="Back" onClick={router.pop}><ChevronLeft size={22} /></IconButton>

  return (
    <main className="m-screen">
      <TopBar leading={back} title="New thread" />
      {computer ? (
        <NewThreadBody
          key={computer.nodeId}
          computer={computer}
          askedProject={computer.nodeId === askedNode ? askedProject : undefined}
          onPickComputer={() => setPicking(true)}
        />
      ) : (
        <div className="m-scroll"><div className="m-content">
          <EmptyState title="No computers yet" body="Threads run on your computers. They show here once this phone is added to them." />
        </div></div>
      )}
      <Sheet open={picking} title="Run on" onClose={() => setPicking(false)}>
        <div className="m-list">
          {usable.map((entry) => (
            <ListRow
              key={entry.nodeId}
              leading={<span className="m-row__icon"><Monitor /><StatusDot state={entry.online ? 'online' : 'offline'} /></span>}
              title={entry.name}
              detail={entry.online ? 'Online' : 'Offline'}
              trailing={entry.nodeId === nodeId ? <Check size={18} /> : undefined}
              onClick={() => { setNodeId(entry.nodeId); setPicking(false) }}
            />
          ))}
        </div>
      </Sheet>
    </main>
  )
}

function NewThreadBody({ computer, askedProject, onPickComputer }: { computer: Computer; askedProject?: string; onPickComputer(): void }) {
  const router = useRouter()
  const { lists, session, link, error: linkError } = useComputer(computer.nodeId)
  const projects = useMemo(() => sortedProjects(lists?.projects ?? []), [lists?.projects])
  const [projectId, setProjectId] = useState<string>()
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string>()

  // Until the user picks one: the project asked for, the last used, or the computer's first.
  const chosen = projectId ?? (lists ? defaultProject(projects, askedProject, loadLastProject(computer.nodeId)) : askedProject ?? '')
  const project = projects.find((entry) => entry.id === chosen)
  const projectLabel = project?.name ?? (chosen && !lists ? 'Project' : 'No project')

  const send = async (text: string, extras: SendExtras): Promise<boolean> => {
    if (!session) return false
    setError(undefined)
    try {
      const created = await session.createThread({ projectId: chosen })
      saveLastComputer(computer.nodeId)
      saveLastProject(computer.nodeId, chosen)
      await session.send(created.id, text, extras)
      router.replace({ name: 'thread', nodeId: computer.nodeId, threadId: created.id })
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    }
  }

  const status =
    link === 'open' ? undefined
    : link === 'error' || link === 'closed' ? linkError ?? `${computer.name} is offline. Open Mousse on it to start a thread there.`
    : link === 'removed' ? `${computer.name} removed this phone.`
    : !computer.online ? `${computer.name} is offline. Open Mousse on it to start a thread there.`
    : undefined

  return (
    <div className="m-thread m-thread--timeline">
      <div className="m-thread__scroll">
        <div className="m-transcript">
          <EmptyState title="What should we work on?" body={`Your message goes to ${computer.name}, which runs the work and streams the reply here.`} />
        </div>
      </div>
      <div className="m-thread__composer">
        {status && <Notice tone="info">{status}</Notice>}
        {error && <Notice>{error}</Notice>}
        <div className="m-composer__pills m-new-thread__where">
          <button type="button" className="m-pill m-pill--model" aria-label={`Computer: ${computer.name}`} aria-haspopup="dialog" onClick={onPickComputer}>
            <Monitor size={14} />
            <span className="m-pill__model">{computer.name}</span>
            <ChevronDown size={12} />
          </button>
          <button type="button" className="m-pill m-pill--model" aria-label={`Project: ${projectLabel}`} aria-haspopup="dialog" disabled={!lists} onClick={() => setPicking(true)}>
            <Folder size={14} />
            <span className="m-pill__model">{projectLabel}</span>
            <ChevronDown size={12} />
          </button>
        </div>
        <Composer
          active={false}
          disabled={!session}
          draftKey={`${computer.nodeId}.new`}
          speech={session?.speech}
          onSend={send}
          onStop={() => undefined}
        />
      </div>
      <Sheet open={picking} title={`Project on ${computer.name}`} onClose={() => setPicking(false)}>
        <div className="m-list">
          {projects.map((entry) => (
            <ListRow
              key={entry.id}
              leading={<Folder />}
              title={entry.name}
              detail={entry.path}
              trailing={entry.id === chosen ? <Check size={18} /> : undefined}
              onClick={() => { setProjectId(entry.id); setPicking(false) }}
            />
          ))}
          <ListRow
            leading={<Folder />}
            title="No project"
            trailing={chosen === '' ? <Check size={18} /> : undefined}
            onClick={() => { setProjectId(''); setPicking(false) }}
          />
        </div>
      </Sheet>
    </div>
  )
}
