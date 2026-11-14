import { useCallback } from 'react'
import type { ComputerView } from '../../connection/computerStore'
import type { ListThread } from '../../connection/types'
import { useConnectionContext } from '../hooks/connection'
import { splitKey } from './model'
import type { RowComputer } from './Sidebar'
import { ThreadOptionsSheet, type ThreadOptionsResult } from './ThreadOptionsSheet'

/**
 * The options of a thread in the merged list (`threadKey` is its merged key): the sheet acts on the computer that
 * runs the thread, and shows its options off, with the reason, while that computer cannot be reached.
 */
export function ThreadOptionsHost({ threadKey, views, computerOf, showComputer, onResult, onClose }: {
  threadKey?: string
  views: ReadonlyMap<string, ComputerView>
  computerOf(key: string): RowComputer | undefined
  showComputer: boolean
  onResult(result: ThreadOptionsResult | { error: string }): void
  onClose(): void
}) {
  const { computer } = useConnectionContext()
  const key = threadKey ? splitKey(threadKey) : undefined
  const view = key ? views.get(key.nodeId) : undefined
  const thread = key ? view?.lists?.threads.find((entry) => entry.id === key.id) : undefined
  const where = threadKey ? computerOf(threadKey) : undefined
  const name = where?.name ?? 'the computer'
  const session = view?.link === 'open' ? view.session : undefined
  const unavailable = where?.offline
    ? `${name} is offline. Change this thread when it is back.`
    : !session ? `Connecting to ${name}…` : undefined
  const nodeId = key?.nodeId
  const showLocally = useCallback(
    (threadId: string, patch: Partial<Omit<ListThread, 'id'>>) => (nodeId ? computer(nodeId).updateThread(threadId, patch) : () => undefined),
    [computer, nodeId],
  )
  return (
    <ThreadOptionsSheet
      {...(thread ? { thread } : {})}
      computerName={name}
      showComputer={showComputer}
      {...(session?.threadMenu ? { actions: session.threadMenu } : {})}
      {...(unavailable ? { unavailable } : {})}
      showLocally={showLocally}
      onResult={onResult}
      onClose={onClose}
    />
  )
}
