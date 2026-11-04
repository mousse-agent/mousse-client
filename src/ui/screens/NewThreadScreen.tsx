import { useEffect, useMemo, useState } from 'react'
import type { Computer, ComposerOptions, ComputerSession, ModelSelection } from '../../connection/types'
import { useComputer, useComputers } from '../hooks/connection'
import { errorMessage } from '../hooks/useAsync'
import { useRouter } from '../state/router'
import { Composer, type ComposerControls, type SendExtras } from '../components/Composer'
import { shownPermission } from '../components/ComposerSheets'
import { MousseLogoOutline } from '../components/MousseLogoOutline'
import { EmptyState } from '../components/EmptyState'
import { Check, ChevronDown, ChevronLeft, Folder, GitBranch, Monitor } from '../components/icons'
import { IconButton, ListRow, Notice, StatusDot, TopBar } from '../components/primitives'
import { Sheet } from '../components/Sheet'
import { loadFavorites, loadLastComputer, loadLastProject, saveFavorites, saveLastComputer, saveLastProject } from '../lib/composerPrefs'
import { defaultComputer, defaultProject, sortedProjects, threadComputers } from '../lib/newThread'

/**
 * A new thread, like the desktop's start page: the outline logo and "What should we build?" over the
 * composer, which carries the workspace strip (project, computer, worktree) as a tab on its top edge.
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
  const [worktree, setWorktree] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string>()
  const composer = useNewThreadControls(session, computer.name)

  // Until the user picks one: the project asked for, the last used, or the computer's first.
  const chosen = projectId ?? (lists ? defaultProject(projects, askedProject, loadLastProject(computer.nodeId)) : askedProject ?? '')
  const project = projects.find((entry) => entry.id === chosen)
  const projectLabel = project?.name ?? (chosen && !lists ? 'Project' : 'No project')

  const send = async (text: string, extras: SendExtras): Promise<boolean> => {
    if (!session) return false
    setError(undefined)
    try {
      const created = await session.createThread({ projectId: chosen, ...(chosen && worktree ? { worktreeEnabled: true } : {}) })
      saveLastComputer(computer.nodeId)
      saveLastProject(computer.nodeId, chosen)
      if (composer.picked) await session.setThreadModel(created.id, composer.picked)
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
    <div className="m-thread m-new-thread">
      <div className="m-new-thread__stage">
        <div className="m-new-thread__center">
          <MousseLogoOutline className="m-new-thread__logo" />
          <h2 className="m-new-thread__title">What should we build?</h2>
          {(status || error) && (
            <div className="m-new-thread__notices">
              {status && <Notice tone="info">{status}</Notice>}
              {error && <Notice>{error}</Notice>}
            </div>
          )}
          <div className="m-new-thread__composer">
            <div className="m-workspace" role="group" aria-label="New thread workspace">
              <button type="button" className="m-workspace__item m-workspace__item--project" aria-label={`Project: ${projectLabel}`} aria-haspopup="dialog" disabled={!lists} onClick={() => setPicking(true)}>
                <Folder size={15} />
                <span>{projectLabel}</span>
                <ChevronDown size={12} />
              </button>
              <button type="button" className="m-workspace__item" aria-label={`Computer: ${computer.name}`} aria-haspopup="dialog" onClick={onPickComputer}>
                <Monitor size={15} />
                <span>{computer.name}</span>
                <ChevronDown size={12} />
              </button>
              <button
                type="button"
                className="m-workspace__worktree"
                aria-label="Start in a worktree"
                aria-pressed={!!chosen && worktree}
                title={chosen ? `Worktree: ${worktree ? 'On' : 'Off'}` : 'Select a project to start in a worktree'}
                disabled={!chosen}
                onClick={() => setWorktree((value) => !value)}
              >
                <GitBranch size={16} />
              </button>
            </div>
            <Composer
              active={false}
              disabled={!session}
              draftKey={`${computer.nodeId}.new`}
              controls={composer.controls}
              speech={session?.speech}
              onSend={send}
              onStop={() => undefined}
            />
          </div>
        </div>
      </div>
      <Sheet open={picking} title={`Project on ${computer.name}`} onClose={() => setPicking(false)}>
        <div className="m-list">
          <ListRow
            leading={<Folder />}
            title="No project"
            trailing={chosen === '' ? <Check size={18} /> : undefined}
            onClick={() => { setProjectId(''); setWorktree(false); setPicking(false) }}
          />
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
        </div>
      </Sheet>
    </div>
  )
}

/**
 * The new thread's model, before the thread exists: the computer's default until the user picks one,
 * then set on the thread when it is created (the desktop keeps a new chat's pick the same way).
 */
function useNewThreadControls(session: ComputerSession | undefined, computerName: string): { controls?: ComposerControls; picked?: ModelSelection } {
  const [options, setOptions] = useState<ComposerOptions>()
  const [picked, setPicked] = useState<ModelSelection>()
  const [favorites, setFavorites] = useState(() => (session ? loadFavorites(session.nodeId) : new Set<string>()))

  useEffect(() => {
    if (!session) return undefined
    let cancelled = false
    setFavorites(loadFavorites(session.nodeId))
    session.composerOptions().then((value) => { if (!cancelled) setOptions(value) }, () => undefined)
    return () => { cancelled = true }
  }, [session])

  const selection = picked ?? options?.defaultModel
  const providerId = options && selection
    ? options.providers.find((provider) => selection.instanceId && provider.instanceId === selection.instanceId)?.id ?? selection.llmProvider
    : selection?.llmProvider
  const controls: ComposerControls | undefined = session && options ? {
    providers: options.providers,
    providerId,
    modelId: selection?.model,
    onSelectModel: (nextProvider, modelId) => {
      const provider = options.providers.find((entry) => entry.id === nextProvider)
      setPicked({ ...(provider?.instanceId ? { instanceId: provider.instanceId } : {}), llmProvider: nextProvider, model: modelId })
    },
    permission: shownPermission(options.permission, undefined, computerName),
    skills: options.skills,
    // A new thread has nothing to stop, steer or start again: only the skill picker applies.
    commands: options.commands.filter((command) => command.name === 'skills'),
    favorites,
    onToggleFavorite: (key) => setFavorites((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      saveFavorites(session.nodeId, next)
      return next
    }),
  } : undefined
  return { controls, ...(picked ? { picked } : {}) }
}
