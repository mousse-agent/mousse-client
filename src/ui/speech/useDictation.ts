import { useEffect, useRef, useState } from 'react'
import { MAX_RECORDING_BYTES, SpeechError, type ComputerSpeech, type SpeechRecordingUpload } from '../../connection/speech'
import { errorMessage } from '../hooks/useAsync'
import { meterStream, type AudioLevels } from './audioLevels'

export const NO_SPEECH_MESSAGE = 'No speech was recognized'
const NOTICE_VISIBLE_MS = 4000
/** Recordings stop on their own after this long, well inside the computer's size limit. */
export const MAX_RECORDING_SECONDS = 5 * 60
/** Opus at this rate keeps five minutes near 1.2 MB. */
const AUDIO_BITS_PER_SECOND = 32_000
/** MediaRecorder hands over audio this often, so the upload runs while recording. */
const TIMESLICE_MS = 1000
/** Formats the computer decodes, in order of preference (Android WebView records WebM/Opus). */
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']

/** Models confirmed per computer this session, so later recordings start at once. */
const modelKnown = new WeakMap<ComputerSpeech, boolean>()

/** A recorded chunk's bytes; FileReader covers web views whose Blob lacks arrayBuffer. */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('The recording could not be read.'))
    reader.readAsArrayBuffer(blob)
  })
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

/** The desktop's microphone messages (voiceErrors), with where to allow it on a phone. */
export function microphoneError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? (error as { name: unknown }).name : undefined
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone access was denied. Allow it for Mousse in your phone settings (Apps, Mousse, Permissions), then retry.'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone was found.'
  if (name === 'NotSupportedError') return 'Microphone recording is unavailable on this phone.'
  return 'Microphone recording failed. Check that no other app is using the microphone, then retry.'
}

type Pending = { type: 'record' } | { type: 'transcribe'; upload: SpeechRecordingUpload; mimeType: string }

interface Capture {
  recorder: MediaRecorder
  stream: MediaStream
  meter?: { stop(): void }
  upload: SpeechRecordingUpload
  /** Chunks are read in order before they go to the upload. */
  chain: Promise<void>
  discard: boolean
}

/**
 * The composer's microphone, as on the desktop (useDictation): records, then turns the recording
 * into text with the computer's dictation model. The audio goes to the computer while recording.
 * The first use asks which model the computer should use, then records.
 */
