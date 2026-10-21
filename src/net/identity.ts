// Net identity documents and the checks the phone needs: roster verification, the current
// delegation of a node, and roster ordering for updates.
import { verifyDocument, sameJson, type Signed } from './crypto'
import { NetError } from './errors'
import type { NodePublicKeys } from './keys'

export const NODE_DELEGATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const NET_PROTO_MAJOR = 1
export const NET_PROTO_MINOR = 0

export type Capability = 'read' | 'chat' | 'write' | 'terminal' | 'settings'
export const CAPABILITIES: readonly Capability[] = ['read', 'chat', 'write', 'terminal', 'settings']

export interface NodeDelegation {
  v: 1
  kind: 'node'
  subject: string
  keys: NodePublicKeys
  owner: string
  name: string
  caps: Capability[]
  keyEpoch: number
  issuedAt: number
  expiresAt: number
}

export interface Roster {
  v: 1
  owner: string
  rootKey: string
  recoveryEpoch: number
  lineage: string
  version: number
  authorityNode: string
  nodes: Signed[]
  bots: Signed[]
  revoked: Array<{ subject: string; throughKeyEpoch: number; revokedAt: number }>
  issuedAt: number
}

export interface Route {
  transport: string
  address: string
  priority: number
}
export interface RoutesRecord {
  v: 1
  node: string
  routes: Route[]
  version: number
  issuedAt: number
}

const isInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

/** Verifies a roster with the pinned root key and checks its basic shape. */
export function verifyRoster(signed: Signed, rootKey: string): Roster {
  const roster = verifyDocument<Roster>(signed, rootKey)
  if (
    !roster ||
    roster.v !== 1 ||
    roster.rootKey !== rootKey ||
    typeof roster.owner !== 'string' ||
    typeof roster.authorityNode !== 'string' ||
    typeof roster.lineage !== 'string' ||
    !isInt(roster.recoveryEpoch) ||
    !isInt(roster.version) ||
    !isInt(roster.issuedAt) ||
    !Array.isArray(roster.nodes) ||
    !Array.isArray(roster.bots) ||
    !Array.isArray(roster.revoked)
  )
    throw new NetError('bad_delegation', 'Invalid roster.')
  return roster
}

export function verifyDelegation(signed: Signed, rootKey: string): NodeDelegation {
  const delegation = verifyDocument<NodeDelegation>(signed, rootKey)
  if (
    !delegation ||
    delegation.v !== 1 ||
    delegation.kind !== 'node' ||
    typeof delegation.subject !== 'string' ||
    typeof delegation.owner !== 'string' ||
    typeof delegation.name !== 'string' ||
    !delegation.keys ||
    typeof delegation.keys.sign !== 'string' ||
    typeof delegation.keys.agree !== 'string' ||
    typeof delegation.keys.transport !== 'string' ||
    !Array.isArray(delegation.caps) ||
    !isInt(delegation.keyEpoch) ||
    !isInt(delegation.issuedAt) ||
    !isInt(delegation.expiresAt)
  )
    throw new NetError('bad_delegation', 'Invalid delegation.')
  return delegation
}

/** The newest valid delegation of `node` in the roster at time `at`, as the desktop selects it. */
export function currentNode(roster: Roster, node: string, at: number): { signed: Signed; delegation: NodeDelegation } {
  const rows = roster.nodes
    .map((signed) => ({ signed, delegation: verifyDelegation(signed, roster.rootKey) }))
    .filter((row) => row.delegation.subject === node)
    .sort((a, b) => b.delegation.keyEpoch - a.delegation.keyEpoch || b.delegation.issuedAt - a.delegation.issuedAt)
  const found = rows[0]
  if (
    !found ||
    found.delegation.owner !== roster.owner ||
    found.delegation.issuedAt > at ||
    at >= found.delegation.expiresAt ||
    found.delegation.expiresAt - found.delegation.issuedAt > NODE_DELEGATION_TTL_MS ||
    (roster.revoked.find((row) => row.subject === node)?.throughKeyEpoch ?? 0) >= found.delegation.keyEpoch
  )
    throw new NetError('bad_delegation', 'The node has no current delegation.')
  return found
}

/** Whether the roster revokes `node` at or above `keyEpoch`. */
export function isRevoked(roster: Roster, node: string, keyEpoch: number): boolean {
  return (roster.revoked.find((row) => row.subject === node)?.throughKeyEpoch ?? 0) >= keyEpoch
}

/**
 * Whether the roster removed `node`: it revokes the newest key epoch the roster or the caller
 * (`knownKeyEpoch`, from the node's own delegation) knows for it.
 */
export function removesNode(roster: Roster, node: string, knownKeyEpoch = 1): boolean {
  let keyEpoch = knownKeyEpoch
  for (const signed of roster.nodes) {
    try {
      const delegation = verifyDelegation(signed, roster.rootKey)
      if (delegation.subject === node && delegation.keyEpoch > keyEpoch) keyEpoch = delegation.keyEpoch
    } catch {
      // A damaged row says nothing about this node.
    }
  }
  return isRevoked(roster, node, keyEpoch)
}

/** Orders rosters of one lineage: positive when `a` is newer than `b`. */
export function rosterPosition(a: Roster, b: Roster): number {
  return a.recoveryEpoch - b.recoveryEpoch || a.version - b.version
}

export function sameKeys(a: NodePublicKeys, b: NodePublicKeys): boolean {
  return a.sign === b.sign && a.agree === b.agree && a.transport === b.transport
}

export function verifyRoutes(signed: Signed, signKey: string, node: string): RoutesRecord {
  const routes = verifyDocument<RoutesRecord>(signed, signKey)
  if (
    !routes ||
    routes.v !== 1 ||
    routes.node !== node ||
    !Array.isArray(routes.routes) ||
    !isInt(routes.issuedAt) ||
    !isInt(routes.version) ||
    routes.routes.some(
      (route) => !route || typeof route.transport !== 'string' || typeof route.address !== 'string' || !isInt(route.priority),
    )
  )
    throw new NetError('bad_signature', 'Invalid routes record.')
  return routes
}

export { sameJson }
