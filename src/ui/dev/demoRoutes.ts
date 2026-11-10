import type { Route } from '../state/router'

/**
 * Dev-only deep links for the fake connection, used for screenshots:
 *   ?signedIn&screen=thread:node-studio:t-redesign
 *   ?signedIn&screen=new:node-studio
 *   ?signedIn&screen=settings
 *   ?signedIn&screen=bot:node-studio:bot-inbox
 */
export function demoRoutesFromQuery(search: string): Route[] | undefined {
  const screen = new URLSearchParams(search).get('screen')
  if (!screen) return undefined
  const [name, nodeId, threadId] = screen.split(':')
  const root: Route = { name: 'home' }
  if (name === 'settings') return [root, { name: 'settings' }]
  if (name === 'new') return [root, { name: 'new', ...(nodeId ? { nodeId } : {}) }]
  if (name === 'thread' && nodeId && threadId) return [root, { name: 'thread', nodeId, threadId }]
  if (name === 'bot' && nodeId && threadId) return [root, { name: 'bot', nodeId, botId: threadId }]
  return undefined
}