export function useDictation({ speech, disabled, onTranscript }: { speech?: ComputerSpeech; disabled: boolean; onTranscript(text: string): void }) {
  const [isRecording, setIsRecording] = useState(false)
  const [recordingPending, setRecordingPending] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [partial, setPartial] = useState('')
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [levels, setLevels] = useState<AudioLevels | null>(null)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string | null>(null)
  const [chooser, setChooser] = useState<Pending | null>(null)
  const capture = useRef<Capture | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcription = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current) clearInterval(timer.current)
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      transcription.current?.abort()
      const current = capture.current
      if (current) {
        current.discard = true
        if (current.recorder.state !== 'inactive') current.recorder.stop()
        release(current)
      }
    }
  }, [])

  const showNotice = (message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice(message)
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_VISIBLE_MS)
  }

  const transcribe = async (upload: SpeechRecordingUpload, mimeType: string) => {
    if (!speech) return
    const controller = new AbortController()
    transcription.current = controller
    setTranscribing(true)
    setPartial('')
    try {
      const text = (await upload.transcribe(mimeType, { onPartial: (value) => mounted.current && setPartial(value), signal: controller.signal })).trim()
      if (!mounted.current || controller.signal.aborted) return
      modelKnown.set(speech, true)
      if (text) onTranscriptRef.current(text)
      else showNotice(NO_SPEECH_MESSAGE)
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return
      if (cause instanceof SpeechError && cause.code === 'no_model') {
        modelKnown.delete(speech)
        setChooser({ type: 'transcribe', upload, mimeType })
        return
      }
      setError(`Dictation failed: ${errorMessage(cause)}`)
    } finally {
      if (transcription.current === controller) transcription.current = null
      if (mounted.current) {
        setTranscribing(false)
        setPartial('')
      }
    }
  }

  const begin = async () => {
    if (!speech || capture.current) return
    setRecordingPending(true)
    setError(undefined)
    setNotice(null)
    let stream: MediaStream | undefined
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new DOMException('Unavailable', 'NotSupportedError')
      // On Android this asks for the microphone permission the first time.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
      if (!mounted.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: AUDIO_BITS_PER_SECOND })
      const meter = meterStream(stream)
      const current: Capture = { recorder, stream, ...(meter ? { meter } : {}), upload: speech.startRecording(), chain: Promise.resolve(), discard: false }
      capture.current = current
      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0 || current.discard) return
        const data = event.data
        current.chain = current.chain.then(async () => {
          if (current.discard) return
          current.upload.add(await blobBytes(data))
          if (current.upload.bytes >= MAX_RECORDING_BYTES * 0.95 && recorder.state === 'recording') recorder.stop()
        })
      }
      recorder.onerror = () => {
        current.discard = true
        finishCapture(current)
        if (mounted.current) setError(microphoneError(undefined))
      }
      recorder.onstop = () => {
        finishCapture(current)
        if (current.discard || !mounted.current) return
        const type = recorder.mimeType || mimeType || 'audio/webm'
        void current.chain.then(() => transcribe(current.upload, type))
      }
      const startedAt = Date.now()
      setRecordingDuration(0)
      setLevels(() => meter?.levels ?? null)
      recorder.start(TIMESLICE_MS)
      setIsRecording(true)
      timer.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000)
        setRecordingDuration(seconds)
        if (seconds >= MAX_RECORDING_SECONDS && recorder.state === 'recording') recorder.stop()
      }, 200)
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop())
      capture.current = null
      if (mounted.current) setError(microphoneError(cause))
    } finally {
      if (mounted.current) setRecordingPending(false)
    }
  }

  function release(current: Capture) {
    current.meter?.stop()
    current.stream.getTracks().forEach((track) => track.stop())
  }

  function finishCapture(current: Capture) {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    release(current)
    if (capture.current === current) capture.current = null
    if (mounted.current) {
      setIsRecording(false)
      setLevels(null)
    }
  }

  /** Starts recording; with no dictation model chosen on the computer yet, asks for one first. */
  const start = async () => {
    if (!speech || disabled || isRecording || transcribing || recordingPending || capture.current) return
    setError(undefined)
    if (!modelKnown.get(speech)) {
      setRecordingPending(true)
      try {
        const options = await speech.options('dictation')
        if (!mounted.current) return
        if (!options.selection) {
          setChooser({ type: 'record' })
          return
        }
        modelKnown.set(speech, true)
      } catch (cause) {
        if (mounted.current) setError(errorMessage(cause))
        return
      } finally {
        if (mounted.current) setRecordingPending(false)
      }
    }
    await begin()
  }

  const stop = () => {
    const current = capture.current
    if (current?.recorder.state === 'recording') current.recorder.stop()
  }

  /** Throws the recording away, or stops waiting for its text. */
  const cancel = () => {
    const current = capture.current
    if (current) {
      current.discard = true
      if (current.recorder.state !== 'inactive') current.recorder.stop()
      else finishCapture(current)
      return
    }
    if (transcription.current) {
      transcription.current.abort()
      transcription.current = null
      setTranscribing(false)
      setPartial('')
    }
  }

  return {
    available: !!speech,
    isRecording,
    recordingPending,
    transcribing,
    /** Text of the part transcribed so far, when the computer's model reports it. */
    partial,
    recordingDuration,
    levels,
    error,
    dismissError: () => setError(undefined),
    notice,
    start: () => void start(),
    stop,
    cancel,
    chooser: {
      open: chooser !== null,
      continues: chooser !== null,
      close: () => setChooser(null),
      chosen: () => {
        const pending = chooser
        setChooser(null)
        if (speech) modelKnown.set(speech, true)
        if (pending?.type === 'record') void begin()
        else if (pending?.type === 'transcribe') void transcribe(pending.upload, pending.mimeType)
      },
    },
  }
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}
