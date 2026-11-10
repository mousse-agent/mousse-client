// An in-response applet, like the desktop's AppletCard: only its content under a quiet name, with no
// card. The name opens the applet large, over the whole screen, where Restart and Stop live (the
// desktop's side panel). The applet runs in a sandboxed frame. The frame gets `sandbox="allow-scripts"` only, so it has an opaque origin:
// no access to this app's pages, storage, keys or connections, and the document's CSP blocks every
// network request. On a phone the applet runs only after a tap, so a broken applet cannot stall the
// thread on opening. Its saved state stays on this phone for as long as the app runs; the computer's
// saved state is not available here.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { APPLET_STATE_LIMIT } from '../../connection/applets'
import type { ChatApplet } from '../../connection/types'
import { APPLET_APPEARANCE, APPLET_EVENT, appletDocument } from '../applets/appletDocument'
import { readAppletAppearance } from '../applets/appearance'
import { useTimelineActions } from './context'
import { X } from './icons'

/** The card's frame height, as on the desktop: 320 at first, then what the applet asks within 180–540. */
export const APPLET_HEIGHT = { initial: 320, min: 180, max: 540 } as const
/** Events a frame may post per second, and the longest event, as the desktop's bootstrap allows. */
const EVENTS_PER_SECOND = 30
const EVENT_MAX_CHARS = 65_536

/** Applets started in this app run, and the state they saved: both survive the card re-rendering. */
const running = new Set<string>()
const savedStates = new Map<string, unknown>()
const SAVED_STATES_MAX = 32

const keyOf = (applet: ChatApplet) => `${applet.appletId}/${applet.revisionId}`

export type AppletEvent =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'state'; state: unknown }
  | { type: 'error'; message: string }
  | { type: 'conversation-input'; text: string }

/** Reads one event a frame posted; anything malformed or unknown is ignored. */
export function readAppletEvent(data: unknown): AppletEvent | undefined {
  if (!data || typeof data !== 'object' || !(APPLET_EVENT in data)) return undefined
  const raw = (data as Record<string, unknown>)[APPLET_EVENT]
  if (typeof raw !== 'string' || raw.length > EVENT_MAX_CHARS) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const { type, payload } = parsed as { type?: unknown; payload?: unknown }
  switch (type) {
    case 'ready':
      return { type }
    case 'resize':
      return typeof payload === 'number' && Number.isFinite(payload) ? { type, height: payload } : undefined
    case 'state': {
      const json = JSON.stringify(payload ?? null)
      return json.length <= APPLET_STATE_LIMIT ? { type, state: payload ?? null } : undefined
    }
    case 'error':
      return { type, message: String(payload ?? 'The applet failed.').slice(0, 2000) }
    case 'conversation-input':
      return typeof payload === 'string' && payload.trim() ? { type, text: payload.slice(0, 4000) } : undefined
    default:
      return undefined
  }
}

const clampHeight = (height: number) => Math.min(APPLET_HEIGHT.max, Math.max(APPLET_HEIGHT.min, Math.round(height)))

interface FrameProps {
  applet: ChatApplet
  source: NonNullable<ChatApplet['source']>
  /** Changes on every start, so Restart builds a new document. */
  generation: number
  /** Inline the frame takes the height the applet asks for; full screen it fills the view. */
  sized: boolean
  onError(message: string): void
  onRequest(text: string): void
}

/** One running applet: its sandboxed frame and the events it posts. */
function AppletFrame({ applet, source, generation, sized, onError, onRequest }: FrameProps) {
  const key = keyOf(applet)
  const frame = useRef<HTMLIFrameElement>(null)
  const loads = useRef(0)
  const [height, setHeight] = useState<number>(APPLET_HEIGHT.initial)
  // Built once per start: a new document would restart the applet.
  const html = useMemo(() => appletDocument(source, savedStates.get(key), readAppletAppearance()), [source, key, generation])
  const handlers = useRef({ onError, onRequest })
  handlers.current = { onError, onRequest }

  useEffect(() => {
    let count = 0
    const reset = setInterval(() => (count = 0), 1_000)
    let resize: ReturnType<typeof setTimeout> | undefined
    const receive = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      if (++count > EVENTS_PER_SECOND) return
      const message = readAppletEvent(event.data)
      if (!message) return
      switch (message.type) {
        case 'resize':
          clearTimeout(resize)
          resize = setTimeout(() => setHeight(clampHeight(message.height)), 80)
          return
        case 'state':
          savedStates.delete(key)
          savedStates.set(key, message.state)
          while (savedStates.size > SAVED_STATES_MAX) savedStates.delete(savedStates.keys().next().value!)
          return
        case 'error':
          handlers.current.onError(message.message)
          return
        case 'conversation-input':
          handlers.current.onRequest(message.text)
          return
        default:
          return
      }
    }
    window.addEventListener('message', receive)
    // Follow theme changes, as the desktop pushes them to a running applet.
    const observer = new MutationObserver(() => {
      frame.current?.contentWindow?.postMessage({ [APPLET_APPEARANCE]: readAppletAppearance() }, '*')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
    return () => {
      window.removeEventListener('message', receive)
      observer.disconnect()
      clearInterval(reset)
      clearTimeout(resize)
    }
  }, [html, key])

  return (
    <iframe
      ref={frame}
      key={generation}
      className="m-applet__frame"
      title={applet.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={html}
      style={sized ? { height } : undefined}
      onLoad={() => {
        // A second load means the document navigated away from itself.
        if (++loads.current > 1) handlers.current.onError('The applet tried to open another page and was stopped.')
      }}
    />
  )
}

/** The applet shown large over the whole screen, with Restart and Stop; the phone's side panel. */
function AppletView({ applet, children, onRestart, onStop, onClose }: {
  applet: ChatApplet
  children: ReactNode
  onRestart?: () => void
  onStop?: () => void
  onClose(): void
}) {
  const close = useRef<HTMLButtonElement>(null)
  const closing = useRef(onClose)
  closing.current = onClose
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close.current?.focus()
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && closing.current()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      opener?.focus()
    }
  }, [])
  return createPortal(
    <div className="m-applet-view" role="dialog" aria-modal="true" aria-label={applet.title} data-testid="applet-view">
      <header className="m-applet-view__header">
        <div className="m-applet-view__titles">
          <strong className="m-applet-view__title">{applet.title}</strong>
          {applet.description && <span className="m-applet-view__description">{applet.description}</span>}
        </div>
        {onRestart && <button type="button" className="m-applet__button" onClick={onRestart}>Restart</button>}
        {onStop && <button type="button" className="m-applet__button" onClick={onStop}>Stop</button>}
        <button ref={close} type="button" className="m-applet-view__close" aria-label="Close applet" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="m-applet-view__body">{children}</div>
      <footer className="m-applet-view__footer">Offline applet · interactions stay on this phone</footer>
    </div>,
    document.body,
  )
}

