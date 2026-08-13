import { tokens } from './storage'
import type { RpcError, TokenSet } from './types'
export class MousseRpc {
  constructor(private apiEndpoint: string, private token: TokenSet, private onTokens?: (next: TokenSet) => void) {}
  private async activeToken() {
    if (Date.now() < this.token.expires_at - 30_000) return this.token
    const res = await fetch(`${this.token.base_url}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.token.client_id, refresh_token: this.token.refresh_token }) })
    if (!res.ok) throw new Error('Session expired. Please connect again.')
    const fresh = await res.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string }; this.token = { ...this.token, ...fresh, expires_at: Date.now() + fresh.expires_in * 1000 }; await tokens.set(this.token); this.onTokens?.(this.token); return this.token
  }
  async request<T>(method: string, params: Record<string, unknown> = {}, mutate = false): Promise<T> {
    const token = await this.activeToken(); const id = crypto.randomUUID(); const headers: Record<string, string> = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }; if (mutate) headers['Idempotency-Key'] = crypto.randomUUID()
    const res = await fetch(this.apiEndpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }); if (res.status === 401) throw new Error('Session expired. Please connect again.'); if (!res.ok) throw new Error(`Request failed (${res.status})`)
    const body = await res.json() as { result?: T; error?: RpcError }; if (body.error) { const required = body.error.data?.required_scope; throw new Error(required ? `${body.error.message} (${required})` : body.error.message) }; return body.result as T
  }
}
