// Test identities shaped like the desktop's: a user root, a computer (authority) and its roster.
import { b64url } from '../../src/net/bytes'
import { newId } from '../../src/net/canonical'
import { generateSigningKey, signDocument, type Signed } from '../../src/net/crypto'
import type { NodeDelegation, Roster } from '../../src/net/identity'
import { generateNodeKeys, type NodeKeys } from '../../src/net/keys'

export const DAY = 24 * 60 * 60 * 1000

export interface TestUser {
  user: string
  rootSecret: Uint8Array
  rootKey: string
  lineage: string
  version: number
  nodes: Signed[]
  revoked: Roster['revoked']
}

export function testUser(): TestUser {
  const root = generateSigningKey()
  return {
    user: newId('user'),
    rootSecret: root.secretKey,
    rootKey: b64url(root.publicKey),
    lineage: 'lineage-1',
    version: 0,
    nodes: [],
    revoked: [],
  }
}

export function delegate(
  owner: TestUser,
  node: string,
  keys: NodeKeys,
  options: { name?: string; caps?: NodeDelegation['caps']; keyEpoch?: number; issuedAt?: number; ttl?: number } = {},
): Signed {
  const issuedAt = options.issuedAt ?? Date.now() - 1000
  const delegation: NodeDelegation = {
    v: 1,
    kind: 'node',
    subject: node,
    keys: keys.public,
    owner: owner.user,
    name: options.name ?? 'Node',
    caps: options.caps ?? ['read', 'chat', 'write'],
    keyEpoch: options.keyEpoch ?? 1,
    issuedAt,
    expiresAt: issuedAt + (options.ttl ?? 7 * DAY),
  }
  const signed = signDocument(delegation, owner.rootSecret)
  owner.nodes = owner.nodes.filter((entry) => !samePayloadSubject(entry, node, delegation.keyEpoch))
  owner.nodes.push(signed)
  return signed
}

function samePayloadSubject(entry: Signed, node: string, keyEpoch: number): boolean {
  const doc = JSON.parse(Buffer.from(entry.payload, 'base64url').toString()) as NodeDelegation
  return doc.subject === node && doc.keyEpoch === keyEpoch
}

export function roster(owner: TestUser, authorityNode: string, issuedAt = Date.now() - 1000): Signed {
  owner.version++
  const doc: Roster = {
    v: 1,
    owner: owner.user,
    rootKey: owner.rootKey,
    recoveryEpoch: 1,
    lineage: owner.lineage,
    version: owner.version,
    authorityNode,
    nodes: [...owner.nodes],
    bots: [],
    revoked: [...owner.revoked],
    issuedAt,
  }
  return signDocument(doc, owner.rootSecret)
}

export interface TestComputer {
  node: string
  keys: NodeKeys
  delegation: Signed
}

export function testComputer(owner: TestUser, name = 'Studio'): TestComputer {
  const node = newId('node')
  const keys = generateNodeKeys()
  return { node, keys, delegation: delegate(owner, node, keys, { name, caps: ['read', 'chat', 'write', 'terminal', 'settings'] }) }
}