/**
 * An applet in the transcript: its content at its own height under a quiet name, with no card. The
 * name opens it over the whole screen. On a phone an applet runs only after a tap.
 */
export const AppletCard = memo(function AppletCard({ applet }: { applet: ChatApplet }) {
  const key = keyOf(applet)
  const { addToDraft } = useTimelineActions()
  const [active, setActive] = useState(() => running.has(key))
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [request, setRequest] = useState<string>()
  const [generation, setGeneration] = useState(0)
  const source = applet.source

  function start() {
    running.add(key)
    setError(undefined)
    setGeneration((value) => value + 1)
    setActive(true)
  }

  function stop() {
    running.delete(key)
    setActive(false)
  }

  function openLarge() {
    // Opening the applet is a tap on it, so it runs.
    if (source && !active) start()
    setOpen(true)
  }

  const fail = (message: string) => {
    setError(message)
    stop()
  }
  // One frame at a time: while the applet is open large, the inline copy waits.
  const frame = (sized: boolean) =>
    source && active ? (
      <AppletFrame applet={applet} source={source} generation={generation} sized={sized} onError={fail} onRequest={setRequest} />
    ) : undefined
  const describe = applet.description ? `${applet.description}\nOpen full screen` : 'Open full screen'

  return (
    <section className="m-applet" aria-label={`Applet: ${applet.title}`} data-testid="applet">
      <button type="button" className="m-applet__name" title={describe} onClick={openLarge}>
        {applet.title}
      </button>
      {error && (
        <p className="m-applet__error" role="alert">
          {error}
          <span className="m-applet__error-actions">
            {source && !open && <button type="button" className="m-applet__link" onClick={start}>Restart</button>}
            {addToDraft && (
              <button
                type="button"
                className="m-applet__link"
                onClick={() => addToDraft(`Please fix applet "${applet.title}" (appletId: ${applet.appletId}, expectedRevision: ${applet.revisionId}). Runtime diagnostic: ${error.slice(0, 2000)}`)}
              >
                Ask the assistant to fix this
              </button>
            )}
          </span>
        </p>
      )}
      {open ? (
        <div className="m-applet__idle">Open full screen</div>
      ) : (
        frame(true) ?? (
          // A stopped applet keeps no empty space; its error says what happened.
          !error && (
            <div className="m-applet__idle">
              {source ? (
                <>
                  {applet.description && <span>{applet.description}</span>}
                  <button type="button" className="m-applet__button m-applet__button--primary" onClick={start}>Run</button>
                </>
              ) : (
                'This applet could not be read on the phone. Open the thread on the computer to use it.'
              )}
            </div>
          )
        )
      )}
      {request && (
        <aside className="m-applet__request">
          <p>{request}</p>
          {addToDraft && (
            <button
              type="button"
              className="m-applet__link"
              onClick={() => {
                addToDraft(`From applet "${applet.title}":\n${request}`)
                setRequest(undefined)
              }}
            >
              Add to message
            </button>
          )}
          <button type="button" className="m-applet__link" onClick={() => setRequest(undefined)}>Dismiss</button>
        </aside>
      )}
      {open && (
        <AppletView
          applet={applet}
          onRestart={source ? start : undefined}
          onStop={active ? stop : undefined}
          onClose={() => setOpen(false)}
        >
          {frame(false) ?? (
            <div className="m-applet__idle">
              {error ?? (source ? 'The applet is stopped. Tap Restart to run it again.' : 'This applet could not be read on the phone. Open the thread on the computer to use it.')}
            </div>
          )}
        </AppletView>
      )}
    </section>
  )
})

/** A reply's applet that is still being written, like the desktop's "Generating interactive applet…". */
export function AppletPending() {
  return (
    <section className="m-applet m-applet--pending" aria-label="Generating interactive applet" data-testid="applet-pending">
      <span className="m-applet__name">Applet</span>
      <div className="m-applet__idle" style={{ height: APPLET_HEIGHT.initial }}>Generating interactive applet…</div>
    </section>
  )
}
