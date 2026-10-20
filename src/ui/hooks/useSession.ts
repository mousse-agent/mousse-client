import type { ComputerSession } from '../../connection/types'
import { useConnectionContext } from './connection'
import { useAsync, type AsyncState } from './useAsync'

export function useSession(nodeId: string): AsyncState<ComputerSession> {
  const { session } = useConnectionContext()
  return useAsync(() => session(nodeId), [session, nodeId])
}
