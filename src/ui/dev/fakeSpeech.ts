// A computer's speech models for the fake connection: the dev preview and UI tests use it to show
// the first-use chooser, model downloads, dictation and read aloud without a desktop.
import {
  SpeechError,
  type ComputerSpeech,
  type LocalModelState,
  type SpeechChoice,
  type SpeechClip,
  type SpeechKind,
  type SpeechLocalModel,
  type SpeechOptions,
  type SpeechProviderModel,
  type SpeechRecordingUpload,
  type SpeechSelection,
} from '../../connection/speech'

const PROVIDERS: Record<SpeechKind, SpeechProviderModel[]> = {
  dictation: [{ providerId: 'openai', providerLabel: 'OpenAI', modelId: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' }],
  readAloud: [{ providerId: 'openai', providerLabel: 'OpenAI', modelId: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS' }],
}

const LOCAL: Record<SpeechKind, Omit<SpeechLocalModel, 'state'>[]> = {
  dictation: [
    { id: 'moonshine-base', label: 'Moonshine Base', description: 'English, runs on this computer', parameters: '61M', license: 'MIT', homepage: 'https://huggingface.co/UsefulSensors/moonshine-base', bytes: 63_000_000 },
    { id: 'parakeet-tdt-110m', label: 'Parakeet TDT 110M', description: 'English with punctuation, runs on this computer', parameters: '110M', license: 'CC-BY-4.0', homepage: 'https://huggingface.co/nvidia/parakeet-tdt_ctc-110m', bytes: 136_000_000 },
  ],
  readAloud: [
    { id: 'kokoro-82m', label: 'Kokoro 82M', description: 'English voices, runs on this computer', parameters: '82M', license: 'Apache-2.0', homepage: 'https://huggingface.co/hexgrad/Kokoro-82M', bytes: 93_000_000 },
  ],
}

export const FAKE_TRANSCRIPT = 'Dictated on the phone'

/** A short WAV of silence, so the player has something real to play. */
function silentWav(samples = 2400, rate = 24_000): Uint8Array {
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => { for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index)) }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples * 2, true)
  return bytes
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })

export class FakeComputerSpeech implements ComputerSpeech {
  readonly selections: Record<SpeechKind, SpeechSelection | null> = { dictation: null, readAloud: null }
  readonly states: Record<string, LocalModelState> = {}
  /** Texts read aloud, for tests. */
  readonly spoken: string[] = []
  /** Bytes of each recording transcribed, for tests. */
  readonly recordings: number[] = []

  constructor(private readonly delayMs = 5) {}

  async options(kind: SpeechKind): Promise<SpeechOptions> {
    await wait(this.delayMs)
    return {
      kind,
      selection: this.selections[kind],
      ...(kind === 'readAloud' && this.selections.readAloud ? { voice: 'af_heart' } : {}),
      providers: PROVIDERS[kind],
      local: LOCAL[kind].map((model) => ({ ...model, state: this.states[model.id] ?? { status: 'not-downloaded' } })),
    }
  }

  async choose(kind: SpeechKind, choice: SpeechChoice): Promise<SpeechSelection> {
    await wait(this.delayMs)
    if (choice.source === 'provider') {
      const model = PROVIDERS[kind].find((entry) => entry.providerId === choice.providerId && entry.modelId === choice.modelId)
      if (!model) throw new SpeechError('invalid', 'That model is no longer offered by the providers on this computer.')
      return (this.selections[kind] = { source: 'provider', providerId: model.providerId, modelId: model.modelId, label: `${model.providerLabel} · ${model.label}` })
    }
    const model = LOCAL[kind].find((entry) => entry.id === choice.modelId)
    if (!model) throw new SpeechError('invalid', 'This computer does not offer that model.')
    if (this.states[model.id]?.status !== 'downloaded') throw new SpeechError('unavailable', `${model.label} is not downloaded on this computer yet.`)
    return (this.selections[kind] = { source: 'local', modelId: model.id, label: model.label })
  }

  async download(kind: SpeechKind, modelId: string, options: { onState?: (state: LocalModelState) => void; signal?: AbortSignal } = {}): Promise<LocalModelState> {
    const model = LOCAL[kind].find((entry) => entry.id === modelId)
    if (!model) throw new SpeechError('invalid', 'This computer does not offer that model.')
    for (let step = 1; step <= 4; step++) {
      try {
        await wait(this.delayMs, options.signal)
      } catch {
        this.states[modelId] = { status: 'not-downloaded' }
        throw new SpeechError('failed', 'The download was cancelled.')
      }
      const state: LocalModelState = { status: 'downloading', receivedBytes: (model.bytes * step) / 4, totalBytes: model.bytes }
      this.states[modelId] = state
      options.onState?.(state)
    }
    return (this.states[modelId] = { status: 'downloaded' })
  }

  startRecording(): SpeechRecordingUpload {
    let bytes = 0
    const recordings = this.recordings
    const selections = this.selections
    const delay = this.delayMs
    return {
      add: (chunk) => { bytes += chunk.length },
      get bytes() { return bytes },
      async transcribe(_mimeType, options = {}) {
        await wait(delay, options.signal)
        if (!selections.dictation) throw new SpeechError('no_model', 'No dictation model is chosen on this computer yet.')
        options.onPartial?.('Dictated')
        await wait(delay, options.signal)
        recordings.push(bytes)
        return FAKE_TRANSCRIPT
      },
    }
  }

  async speak(markdown: string, options: { onClip: (clip: SpeechClip) => void; signal?: AbortSignal }): Promise<void> {
    await wait(this.delayMs, options.signal)
    if (!this.selections.readAloud) throw new SpeechError('no_model', 'No read aloud voice is chosen on this computer yet.')
    this.spoken.push(markdown)
    options.onClip({ index: 0, bytes: silentWav(), mimeType: 'audio/wav', rate: 1 })
  }
}
