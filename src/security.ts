const textEncoder = new TextEncoder()

export const randomUrlSafe = (bytes = 32): string => {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4 !== 0) {
    base64 += '='
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export async function fingerprint(key: string | Uint8Array): Promise<string> {
  const bytes = typeof key === 'string' ? textEncoder.encode(key) : key
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(':')
  return hex.toUpperCase()
}

export function canonicalOrigin(raw: string): string {
  const value = raw.trim()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid URL')
  }
  const isLoopback =
    url.hostname === 'localhost' ||
    url.hostname === '::1' ||
    /^127\./.test(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('Server origin must use HTTPS, or HTTP only on loopback.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Server origin must not contain credentials, query, or hash.')
  }
  return url.origin
}

export function normalizedBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/$/, '')
  const url = new URL(value)
  const isLoopback =
    url.hostname === 'localhost' ||
    url.hostname === '::1' ||
    /^127\./.test(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('Use HTTPS, or HTTP only for a loopback server.')
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Enter only the server base URL.')
  }
  return value
}

export function trustedUrl(
  raw: string,
  baseUrl: string,
  label: string,
  requireBasePath = false
): string {
  const base = new URL(normalizedBaseUrl(baseUrl))
  const url = new URL(raw)
  if (url.origin !== base.origin) {
    throw new Error(`${label} must use the discovered server origin.`)
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (requireBasePath && (url.pathname !== '/' || url.search))
  ) {
    throw new Error(`${label} is not a valid server URL.`)
  }
  normalizedBaseUrl(url.origin)
  return url.toString()
}
