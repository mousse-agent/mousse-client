// In-response applets, read the way the desktop reads them (mousse/src/shared/applets.ts and
// src/renderer/chat/adapters/mousseToUI.ts). A finished reply runs only the applets the computer
// published into its `presentationParts`; the source is the matching ```mousse-applet fence in
// the reply's text, checked against the published source hash. While a reply streams, applet
// fences are placeholders and never run. Everything here reads untrusted JSON from the computer.
import { utf8 } from '../net/bytes'
import { sha256 } from '../net/crypto'
import type { AppletSubmission, ChatApplet, ChatPart } from './types'

export const APPLET_SOURCE_LIMIT = 512 * 1024
export const APPLET_STATE_LIMIT = 64 * 1024
export const APPLETS_PER_MESSAGE = 3

export class AppletValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppletValidationError'
  }
}

type ExtractedPart =
  | { type: 'text'; text: string }
  | { type: 'submission'; submission: AppletSubmission }
  | { type: 'error'; message: string; source: string }

const ALLOWED = new Set(['schemaVersion', 'title', 'description', 'html', 'css', 'js', 'data', 'stateVersion', 'appletId', 'expectedRevision'])
const ID = /^[a-zA-Z0-9_-]{1,80}$/

/** The desktop's validateAppletSubmission: the same checks, and the same normalized copy. */
export function validateAppletSubmission(value: unknown): AppletSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppletValidationError('Applet must be a JSON object.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !ALLOWED.has(key))) throw new AppletValidationError('Applet contains unsupported fields.')
  if (input.schemaVersion !== 1) throw new AppletValidationError('Unsupported applet schema version.')
  for (const field of ['title', 'description', 'html', 'css', 'js'])
    if (typeof input[field] !== 'string') throw new AppletValidationError(`Applet ${field} must be text.`)
  if (!(input.title as string).trim() || (input.title as string).length > 120 || (input.description as string).length > 1000)
    throw new AppletValidationError('Applet title or description is too long or empty.')
  const stateVersion = input.stateVersion ?? 1
  if (!Number.isSafeInteger(stateVersion) || (stateVersion as number) < 1) throw new AppletValidationError('Invalid applet state version.')
  for (const field of ['appletId', 'expectedRevision'])
    if (input[field] !== undefined && (typeof input[field] !== 'string' || !ID.test(input[field] as string)))
      throw new AppletValidationError(`Invalid applet ${field}.`)
  if (Boolean(input.appletId) !== Boolean(input.expectedRevision)) throw new AppletValidationError('Applet updates need both appletId and expectedRevision.')
  let json: string | undefined
  try {
    json = JSON.stringify(input)
  } catch {
    json = undefined
  }
  if (json === undefined) throw new AppletValidationError('Applet data must be JSON serializable.')
  if (utf8(json).length > APPLET_SOURCE_LIMIT) throw new AppletValidationError('Applet exceeds the 512 KiB source limit.')
  return JSON.parse(JSON.stringify({ ...input, stateVersion })) as AppletSubmission
}

/** The desktop's extractAppletParts for a finished reply: every fence is consumed in order. */
export function extractAppletParts(content: string): ExtractedPart[] {
  const parts: ExtractedPart[] = []
  const openings = /^(`{3,}|~{3,})([^\r\n]*)\r?\n/gm
  let cursor = 0
  let count = 0
  let opening: RegExpExecArray | null
  while ((opening = openings.exec(content))) {
    const marker = opening[1]
    const closing = new RegExp(`^${marker[0]}{${marker.length},}[ \t]*(?:\\r?\\n|$)`, 'gm')
    closing.lastIndex = openings.lastIndex
    const end = closing.exec(content)
    if (!end) break
    const bodyStart = openings.lastIndex
    openings.lastIndex = end.index + end[0].length
    if (opening[2].trim() !== 'mousse-applet') continue
    const start = opening.index
    if (start > cursor) parts.push({ type: 'text', text: content.slice(cursor, start) })
    try {
      if (++count > APPLETS_PER_MESSAGE) throw new AppletValidationError('Only three applets are allowed per message.')
      parts.push({ type: 'submission', submission: validateAppletSubmission(JSON.parse(content.slice(bodyStart, end.index))) })
    } catch (error) {
      parts.push({
        type: 'error',
        message: error instanceof AppletValidationError ? error.message : 'Applet contains invalid JSON.',
        source: content.slice(start, openings.lastIndex),
      })
    }
    cursor = openings.lastIndex
  }
  if (cursor < content.length || parts.length === 0) parts.push({ type: 'text', text: content.slice(cursor) })
  return parts
}

/** The desktop's streamingAppletPresentation: an applet fence shows as a placeholder until the reply ends. */
export function streamingAppletParts(content: string): ChatPart[] {
  const parts: ChatPart[] = []
  let text = ''
  let fence: { character: string; length: number; applet: boolean } | null = null
  const flush = () => {
    if (text) parts.push({ type: 'text', text })
    text = ''
  }
  for (const line of content.split(/(?<=\n)/)) {
    const marker = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)?$/.exec(line)
    if (fence) {
      if (!fence.applet) text += line
      if (marker && marker[2][0] === fence.character && marker[2].length >= fence.length && !marker[3].trim()) fence = null
      continue
    }
    if (marker) {
      const applet = marker[3].trim() === 'mousse-applet'
      fence = { character: marker[2][0], length: marker[2].length, applet }
      if (applet) {
        flush()
        parts.push({ type: 'applet-pending' })
        continue
      }
    }
    text += line
  }
  flush()
  return parts
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** The desktop AppletStore's source hash: SHA-256 of the normalized submission's JSON, in hex. */
export function appletSourceHash(submission: AppletSubmission): string {
  return hex(sha256(utf8(JSON.stringify(submission))))
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The parts of a finished reply whose applets the computer published, or undefined when it published
 * none (the reply then shows its text as written, like the desktop). Each applet runs from the fence
 * whose source hash matches the publication.
 */
export function publishedAppletParts(content: string, presentation: unknown): ChatPart[] | undefined {
  if (!Array.isArray(presentation) || !presentation.some((part) => isObject(part) && part.type === 'applet')) return undefined
  let sources: Array<{ hash: string; submission: AppletSubmission }> | undefined
  const parts: ChatPart[] = []
  for (const part of presentation.slice(0, 64)) {
    if (!isObject(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type !== 'applet' || !isObject(part.reference)) continue
    const reference = part.reference
    const appletId = str(reference.appletId)
    const revisionId = str(reference.revisionId)
    const sourceHash = str(reference.sourceHash)
    if (!ID.test(appletId) || !ID.test(revisionId)) continue
    sources ??= extractAppletParts(content).flatMap((entry) =>
      entry.type === 'submission' ? [{ hash: appletSourceHash(entry.submission), submission: entry.submission }] : [],
    )
    const index = sources.findIndex((entry) => entry.hash === sourceHash)
    const found = index >= 0 ? sources.splice(index, 1)[0] : undefined
    const applet: ChatApplet = {
      appletId,
      revisionId,
      title: (str(reference.title) || found?.submission.title || 'Applet').slice(0, 120),
      description: (str(reference.description) || found?.submission.description || '').slice(0, 1000),
      ...(found ? { source: found.submission } : {}),
    }
    parts.push({ type: 'applet', applet })
  }
  return parts
}
