import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { SpeechError, type ComputerSpeech, type SpeechClip } from '../../connection/speech'
import { errorMessage } from '../hooks/useAsync'
import { Loader2, Stop, VolumeHigh } from '../components/icons'
import { SpeechModelSheet } from './SpeechModelSheet'
import './speech.css'

/**
 * Read aloud on the phone, as on the desktop (readAloudStore, ReadAloudButton): one message speaks
 * at a time; the computer voices it with its read aloud model and voice and streams the audio,
 * which plays here clip by clip while the rest is still being made.
 */

export type ReadAloudStatus = 'idle' | 'loading' | 'playing'

interface PendingRead {
  speech: ComputerSpeech
  key: string
  text: string
}

interface ReadAloudState {
  activeKey: string | null
  status: ReadAloudStatus
  error: { key: string; message: string } | null
  /** The message to read once a model is chosen in the chooser. */
  chooser: PendingRead | null
}

const ERROR_VISIBLE_MS = 6000

/** Plays clips in order through audio elements, which keep the pitch when the rate changes. */
class ClipPlayer {
  private readonly queue: SpeechClip[] = []
  private current: { audio: HTMLAudioElement; url: string } | null = null
  private finished = false
  private stopped = false

  constructor(private readonly events: { playing(): void; done(): void; failed(error: Error): void }) {}

  push(clip: SpeechClip): void {
    if (this.stopped) return
    this.queue.push(clip)
    if (!this.current) this.next()
  }

  /** No more clips will come; ends once the last one has played. */
  end(): void {
    this.finished = true
    if (!this.current && this.queue.length === 0 && !this.stopped) this.events.done()
  }

  stop(): void {
    this.stopped = true
    this.queue.length = 0
    this.release()
  }

  private release(): void {
    const current = this.current
    this.current = null
    if (!current) return
    current.audio.onended = null
    current.audio.onerror = null
    current.audio.pause()
    current.audio.removeAttribute('src')
    URL.revokeObjectURL(current.url)
  }

  private next(): void {
    this.release()
    if (this.stopped) return
    const clip = this.queue.shift()
    if (!clip) {
      if (this.finished) this.events.done()
      return
    }
    const url = URL.createObjectURL(new Blob([clip.bytes as Uint8Array<ArrayBuffer>], { type: clip.mimeType }))
    const audio = new Audio(url)
    audio.preservesPitch = true
    audio.playbackRate = clip.rate
    this.current = { audio, url }
    audio.onended = () => this.next()
    audio.onerror = () => this.fail(new Error('The audio from the computer could not be played.'))
    Promise.resolve()
      .then(() => audio.play())
      .then(
        () => { if (this.current?.audio === audio) this.events.playing() },
        (error: unknown) => { if (this.current?.audio === audio) this.fail(error instanceof Error ? error : new Error(String(error))) },
      )
  }

  private fail(error: Error): void {
    this.stop()
    this.events.failed(error)
  }
}

class ReadAloudStore {
  private state: ReadAloudState = { activeKey: null, status: 'idle', error: null, chooser: null }
  private readonly listeners = new Set<() => void>()
  private session: { id: number; controller: AbortController; player: ClipPlayer } | null = null
  private lastId = 0
  private errorTimer: ReturnType<typeof setTimeout> | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get = (): ReadAloudState => this.state

  private set(change: Partial<ReadAloudState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }

