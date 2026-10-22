// An in-response applet, like the desktop's AppletCard: a card with the applet's title that runs it
// in a sandboxed frame. The frame gets `sandbox="allow-scripts"` only, so it has an opaque origin:
// no access to this app's pages, storage, keys or connections, and the document's CSP blocks every
// network request. On a phone the applet runs only after a tap, so a broken applet cannot stall the
// thread on opening. Its saved state stays on this phone for as long as the app runs; the computer's
// saved state is not available here.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { APPLET_STATE_LIMIT } from '../../connection/applets'
import type { ChatApplet } from '../../connection/types'
import { APPLET_APPEARANCE, APPLET_EVENT, appletDocument } from '../applets/appletDocument'
import { readAppletAppearance } from '../applets/appearance'
import { useTimelineActions } from './context'

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

export const AppletCard = memo(function AppletCard({ applet }: { applet: ChatApplet }) {
  const key = keyOf(applet)
  const { addToDraft } = useTimelineActions()
  const [active, setActive] = useState(() => running.has(key))
  const [error, setError] = useState<string>()
  const [request, setRequest] = useState<string>()
  const [height, setHeight] = useState<number>(APPLET_HEIGHT.initial)
  const frame = useRef<HTMLIFrameElement>(null)
  const source = applet.source
  // Built once per start: a new document would restart the applet.
  const [generation, setGeneration] = useState(0)
  const loads = useRef(0)
  const html = useMemo(
    () => (active && source ? appletDocument(source, savedStates.get(key), readAppletAppearance()) : undefined),
    [active, source, key, generation],
  )

  useEffect(() => {
    if (!html) return
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
          setError(message.message)
          stop()
          return
        case 'conversation-input':
          setRequest(message.text)
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

  function start() {
    running.add(key)
    loads.current = 0
    setError(undefined)
    setGeneration((value) => value + 1)
    setActive(true)
  }

  function stop() {
    running.delete(key)
    setActive(false)
  }

  return (
    <section className="m-applet" aria-label={`Interactive applet: ${applet.title}`} data-testid="applet">
      <header className="m-applet__header">
        <strong className="m-applet__title" title={applet.description ? `${applet.title}\n${applet.description}` : applet.title}>{applet.title}</strong>
        {source && (active ? (
          <span className="m-applet__actions">
            <button type="button" className="m-applet__button" onClick={start}>Restart</button>
            <button type="button" className="m-applet__button" onClick={stop}>Stop</button>
          </span>
        ) : (
          <span className="m-applet__actions">
            <button type="button" className="m-applet__button m-applet__button--primary" onClick={start}>{error ? 'Restart' : 'Run'}</button>
          </span>
        ))}
      </header>
      {error && (
        <p className="m-applet__error" role="alert">
          {error}
          {addToDraft && (
            <button
              type="button"
              className="m-applet__link"
              onClick={() => addToDraft(`Please fix applet "${applet.title}" (appletId: ${applet.appletId}, expectedRevision: ${applet.revisionId}). Runtime diagnostic: ${error.slice(0, 2000)}`)}
            >
              Ask the assistant to fix this
            </button>
          )}
        </p>
      )}
      {html ? (
        <iframe
          ref={frame}
          key={generation}
          className="m-applet__frame"
          title={applet.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={html}
          style={{ height }}
          onLoad={() => {
            // A second load means the document navigated away from itself.
            if (++loads.current > 1) {
              setError('The applet tried to open another page and was stopped.')
              stop()
            }
          }}
        />
      ) : (
        <div className="m-applet__idle">
          {source
            ? applet.description || 'Tap Run to use this applet here.'
            : 'This applet could not be read on the phone. Open the thread on the computer to use it.'}
        </div>
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
      <footer className="m-applet__footer">Offline applet · interactions stay on this phone</footer>
    </section>
  )
})

/** A reply's applet that is still being written, like the desktop's "Generating interactive applet…". */
export function AppletPending() {
  return (
    <section className="m-applet m-applet--pending" aria-label="Generating interactive applet" data-testid="applet-pending">
      <div className="m-applet__idle" style={{ height: APPLET_HEIGHT.initial }}>Generating interactive applet…</div>
    </section>
  )
}
