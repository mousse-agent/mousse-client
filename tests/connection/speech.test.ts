// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  LeafComputerSpeech,
  SpeechError,
  UPLOAD_PIECE_BYTES,
  bytesToBase64,
  fitSpeakText,
} from '../../src/connection/speech'
import { NetError } from '../../src/net/errors'
import type { RpcOptions } from '../../src/net/session'

type Call = { method: string; params: Record<string, unknown>; options: RpcOptions }

function fakeRpc(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = []
  const rpc = vi.fn(async (method: string, params: unknown, options: RpcOptions = {}) => {
    const call = { method, params: params as Record<string, unknown>, options }
    calls.push(call)
    return answer(call)
  })
  return { rpc, calls }
}

describe('computer speech client', () => {
  it('reads the chooser options the computer offers', async () => {
    const { rpc, calls } = fakeRpc(() => ({
      ok: true,
      kind: 'readAloud',
      selection: { source: 'local', modelId: 'kokoro-82m', label: 'Kokoro 82M' },
      voice: 'bm_george',
      providers: [{ providerId: 'openai', providerLabel: 'OpenAI', modelId: 'tts-1', label: 'TTS 1' }, { junk: true }],
      local: [{ id: 'kokoro-82m', label: 'Kokoro 82M', bytes: 93_000_000, state: { status: 'downloading', receivedBytes: 5, totalBytes: 10 } }],
    }))
    const options = await new LeafComputerSpeech(rpc).options('readAloud')
    expect(calls[0]).toMatchObject({ method: 'speech.options', params: { kind: 'readAloud' } })
    expect(calls[0].options.idem).toBeUndefined()
    expect(options.selection).toEqual({ source: 'local', modelId: 'kokoro-82m', label: 'Kokoro 82M' })
    expect(options.voice).toBe('bm_george')
    expect(options.providers).toHaveLength(1)
    expect(options.local[0].state).toEqual({ status: 'downloading', receivedBytes: 5, totalBytes: 10 })
  })

  it('turns refusals into errors with their code, and an older computer into an update hint', async () => {
    const refusing = new LeafComputerSpeech(fakeRpc(() => ({ ok: false, code: 'no_host', error: 'Mousse is not open on this computer.' })).rpc)
    await expect(refusing.options('dictation')).rejects.toMatchObject({ name: 'SpeechError', code: 'no_host', message: 'Mousse is not open on this computer.' })
    const old = new LeafComputerSpeech(fakeRpc(() => { throw new NetError('forbidden') }).rpc)
    await expect(old.options('dictation')).rejects.toMatchObject({ code: 'unsupported', message: /Update Mousse/ })
  })

  it('saves a choice with an idempotency key', async () => {
    const { rpc, calls } = fakeRpc(() => ({ ok: true, selection: { source: 'provider', providerId: 'openai', modelId: 'whisper-1', label: 'OpenAI · Whisper' } }))
    const chosen = await new LeafComputerSpeech(rpc).choose('dictation', { source: 'provider', providerId: 'openai', modelId: 'whisper-1' })
    expect(chosen.label).toBe('OpenAI · Whisper')
    expect(calls[0].params).toEqual({ kind: 'dictation', selection: { source: 'provider', providerId: 'openai', modelId: 'whisper-1' } })
    expect(calls[0].options.idem).toEqual(expect.any(String))
  })

  it('follows a download and passes cancellation to the computer', async () => {
    const abort = new AbortController()
    const { rpc, calls } = fakeRpc((call) => {
      call.options.onProgress?.({ type: 'status', state: { status: 'downloading', receivedBytes: 1, totalBytes: 4 } })
      return { ok: true, state: { status: 'downloaded' } }
    })
    const states: unknown[] = []
    const result = await new LeafComputerSpeech(rpc).download('dictation', 'moonshine-base', { onState: (state) => states.push(state), signal: abort.signal })
    expect(result).toEqual({ status: 'downloaded' })
    expect(states).toEqual([{ status: 'downloading', receivedBytes: 1, totalBytes: 4 }])
    expect(calls[0].options.signal).toBe(abort.signal)
    expect(calls[0].options.deadlineMs).toBeGreaterThan(30 * 60_000)
  })

  it('uploads a recording in ordered pieces while it records, then transcribes it with partial text', async () => {
    const { rpc, calls } = fakeRpc((call) => {
      if (call.method === 'speech.upload') return { ok: true, bytes: 0 }
      call.options.onProgress?.({ type: 'partial', text: 'Hello' })
      return { ok: true, text: 'Hello world' }
    })
    const upload = new LeafComputerSpeech(rpc).startRecording()
    const first = new Uint8Array(UPLOAD_PIECE_BYTES + 10).fill(1)
    upload.add(first)
    upload.add(new Uint8Array(UPLOAD_PIECE_BYTES).fill(2))
    upload.add(new Uint8Array(5).fill(3))
    expect(upload.bytes).toBe(2 * UPLOAD_PIECE_BYTES + 15)
    const partials: string[] = []
    expect(await upload.transcribe('audio/webm;codecs=opus', { onPartial: (text) => partials.push(text) })).toBe('Hello world')
    const uploads = calls.filter((call) => call.method === 'speech.upload')
    expect(uploads.map((call) => call.params.index)).toEqual([0, 1, 2])
    expect(new Set(uploads.map((call) => call.params.upload)).size).toBe(1)
    expect(uploads.every((call) => (call.params.data as string).length <= 48 * 1024)).toBe(true)
    expect(uploads[0].params.data).toBe(bytesToBase64(first.subarray(0, UPLOAD_PIECE_BYTES)))
    const transcribe = calls.find((call) => call.method === 'speech.transcribe')!
    expect(transcribe.params).toEqual({ upload: uploads[0].params.upload, parts: 3, mimeType: 'audio/webm;codecs=opus' })
    expect(partials).toEqual(['Hello'])
  })

  it('can transcribe the same recording again after a model is chosen', async () => {
    let chosen = false
    const { rpc, calls } = fakeRpc((call) => {
      if (call.method === 'speech.upload') return { ok: true, bytes: 3 }
      return chosen ? { ok: true, text: 'Later' } : { ok: false, code: 'no_model', error: 'Choose a model' }
    })
    const upload = new LeafComputerSpeech(rpc).startRecording()
    upload.add(new Uint8Array([1, 2, 3]))
    await expect(upload.transcribe('audio/webm')).rejects.toBeInstanceOf(SpeechError)
    chosen = true
    expect(await upload.transcribe('audio/webm')).toBe('Later')
    expect(calls.filter((call) => call.method === 'speech.upload')).toHaveLength(1)
  })

  it('joins streamed audio pieces into clips in order', async () => {
    const { rpc, calls } = fakeRpc((call) => {
      const send = (clip: number, part: number, last: boolean, bytes: number[], rate = 1) =>
        call.options.onProgress?.({ type: 'audio', clip, part, last, mimeType: 'audio/wav', rate, data: bytesToBase64(new Uint8Array(bytes)) })
      send(0, 0, false, [1, 2])
      send(0, 1, true, [3])
      send(1, 0, true, [4], 9)
      return { ok: true, clips: 2 }
    })
    const clips: unknown[] = []
    await new LeafComputerSpeech(rpc).speak('# Hi', { onClip: (clip) => clips.push({ ...clip, bytes: [...clip.bytes] }) })
    expect(calls[0].params).toEqual({ text: '# Hi' })
    expect(clips).toEqual([
      { index: 0, bytes: [1, 2, 3], mimeType: 'audio/wav', rate: 1 },
      { index: 1, bytes: [4], mimeType: 'audio/wav', rate: 1 },
    ])
  })

  it('keeps long messages inside one request', () => {
    const long = `${'A sentence here. '.repeat(3000)}`
    const cut = fitSpeakText(long)
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(40 * 1024)
    expect(cut.endsWith('.')).toBe(true)
    expect(fitSpeakText('short')).toBe('short')
  })
})