  private showError(key: string, message: string): void {
    if (this.errorTimer) clearTimeout(this.errorTimer)
    this.set({ error: { key, message } })
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null
      if (this.state.error?.key === key) this.set({ error: null })
    }, ERROR_VISIBLE_MS)
  }

  /** Starts reading the message, or stops it when it is the one speaking. */
  toggle(speech: ComputerSpeech, key: string, text: string): void {
    if (this.state.activeKey === key && this.state.status !== 'idle') {
      this.stop()
      return
    }
    this.start({ speech, key, text })
  }

  stop = (): void => {
    const current = this.session
    this.session = null
    current?.controller.abort()
    current?.player.stop()
    if (this.state.activeKey !== null || this.state.status !== 'idle') this.set({ activeKey: null, status: 'idle' })
  }

  closeChooser = (): void => this.set({ chooser: null })

  /** A model was chosen: read the message that asked for it. */
  chosen = (): void => {
    const pending = this.state.chooser
    this.set({ chooser: null })
    if (pending) this.start(pending)
  }

  private start(read: PendingRead): void {
    this.stop()
    const id = ++this.lastId
    const controller = new AbortController()
    const mine = (): boolean => this.session?.id === id
    const finish = (): void => {
      if (!mine()) return
      this.session = null
      this.set({ activeKey: null, status: 'idle' })
    }
    const player = new ClipPlayer({
      playing: () => { if (mine() && this.state.status !== 'playing') this.set({ status: 'playing' }) },
      done: finish,
      failed: (error) => {
        if (!mine()) return
        controller.abort()
        finish()
        this.showError(read.key, errorMessage(error))
      },
    })
    this.session = { id, controller, player }
    this.set({ activeKey: read.key, status: 'loading', error: null })
    read.speech.speak(read.text, { onClip: (clip) => { if (mine()) player.push(clip) }, signal: controller.signal }).then(
      () => { if (mine()) player.end() },
      (error: unknown) => {
        if (!mine()) return
        player.stop()
        finish()
        if (error instanceof SpeechError && error.code === 'no_model') {
          this.set({ chooser: read })
          return
        }
        if (controller.signal.aborted) return
        this.showError(read.key, errorMessage(error))
      },
    )
  }
}

export const readAloud = new ReadAloudStore()

function useReadAloud(): ReadAloudState {
  return useSyncExternalStore(readAloud.subscribe, readAloud.get)
}

const SpeechContext = createContext<ComputerSpeech | undefined>(undefined)

/** The computer's speech models for this thread, when it offers them. */
export function useComputerSpeech(): ComputerSpeech | undefined {
  return useContext(SpeechContext)
}

/**
 * Gives a thread's messages the computer's read aloud, and hosts its first-use chooser. Leaving
 * the thread stops reading.
 */
export function SpeechProvider({ speech, children }: { speech?: ComputerSpeech; children: ReactNode }) {
  const state = useReadAloud()
  useEffect(() => () => readAloud.stop(), [speech])
  return (
    <SpeechContext.Provider value={speech}>
      {children}
      {speech && (
        <SpeechModelSheet
          open={state.chooser?.speech === speech}
          kind="readAloud"
          speech={speech}
          continues
          onClose={readAloud.closeChooser}
          onChosen={readAloud.chosen}
        />
      )}
    </SpeechContext.Provider>
  )
}

/**
 * The desktop's message read aloud button: speaker to start, spinner while loading, stop while
 * playing. `toolbar` styles it as one of the timeline's message actions.
 */
export function ReadAloudButton({ speechKey, text, toolbar = false }: { speechKey: string; text: string; toolbar?: boolean }) {
  const speech = useContext(SpeechContext)
  const state = useReadAloud()
  if (!speech) return null
  const status = state.activeKey === speechKey ? state.status : 'idle'
  const error = state.error?.key === speechKey ? state.error.message : null
  const active = status !== 'idle'
  const label = active ? 'Stop reading' : 'Read aloud'
  const icon = status === 'loading' ? <Loader2 size={toolbar ? 14 : 15} className="m-speech-spin" /> : status === 'playing' ? <Stop size={toolbar ? 14 : 15} /> : <VolumeHigh size={toolbar ? 14 : 15} />
  if (toolbar) {
    return (
      <>
        <button
          type="button"
          className="m-tl-action"
          aria-label={label}
          title={status === 'loading' ? 'Loading voice, tap to stop' : label}
          aria-busy={status === 'loading' || undefined}
          data-read-aloud={status}
          data-pinned={active || undefined}
          onClick={() => readAloud.toggle(speech, speechKey, text)}
        >
          {icon}
        </button>
        {error && <span className="m-read-aloud__error" role="alert">{error}</span>}
      </>
    )
  }
  return (
    <div className="m-read-aloud">
      <button
        type="button"
        className="m-read-aloud__button"
        aria-label={label}
        title={status === 'loading' ? 'Loading voice, tap to stop' : label}
        aria-busy={status === 'loading' || undefined}
        data-read-aloud={status}
        data-active={active || error ? '' : undefined}
        onClick={() => readAloud.toggle(speech, speechKey, text)}
      >
        {icon}
      </button>
      {error && <span className="m-read-aloud__error" role="alert">{error}</span>}
    </div>
  )
}
