import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { discover } from '../../src/oauth'
import { MousseRpc } from '../../src/rpc'
import type { TokenSet } from '../../src/types'
let child: ChildProcess; const port = 28519
beforeAll(async () => { child = spawn(process.execPath, ['scripts/mock-mms.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' }); await new Promise(resolve => setTimeout(resolve, 250)) })
afterAll(() => child.kill())
describe('MMS protocol integration mock', () => { it('discovers and performs a JSON-RPC read and mutation', async () => { const found = await discover(`http://127.0.0.1:${port}`); expect(found.connection.serverName).toBe('Mock Mousse'); const token: TokenSet = { access_token: 'test', refresh_token: 'refresh', expires_at: Date.now() + 60_000, scope: 'mousse:read mousse:write', client_id: 'test', base_url: found.connection.baseUrl, issuer: found.oauth.issuer }; const rpc = new MousseRpc(found.connection.apiEndpoint, token); expect(await rpc.request<{ threads: unknown[] }>('threads.list')).toMatchObject({ threads: [{ id: 'thread-1' }] }); expect(await rpc.request<{ thread: { id: string } }>('threads.create', {}, true)).toHaveProperty('thread.id') }) })
