import { useCallback, useEffect, useState } from 'react'
import type { ComputerSession, SessionEndReason, ThreadSummary } from '../../connection/types'
import { useConnectionContext } from '../hooks/connection'
import { useIsWide } from '../hooks/useMediaQuery'
import { useSession } from '../hooks/useSession'
import { useRouter } from '../state/router'
import { useAsync } from '../hooks/useAsync'
import { EmptyState } from '../components/EmptyState'
import { ChevronLeft, Settings } from '../components/icons'
import { Button, IconButton, Notice, Spinner, StatusDot, TopBar } from '../components/primitives'
import { ThreadList } from './ThreadList'
import { ThreadView } from './ThreadView'

/**
 * One computer's threads. Phones show the list or the open thread; at 768px
 * and wider both sit side by side and the right pane shows the orb until a
 * thread is picked.
 */
export function ComputerScreen({ nodeId, threadId }: { nodeId: string; threadId?: string }) {
  const router = useRouter()
  const { connection, dropSession } = useConnectionContext()
  const wide = useIsWide()
  const session = useSession(nodeId)
  const computers = useAsync(() => connection.listComputers(), [connection])
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [refreshKey, setRefreshKey] = useState(0)
  const [ended, setEnded] = useState<{ session: ComputerSession; reason: SessionEndReason }>()
  const live = session.data
  const reloadComputers = computers.reload

  // A closed session stops looking connected; the list is read again so a removed phone shows as not added.
  useEffect(() => {
    if (!live) return undefined
    const check = () => {
      if (live.state() !== 'closed') return
      setEnded((current) => current?.session === live ? current : { session: live, reason: live.endReason() ?? 'ended' })
      reloadComputers()
    }
    check()
    return live.onStateChange(check)
  }, [live, reloadComputers])

  useEffect(() => {
    if (session.error) reloadComputers()
  }, [session.error, reloadComputers])

  // Deep links and restored routes arrive without a title; look it up once.
  const lookup = useAsync(async () => {
    if (!threadId || titles[threadId] || !session.data) return undefined
    const threads = await session.data.listThreads()
    return threads.find((thread) => thread.id === threadId)?.title
  }, [threadId, session.data])
  const lookedUpTitle = lookup.data

  const computer = computers.data?.find((entry) => entry.nodeId === nodeId)
  const computerName = computer?.name ?? 'Computer'

  const openThread = useCallback((thread: ThreadSummary) => {
    setTitles((current) => ({ ...current, [thread.id]: thread.title }))
    const route = { name: 'thread' as const, nodeId, threadId: thread.id }
    if (threadId && wide) router.replace(route)
    else router.push(route)
  }, [nodeId, threadId, wide, router])

  const onActivityChange = useCallback(() => setRefreshKey((value) => value + 1), [])

  const back = <IconButton label="Back" onClick={router.pop}><ChevronLeft size={22} /></IconButton>
  const settings = <IconButton label="Settings" onClick={() => router.push({ name: 'settings' })}><Settings /></IconButton>
  const presence = computer ? <><StatusDot state={computer.online ? 'online' : 'offline'} /> {computer.online ? 'Online' : 'Offline'}</> : undefined

  const endedReason = ended && ended.session === live ? ended.reason : undefined
  const removed = endedReason === 'removed' || (!!session.error && computer?.enrolled === false)
  const retry = () => { dropSession(nodeId); session.reload() }

  if (removed) {
    return (
      <main className="m-screen">
        <TopBar leading={back} title={computerName} />
        <div className="m-scroll"><div className="m-content">
          <Notice>{`${computerName} removed this phone. Add it again to reconnect.`}</Notice>
          <Button onClick={() => router.reset()}>Back to computers</Button>
        </div></div>
      </main>
    )
  }

  if (endedReason === 'ended' && !session.loading) {
    return (
      <main className="m-screen">
        <TopBar leading={back} title={computerName} />
        <div className="m-scroll"><div className="m-content">
          <Notice>{`Lost the connection to ${computerName}.`}</Notice>
          <Button onClick={retry}>Try again</Button>
        </div></div>
      </main>
    )
  }

  if (session.error || (session.loading && (!session.data || endedReason)) || !live) {
    return (
      <main className="m-screen">
        <TopBar leading={back} title={computerName} />
        <div className="m-scroll"><div className="m-content">
          {session.error ? (
            <>
              <Notice>{session.error}</Notice>
              <Button onClick={retry}>Try again</Button>
            </>
          ) : <div className="m-loading"><Spinner label={`Connecting to ${computerName}`} /><span>Connecting to {computerName}…</span></div>}
        </div></div>
      </main>
    )
  }

  const threadTitle = threadId ? titles[threadId] ?? lookedUpTitle ?? 'Thread' : undefined
  const list = (
    <ThreadList session={live} selectedId={threadId} refreshKey={refreshKey} onOpen={openThread} />
  )

  if (!wide) {
    if (threadId) {
      return (
        <main className="m-screen">
          <TopBar leading={back} title={threadTitle} subtitle={computerName} />
          <ThreadView session={live} threadId={threadId} onActivityChange={onActivityChange} />
        </main>
      )
    }
    return (
      <main className="m-screen">
        <TopBar leading={back} title={computerName} subtitle={presence} trailing={settings} />
        <div className="m-scroll"><div className="m-content">{list}</div></div>
      </main>
    )
  }

  return (
    <main className="m-screen m-split">
      <aside className="m-split__list">
        <TopBar leading={<IconButton label="All computers" onClick={() => router.reset()}><ChevronLeft size={22} /></IconButton>} title={computerName} subtitle={presence} trailing={settings} />
        <div className="m-scroll"><div className="m-content">{list}</div></div>
      </aside>
      <section className="m-split__detail">
        {threadId ? (
          <>
            <TopBar title={threadTitle} subtitle={computerName} />
            <ThreadView session={live} threadId={threadId} onActivityChange={onActivityChange} />
          </>
        ) : (
          <div className="m-split__empty">
            <EmptyState title="Pick a thread" body={`Choose a thread on ${computerName}, or start a new one.`} />
          </div>
        )}
      </section>
    </main>
  )
}
