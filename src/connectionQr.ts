import { normalizedBaseUrl } from './security'

const QR_VERSION = '1'

/** Parse a configuration-only desktop/CLI QR. OAuth credentials are never accepted here. */
export function parseConnectionQrPayload(value: string): string {
  let payload: URL
  try {
    payload = new URL(value)
  } catch {
    throw new Error('This is not a valid Mousse connection QR code.')
  }
  if (
    payload.protocol !== 'mousse:' ||
    payload.hostname !== 'connect' ||
    payload.pathname !== '' ||
    payload.username ||
    payload.password ||
    payload.hash
  ) {
    throw new Error('This QR code is not a Mousse connection request.')
  }
  const keys = [...payload.searchParams.keys()]
  if (
    keys.some(key => key !== 'v' && key !== 'base') ||
    payload.searchParams.getAll('v').length !== 1 ||
    payload.searchParams.getAll('base').length !== 1 ||
    payload.searchParams.get('v') !== QR_VERSION
  ) {
    throw new Error('This Mousse connection QR version is not supported.')
  }
  const base = payload.searchParams.get('base')
  if (!base) throw new Error('The Mousse connection QR has no server URL.')
  return normalizedBaseUrl(base)
}
