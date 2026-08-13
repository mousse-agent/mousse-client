import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { discover } from '../../src/oauth'
import { MousseRpc } from '../../src/rpc'
import type { TokenSet } from '../../src/types'
let child: ChildProcess; const port = 28519
beforeAll(async () => { child = spawn(process.execPath, ['scripts/mock-mms.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' }); for (let attempt = 0; attempt < 20; attempt++) { try { const response = await fetch(`http://127.0.0.1:${port}/.well-known/mousse-configuration`); if (response.ok) return } catch {} await new Promise(resolve => setTimeout(resolve, 50)) } throw new Error('Mock MMS did not start.') })
afterAll(() => child.kill())
describe('MMS protocol integration mock', () => { it('discovers and performs a JSON-RPC read and mutation', async () => { const found = await discover(`http://127.0.0.1:${port}`); expect(found.connection.serverName).toBe('Mock Mousse'); const token: TokenSet = { access_token: 'test', refresh_token: 'refresh', expires_at: Date.now() + 60_000, scope: 'mousse:read mousse:write', client_id: 'test', base_url: found.connection.baseUrl, issuer: found.oauth.issuer }; const rpc = new MousseRpc(found.connection.apiEndpoint, token); expect(await rpc.request<{ threads: unknown[] }>('threads.list')).toMatchObject({ threads: [{ id: 'thread-1' }] }); expect(await rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Mobile thread' }, true)).toHaveProperty('thread.id') }) })
