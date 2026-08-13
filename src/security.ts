const textEncoder = new TextEncoder()
export const randomUrlSafe = (bytes = 32) => {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export async function s256(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function normalizedBaseUrl(raw: string) {
  const value = raw.trim().replace(/\/$/, '')
  const url = new URL(value)
  const isLoopback = url.hostname === 'localhost' || url.hostname === '::1' || /^127\./.test(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) throw new Error('Use HTTPS, or HTTP only for a loopback server.')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter only the server base URL.')
  return value
}
