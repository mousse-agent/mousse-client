// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { appletSourceHash, extractAppletParts, publishedAppletParts, streamingAppletParts, validateAppletSubmission } from '../../src/connection/applets'
import { toChatItem } from '../../src/connection/timelineItems'
import type { DesktopMessage } from '../../src/connection/threadProjection'
import { appletReply } from './helpers'

const source = { schemaVersion: 1, title: 'Calculator', description: 'Illustrative costs', html: '<main>Costs</main>', css: 'main{color:red}', js: 'document.body.dataset.ready="true"' }
const fence = (value: unknown) => '```mousse-applet\n' + JSON.stringify(value) + '\n```\n'

describe('applet fences', () => {
  it('reads fences the way the desktop does', () => {
    expect(extractAppletParts(`Intro\n${fence(source)}Outro`)).toEqual([
      { type: 'text', text: 'Intro\n' },
      { type: 'submission', submission: { ...source, stateVersion: 1 } },
      { type: 'text', text: 'Outro' },
    ])
    // A fence inside a longer ordinary fence never becomes an applet.
    expect(extractAppletParts('````md\n' + fence(source) + '````\n').every((part) => part.type === 'text')).toBe(true)
    // An unterminated fence leaves the rest as text.
    expect(extractAppletParts('```mousse-applet\n{"schemaVersion":1')).toEqual([{ type: 'text', text: '```mousse-applet\n{"schemaVersion":1' }])
    expect(extractAppletParts(fence({ ...source, extra: 1 }))[0]).toMatchObject({ type: 'error', message: 'Applet contains unsupported fields.' })
    expect(extractAppletParts('```mousse-applet\nnot json\n```\n')[0]).toMatchObject({ type: 'error', message: 'Applet contains invalid JSON.' })
    expect(extractAppletParts(fence(source).repeat(4)).at(-1)).toMatchObject({ type: 'error', message: 'Only three applets are allowed per message.' })
    expect(() => validateAppletSubmission({ ...source, html: 'x'.repeat(512 * 1024) })).toThrow(/512 KiB/)
  })

  it('hashes the source like the desktop applet store', () => {
    const submission = validateAppletSubmission(source)
    expect(appletSourceHash(submission)).toBe(createHash('sha256').update(JSON.stringify(submission)).digest('hex'))
  })

  it('shows a placeholder for an applet fence while the reply streams, and hides its source', () => {
    expect(streamingAppletParts('Here:\n```mousse-applet\n{"schemaVersion":1,"html":"<b>')).toEqual([{ type: 'text', text: 'Here:\n' }, { type: 'applet-pending' }])
    expect(streamingAppletParts(`A\n${fence(source)}B`)).toEqual([{ type: 'text', text: 'A\n' }, { type: 'applet-pending' }, { type: 'text', text: 'B' }])
  })

  it('runs only published applets whose source matches the publication', () => {
    const content = fence(source)
    const submission = validateAppletSubmission(source)
    const reference = { appletId: 'applet_a', revisionId: 'rev_a', sourceHash: appletSourceHash(submission), title: 'Calculator', description: 'Illustrative costs' }
    expect(publishedAppletParts(content, undefined)).toBeUndefined()
    expect(publishedAppletParts(content, [{ type: 'text', text: 'only text' }])).toBeUndefined()
    expect(publishedAppletParts(content, [{ type: 'applet', reference }])).toEqual([
      { type: 'applet', applet: { appletId: 'applet_a', revisionId: 'rev_a', title: 'Calculator', description: 'Illustrative costs', source: submission } },
    ])
    const changed = publishedAppletParts(content, [{ type: 'applet', reference: { ...reference, sourceHash: 'other' } }])
    expect(changed?.[0]).toMatchObject({ type: 'applet', applet: { appletId: 'applet_a' } })
    expect((changed?.[0] as { applet: { source?: unknown } }).applet.source).toBeUndefined()
    expect(publishedAppletParts(content, [{ type: 'applet', reference: { ...reference, appletId: '../x' } }])).toEqual([])
  })
})

describe('applet replies as chat items', () => {
  it('maps a finished reply into text and a runnable applet, without the source in its text', () => {
    const item = toChatItem(appletReply('m2', 2_000) as unknown as DesktopMessage)!
    expect(item.parts?.map((part) => part.type)).toEqual(['text', 'applet', 'text'])
    expect(item.parts?.[1]).toMatchObject({ type: 'applet', applet: { title: 'Budget', source: { title: 'Budget' } } })
    expect(item.text).toBe('Here is a budget tool.\n\nMove the slider.')
  })

  it('keeps a streaming applet as a placeholder and an unpublished fence as text, like the desktop', () => {
    const reply = appletReply('m2', 2_000) as unknown as DesktopMessage
    const streaming = toChatItem({ ...reply, streaming: true, presentationParts: undefined })!
    expect(streaming.parts?.map((part) => part.type)).toEqual(['text', 'applet-pending', 'text'])
    expect(streaming.text).not.toContain('schemaVersion')
    const unpublished = toChatItem({ ...reply, presentationParts: undefined })!
    expect(unpublished.parts).toBeUndefined()
    expect(unpublished.text).toContain('```mousse-applet')
  })
})
