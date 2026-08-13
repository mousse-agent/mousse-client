import { tokens } from './storage'
import type { RpcError, TokenSet } from './types'
const refreshes = new Map<string, Promise<TokenSet>>()

function validateRequiredParams(method: string, params: Record<string, unknown>) {
  const required = method.startsWith('files.') || method.startsWith('git.') ? ['projectId'] : method === 'threads.create' ? ['name'] : /^(thread\.|threads\.(get|delete|rename|pin|settle|regenerateTitle|setModel)|orchestrator\.(send|abort|steer|isTurnActive)|queue\.|agents\.(spawn|stop)|tasks\.|pty\.create|mousseAgent\.(getMessages|send|retry)|workspace\.)/.test(method) ? ['threadId'] : []
  for (const name of required) if (typeof params[name] !== 'string' || !params[name].trim()) throw new Error(`${name} is required.`)
  if (method === 'orchestrator.answerQuestions') {
    if (typeof params.requestId !== 'string' || !params.requestId.trim()) throw new Error('requestId is required.')
    if (!params.answers || typeof params.answers !== 'object' || Array.isArray(params.answers)) throw new Error('answers are required.')
  }
  if (method === 'pty.create' && (typeof params.agentId !== 'string' || !params.agentId.trim())) throw new Error('agentId is required.')
}

export class MousseRpc {
  constructor(private apiEndpoint: string, private token: TokenSet, private onTokens?: (next: TokenSet) => void) {}
  async activeToken(force = false) {
    if (!force && Date.now() < this.token.expires_at - 30_000) return this.token
    const key = `${this.token.base_url}\u0000${this.token.client_id}`
    let refresh = refreshes.get(key)
    if (!refresh) {
      const previous = this.token
      refresh = (async () => {
        const res = await fetch(`${previous.base_url}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: previous.client_id, refresh_token: previous.refresh_token }) })
        if (!res.ok) throw new Error('Session expired. Please connect again.')
        const fresh = await res.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string }
        return { ...previous, ...fresh, expires_at: Date.now() + fresh.expires_in * 1000 }
      })()
      refreshes.set(key, refresh)
      void refresh.then(() => refreshes.delete(key), () => refreshes.delete(key))
    }
    this.token = await refresh
    await tokens.set(this.token); this.onTokens?.(this.token)
    return this.token
  }
  async request<T>(method: string, params: Record<string, unknown> = {}, mutate = false): Promise<T> {
    validateRequiredParams(method, params)
    const id = crypto.randomUUID(); const wireBody = JSON.stringify({ jsonrpc: '2.0', id, method, params }); const idempotencyKey = mutate ? crypto.randomUUID() : undefined
    const send = async (forceRefresh = false) => { const token = await this.activeToken(forceRefresh); const headers: Record<string, string> = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }; if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey; return fetch(this.apiEndpoint, { method: 'POST', headers, body: wireBody }) }
    let res = await send(); if (res.status === 401) res = await send(true); if (res.status === 401) throw new Error('Session expired. Please connect again.'); if (!res.ok) throw new Error(`Request failed (${res.status})`)
    const body = await res.json() as { result?: T; error?: RpcError }; if (body.error) { const required = body.error.data?.required_scope; throw new Error(required ? `${body.error.message} (${required})` : body.error.message) }; return body.result as T
  }
}
