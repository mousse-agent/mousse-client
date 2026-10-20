import type { Route } from '../state/router'

/**
 * Dev-only deep links for the fake connection, used for screenshots:
 *   ?signedIn&screen=computer:node-studio
 *   ?signedIn&screen=thread:node-studio:t-redesign
 *   ?signedIn&screen=settings
 */
export function demoRoutesFromQuery(search: string): Route[] | undefined {
  const screen = new URLSearchParams(search).get('screen')
  if (!screen) return undefined
  const [name, nodeId, threadId] = screen.split(':')
  const root: Route = { name: 'computers' }
  if (name === 'settings') return [root, { name: 'settings' }]
  if (name === 'computer' && nodeId) return [root, { name: 'computer', nodeId }]
  if (name === 'thread' && nodeId && threadId) return [root, { name: 'computer', nodeId }, { name: 'thread', nodeId, threadId }]
  return undefined
}
