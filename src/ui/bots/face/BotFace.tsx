import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { BotState } from '../../../connection/bots'
import { BOT_COLOUR_HEX, botEyesOf, botKindOf, normalizeBotLook, type BotLook, type KnownBotLook } from '../look'
import { useMotionScale } from '../motion'
import { facePixelRatio, sharedFaceRenderer, sharedFaceRendererStatus, stillFrameKey, subscribeSharedFaceRenderer, type FaceHandle, type FaceSpec } from './faceRenderer'
import { faceGuardWaiting, faceMode } from './faceGuard'
import { faceShot } from './faceShots'
import { BotBoundary } from '../BotBoundary'
import './face.css'

/**
 * A bot's face (Bot Phase 1 §5.12, bot-ui §4.3): its clay mouse or Mousse, whose pose shows the state.
 * `happy` is the renderer-only "done" moment. `head` shows the head (lists, header, messages: 34 to
 * 48 px); `full` the whole mouse (About, the empty page: 88 to 104 px). `still` draws the pose
 * without motion; reduced motion does the same.
 */
export type BotFaceState = BotState | 'happy'

export interface BotFaceProps {
  look: BotLook
  state: BotFaceState
  /** CSS pixels, square. */
  size: number
  view: 'head' | 'full'
  still?: boolean
  /** Accessible name; without it the face is decorative. */
  label?: string
  className?: string
  /** Show only the loading state for now: the live face is not to start yet (lists wait until it is near the screen). */
  hold?: boolean
}

export const BOT_FACE_STATES: readonly BotFaceState[] = ['idle', 'working', 'needs_you', 'stuck', 'paused', 'happy']
const DEFAULT_SIZE = 40
const MIN_SIZE = 16
const MAX_SIZE = 256

export interface NormalizedFaceProps {
  look: KnownBotLook
  state: BotFaceState
  size: number
  view: 'head' | 'full'
}

/** The face this build draws: unknown looks and states read as the defaults, sizes are whole pixels in range. */
export function normalizeFaceProps(props: Pick<BotFaceProps, 'look' | 'state' | 'size' | 'view'>): NormalizedFaceProps {
  const size = Number.isFinite(props.size) && props.size > 0 ? Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, props.size))) : DEFAULT_SIZE
  return {
    look: normalizeBotLook(props.look),
    state: BOT_FACE_STATES.includes(props.state) ? props.state : 'idle',
    size,
    view: props.view === 'full' ? 'full' : 'head'
  }
}

function a11y(label: string | undefined) {
  return label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const)
}

/**
 * How a face shows right now:
 * - `live`: the WebGL renderer is compiling (in the background) or ready; the canvas is mounted and
 *   fades in on its first frame.
 * - `waiting`: the live face will come (the guard is saving its mark, or `hold`); the loader moves.
 * - `off`: no 3D faces on this phone (no WebGL, a failed shader, or turned off in Settings).
 * Until the live face draws, the face shows its saved picture from an earlier visit, or the loader.
 * The flat drawings older builds showed here are gone: a face is the 3D face or its loader.
 */
type FaceShow = 'live' | 'waiting' | 'off'

function useFaceShow(hold: boolean | undefined): FaceShow {
  const status = useSyncExternalStore(subscribeSharedFaceRenderer, sharedFaceRendererStatus, () => 'unavailable' as const)
  const guardWaiting = useSyncExternalStore(subscribeSharedFaceRenderer, faceGuardWaiting, () => false)
  // Turned off in Settings: faces already live stop too, not only ones made from now on.
  const off = useSyncExternalStore(subscribeSharedFaceRenderer, faceMode, () => 'live' as const) === 'still'
  if (off) return 'off'
  if (status === 'pending' || status === 'ready') return hold ? 'waiting' : 'live'
  if (guardWaiting) return 'waiting'
  return 'off'
}

export function BotFace(props: BotFaceProps) {
  const { look, state, size, view } = normalizeFaceProps(props)
  const show = useFaceShow(props.hold)
  const [broken, setBroken] = useState(false)
  const [drawn, setDrawn] = useState(false)
  const motionOff = useMotionScale() === 0
  const still = props.still === true || motionOff
  const ratio = facePixelRatio(typeof window === 'undefined' ? 1 : window.devicePixelRatio)
  // The renderer saves each face's still pose under this key (its look, pose, view, size and canvas side).
  const shot = faceShot(stillFrameKey({ look, state, view, size }, Math.max(1, Math.round(size * ratio))))
  const live = show === 'live' && !broken
  const loading = !shot && (live || show === 'waiting')
  // A face that goes back to waiting (a lost context) shows its picture or loader until it draws again.
  if (!live && drawn) setDrawn(false)
  return (
    <span
      className={`bot-face${props.className ? ` ${props.className}` : ''}`}
      style={{ width: size, height: size, ['--bot-face-colour' as string]: BOT_COLOUR_HEX[look.colour] } as CSSProperties}
      data-state={state}
      data-view={view}
      data-colour={look.colour}
      data-accessory={look.accessory}
      data-kind={botKindOf(look)}
      data-eyes={botEyesOf(look)}
      data-still={still ? 'true' : undefined}
      data-drawn={live && drawn ? 'true' : undefined}
      {...a11y(props.label)}
    >
      {!(live && drawn) && (shot
        ? <img className="bot-face-shot" src={shot} alt="" aria-hidden draggable={false} />
        : <span className="bot-face-placeholder" data-loading={loading ? 'true' : undefined} aria-hidden />)}
      {live && (
        // A live face that throws (a lost context, a driver quirk) leaves the picture or loader, never a blank app.
        <BotBoundary fallback={null}>
          <BotFaceCanvas spec={{ look, state, size, view, still }} onDrawn={() => setDrawn(true)} onBroken={() => setBroken(true)} />
        </BotBoundary>
      )}
      {state === 'paused' && (
        <span className="bot-face-z" style={{ fontSize: Math.max(8, Math.round(size * 0.18)) }} aria-hidden>
          z
        </span>
      )}
    </span>
  )
}

/** The canvas the shared WebGL renderer draws this face into. */
function BotFaceCanvas({ spec, onDrawn, onBroken }: { spec: FaceSpec; onDrawn(): void; onBroken(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<FaceHandle | null>(null)
  const specRef = useRef(spec)
  specRef.current = spec
  const onDrawnRef = useRef(onDrawn)
  onDrawnRef.current = onDrawn

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const handle = canvas
      ? sharedFaceRenderer()?.register(canvas, specRef.current, { onDrawn: () => onDrawnRef.current() }) ?? null
      : null
    if (!handle) {
      onBroken()
      return
    }
    handleRef.current = handle
    return () => {
      handle.dispose()
      handleRef.current = null
    }
    // Registered once per mount; changes go through update() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { look, state, size, view, still } = spec
  useLayoutEffect(() => {
    handleRef.current?.update(specRef.current)
  }, [look.colour, look.accessory, look.kind, look.eyes, state, size, view, still])

  return <canvas ref={canvasRef} className="bot-face-canvas" aria-hidden />
}
