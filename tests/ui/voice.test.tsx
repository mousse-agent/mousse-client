import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { installMatchMedia, renderApp } from './helpers'
import type { FakeMousseConnection, FakeSession } from '../../src/ui/dev/fakeConnection'
import { FAKE_TRANSCRIPT } from '../../src/ui/dev/fakeSpeech'
import { readAloud } from '../../src/ui/speech/readAloud'

const thread = (threadId: string) => [
  { name: 'computers' as const },
  { name: 'thread' as const, nodeId: 'node-studio', threadId }
]

/** MediaRecorder as Android's WebView gives it: WebM/Opus in timesliced chunks. */
class FakeRecorder {
  static instances: FakeRecorder[] = []
  static isTypeSupported = (type: string) => type.startsWith('audio/webm')
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly stream: MediaStream, options: { mimeType?: string } = {}) {
    this.mimeType = options.mimeType ?? 'audio/webm'
    FakeRecorder.instances.push(this)
  }
  start() {
    this.state = 'recording'
    this.ondataavailable?.({ data: new Blob([new Uint8Array(2000)], { type: this.mimeType }) })
  }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([new Uint8Array(500)], { type: this.mimeType }) })
    this.onstop?.()
  }
}

const trackStop = vi.fn()
let getUserMedia: ReturnType<typeof vi.fn>

beforeEach(() => {
  installMatchMedia()
  FakeRecorder.instances = []
  trackStop.mockClear()
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }))
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  URL.createObjectURL = vi.fn(() => 'blob:clip')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  readAloud.stop()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function open(threadId = 't-voices') {
  const { connection } = renderApp({ signedIn: true, routes: thread(threadId) })
  await screen.findByLabelText('Message')
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading thread' })).not.toBeInTheDocument())
  await waitFor(() => expect((connection as FakeMousseConnection).lastSession).toBeTruthy())
  return (connection as FakeMousseConnection).lastSession as FakeSession
}

describe('dictation on the phone', () => {
  it('asks for a model on first use, records, and types the transcript into the composer', async () => {
    const session = await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Voice input' }))

    // No model is chosen on the computer yet: the desktop's chooser opens as a sheet.
    const sheet = await screen.findByRole('dialog', { name: 'Choose a dictation model' })
    const confirm = within(sheet).getByRole('button', { name: 'Use model and record' })
    expect(confirm).toBeDisabled()
    fireEvent.click(await within(sheet).findByRole('radio', { name: /GPT-4o Transcribe/ }))
    fireEvent.click(confirm)

    // The choice is saved on the computer, then recording starts.
    expect(await screen.findByRole('status', { name: /^Recording \d:\d\d$/ })).toBeInTheDocument()
    expect(session.speech.selections.dictation).toMatchObject({ source: 'provider', modelId: 'gpt-4o-transcribe', label: 'OpenAI · GPT-4o Transcribe' })
    expect(screen.queryByRole('dialog', { name: 'Choose a dictation model' })).not.toBeInTheDocument()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ echoCancellation: true, noiseSuppression: true }) })
    expect(FakeRecorder.instances[0].mimeType).toBe('audio/webm;codecs=opus')

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Note:' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue(`Note: ${FAKE_TRANSCRIPT}`))
    expect(session.speech.recordings).toEqual([2500])
    expect(trackStop).toHaveBeenCalled()

    // The model is known now: the next tap records at once.
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Voice input' }))
    expect(await screen.findByRole('status', { name: /^Recording/ })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }))
    await waitFor(() => expect(screen.queryByRole('status', { name: /^Recording/ })).not.toBeInTheDocument())
    expect(session.speech.recordings).toHaveLength(1)
  })

  it('downloads a local model on the computer from the chooser and shows its progress', async () => {
    const session = await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Voice input' }))
    const sheet = await screen.findByRole('dialog', { name: 'Choose a dictation model' })
    fireEvent.click(await within(sheet).findByRole('tab', { name: 'Local' }))
    const moonshine = within(sheet).getByRole('radio', { name: /Moonshine Base/ })
    expect(moonshine).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Download Moonshine Base' }))
    expect(await within(sheet).findByRole('progressbar', { name: 'Downloading Moonshine Base' })).toBeInTheDocument()
    expect(await within(sheet).findByText('Downloaded')).toBeInTheDocument()
    expect(session.speech.states['moonshine-base']).toEqual({ status: 'downloaded' })
    await waitFor(() => expect(within(sheet).getByRole('radio', { name: /Moonshine Base/ })).toHaveAttribute('aria-checked', 'true'))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Use model and record' }))
    expect(await screen.findByRole('status', { name: /^Recording/ })).toBeInTheDocument()
    expect(session.speech.selections.dictation).toMatchObject({ source: 'local', modelId: 'moonshine-base' })
  })

  it('explains a denied microphone and offers a retry', async () => {
    const session = await open()
    session.speech.selections.dictation = { source: 'provider', providerId: 'openai', modelId: 'gpt-4o-transcribe', label: 'OpenAI · GPT-4o Transcribe' }
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Voice input' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Microphone access was denied/)
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry microphone' }))
    expect(await screen.findByRole('status', { name: /^Recording/ })).toBeInTheDocument()
  })
})

describe('read aloud on the phone', () => {
  it('asks for a voice on first use, then plays the computer audio and stops on tap', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    const session = await open()
    const replies = (await screen.findAllByTestId('chat-item')).filter((item) => item.dataset.role === 'assistant')
    fireEvent.click(within(replies[0]).getByRole('button', { name: 'Read aloud' }))

    const sheet = await screen.findByRole('dialog', { name: 'Choose a read aloud voice' })
    fireEvent.click(await within(sheet).findByRole('radio', { name: /GPT-4o mini TTS/ }))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Use model and read' }))

    const stop = await within(replies[0]).findByRole('button', { name: 'Stop reading' })
    expect(session.speech.spoken).toEqual(['The working tree is clean, so this starts from main. Tell me what to change next.'])
    expect(play).toHaveBeenCalled()
    fireEvent.click(stop)
    expect(await within(replies[0]).findByRole('button', { name: 'Read aloud' })).toBeInTheDocument()
  })
})
