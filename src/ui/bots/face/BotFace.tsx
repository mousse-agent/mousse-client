import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { BotState } from '../../../connection/bots'
import { BOT_ACCESSORY_HEX, BOT_ACCESSORY_LABELS, BOT_COLOUR_HEX, botEyesOf, botKindOf, normalizeBotLook, type BotLook, type KnownBotLook } from '../look'
import { useMotionScale } from '../motion'
import { hexToRgb, mousseEyesWhite } from './facePoses'
import { facePixelRatio, sharedFaceRenderer, sharedFaceRendererStatus, stillFrameKey, subscribeSharedFaceRenderer, type FaceHandle, type FaceSpec } from './faceRenderer'
import { faceGuardWaiting, faceMode } from './faceGuard'
import { faceShot } from './faceShots'
import { bakedFaceLayers, bakedFaceUrl, type BakedFaceView } from './bakedFaces'
import { LIVE_FACES } from './liveFaces'
import { BotBoundary } from '../BotBoundary'
import './face.css'

/**
 * A bot's face (Bot Phase 1 §5.12, bot-ui §4.3): its clay mouse or Mousse, whose pose shows the state.
 * `happy` is the renderer-only "done" moment. `head` shows the head (lists, header, messages: 22 to
 * 60 px); `full` the whole mouse (About, the empty page: 84 to 112 px). Faces show as baked pictures
 * (`bakedFaces.ts`) unless `LIVE_FACES` turns the live 3D renderer back on; then `still` draws the
 * pose without motion, and reduced motion does the same.
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
  /** Show only the picture for now: the live face is not to start yet (lists wait until it is near the screen). */
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
 * - `off`: no 3D faces on this phone (no WebGL, a failed or stalled renderer, or turned off in Settings).
 * Until the live face draws, the face shows its saved picture from an earlier visit, or its baked
 * picture. On failure or when off, it shows the saved picture if there is one, otherwise the baked one.
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
  return LIVE_FACES ? <LiveBotFace {...props} /> : <BakedBotFace {...props} />
}

/**
 * The face as its baked pictures, stacked. Nothing moves but the paused "z". A picture that fails to
 * load (a build without them) shows the flat `BotFaceStill` instead of a broken image.
 */
function BakedBotFace(props: BotFaceProps) {
  const { look, state, size, view } = normalizeFaceProps(props)
  const [failed, setFailed] = useState(false)
  const motionOff = useMotionScale() === 0
  if (failed) return <BotFaceStill {...props} />
  return (
    <span
      className={`bot-face${props.className ? ` ${props.className}` : ''}`}
      style={{ width: size, height: size }}
      data-state={state}
      data-view={view}
      data-colour={look.colour}
      data-accessory={look.accessory}
      data-kind={botKindOf(look)}
      data-eyes={botEyesOf(look)}
      data-still={props.still === true || motionOff ? 'true' : undefined}
      {...a11y(props.label)}
    >
      <BakedLayers look={look} state={state} view={view} size={size} onError={() => setFailed(true)} />
      {state === 'paused' && <PausedZ size={size} />}
    </span>
  )
}

/** The face's baked layers, bottom first, filling the face. */
function BakedLayers({ look, state, view, size, onError }: { look: KnownBotLook; state: BotFaceState; view: BakedFaceView; size: number; onError(): void }) {
  return (
    <span className="bot-face-layers" aria-hidden>
      {bakedFaceLayers(look, state, view, size).map((face) => (
        <img key={face.layer.layer} className="bot-face-layer" src={bakedFaceUrl(face)} alt="" draggable={false} decoding="async" onError={onError} />
      ))}
    </span>
  )
}

function PausedZ({ size }: { size: number }) {
  return (
    <span className="bot-face-z" style={{ fontSize: Math.max(8, Math.round(size * 0.18)) }} aria-hidden>
      z
    </span>
  )
}

function LiveBotFace(props: BotFaceProps) {
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
  const off = show === 'off' || broken
  // A face that goes back to waiting (a lost context) shows its picture until it draws again.
  if (!live && drawn) setDrawn(false)
  if (off && !shot) return <BakedBotFace {...props} />
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
        : <BakedLayers look={look} state={state} view={view} size={size} onError={() => {}} />)}
      {live && (
        // A live face that throws (a lost context, a driver quirk) falls back to the picture or still face, never a blank app.
        <BotBoundary fallback={<OnBroken onBroken={() => setBroken(true)} />}>
          <BotFaceCanvas spec={{ look, state, size, view, still }} onDrawn={() => setDrawn(true)} onBroken={() => setBroken(true)} />
        </BotBoundary>
      )}
      {state === 'paused' && <PausedZ size={size} />}
    </span>
  )
}

function OnBroken({ onBroken }: { onBroken(): void }) {
  useLayoutEffect(onBroken, [onBroken])
  return null
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

/**
 * The flat fallback, for a face whose baked pictures fail to load: the mouse's round head
 * and ears, or the Mousse in its glass, in the look's colour with eyes, and a badge in the
 * accessory's colour. Unknown look values draw as the default.
 */
export function BotFaceStill(props: BotFaceProps) {
  const { look: known, state, size, view } = normalizeFaceProps(props)
  const body = BOT_COLOUR_HEX[known.colour]
  const accessory = BOT_ACCESSORY_HEX[known.accessory]
  const asleep = state === 'paused'
  const mousse = botKindOf(known) === 'mousse'
  return (
    <svg
      className={`bot-face bot-face-still${props.className ? ` ${props.className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      data-state={state}
      data-view={view}
      data-colour={known.colour}
      data-accessory={known.accessory}
      data-kind={botKindOf(known)}
      data-eyes={botEyesOf(known)}
      data-still="true"
      style={{ flex: 'none', opacity: asleep ? 0.6 : 1 }}
      overflow="visible"
      {...a11y(props.label)}
    >
      {mousse ? (
        <MousseStill colour={body} asleep={asleep} tall={state === 'needs_you'} />
      ) : (
        <>
          <circle cx="10" cy="11" r="7" fill={body} />
          <circle cx="30" cy="11" r="7" fill={body} />
          <circle cx="20" cy="23" r="14" fill={body} />
          {asleep ? (
            <g stroke="#1c1c1f" strokeWidth="1.6" strokeLinecap="round">
              <line x1="13.5" y1="22" x2="17" y2="22" />
              <line x1="23" y1="22" x2="26.5" y2="22" />
            </g>
          ) : (
            <g fill="#1c1c1f">
              <ellipse cx="15.5" cy="21.5" rx="1.8" ry={state === 'needs_you' ? 3 : 2.4} />
              <ellipse cx="24.5" cy="21.5" rx="1.8" ry={state === 'needs_you' ? 3 : 2.4} />
            </g>
          )}
          <circle cx="20" cy="27" r="1.3" fill="#1c1c1f" />
        </>
      )}
      {accessory && (
        <circle cx="33" cy="33" r="5" fill={accessory} stroke="#ffffff" strokeWidth="1.5">
          <title>{BOT_ACCESSORY_LABELS[known.accessory]}</title>
        </circle>
      )}
      {asleep && (
        <text className="bot-face-z-still" x="35" y="5" fontSize="10" fontWeight="700" style={{ fill: 'var(--bot-face-z, #b8a9f6)' }} aria-hidden>
          z
        </text>
      )}
    </svg>
  )
}

/** Mixes two colours given as 0 to 1 channels, into a hex colour. */
function mixRgb(a: readonly number[], b: readonly number[], t: number): string {
  return `#${a.map((v, i) => Math.round(Math.min(1, v + (b[i] - v) * t) * 255).toString(16).padStart(2, '0')).join('')}`
}

/**
 * The Mousse traced from the face shader's shape: the mousse with its curl (light at the top, deep
 * at the bottom), the glass outline and rim, and flat eyes in white or near-black.
 */
function MousseStill({ colour, asleep, tall }: { colour: string; asleep: boolean; tall: boolean }) {
  const id = useId()
  const c = hexToRgb(colour)
  const white = [1, 1, 1]
  const deep = c.map((v, i) => v * [0.3, 0.26, 0.38][i])
  const glass = mixRgb(c, [0, 0, 0], 0.24)
  const ink = mousseEyesWhite(colour) ? '#ffffff' : '#0e0b14'
  return (
    <>
      <defs>
        <linearGradient id={`${id}m`} x1="0" y1="3" x2="0" y2="36.6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={mixRgb(c, white, 0.5)} />
          <stop offset="0.35" stopColor={mixRgb(c, white, 0.62)} />
          <stop offset="0.55" stopColor={mixRgb(c, white, 0.3)} />
          <stop offset="0.78" stopColor={mixRgb(c, [0, 0, 0], 0.14)} />
          <stop offset="1" stopColor={mixRgb(c, deep, 0.7)} />
        </linearGradient>
      </defs>
      <path
        d="M20 36.6L23.6 36.2L27 35.5L29.8 33.8L31.6 31.2L32.6 27.9L32.8 24.4L32.5 21.1L32.1 18.2L31.4 16.8L30.7 15.5L29.3 14.2L27.8 13.2L27 12.4L26.7 11.4L26.1 10.6L25.2 9.6L24.1 8.8L23.2 7.9L22.5 6.9L22.2 6.1L22.2 5.1L22.8 4.2L23.3 3.5L23 3.1L22.1 3.5L21.2 4.2L20.3 5.1L19.6 6.1L18.9 6.9L18.4 7.9L18 8.8L18 9.6L17.8 10.6L17.5 11.4L16.6 12.4L15.2 13.2L13.1 14.2L10.5 15.5L8.9 16.8L7.9 18.2L7.5 21.1L7.2 24.4L7.4 27.9L8.4 31.2L10.2 33.8L13 35.5L16.4 36.2Z"
        fill={`url(#${id}m)`}
      />
      <path
        d="M7.8 12.3L7.6 15.1L7.1 17.8L6.6 20.4L6.3 23.6L6.4 25.9L6.7 28.6L7.6 31.2L9.2 33.5L11 35.1L15.1 36.6L20 37L24.9 36.6L29 35.1L30.8 33.5L32.4 31.2L33.3 28.6L33.6 25.9L33.7 23.6L33.4 20.4L32.9 17.8L32.4 15.1L32.2 12.3"
        fill="none"
        stroke={glass}
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
      <line x1="7.4" y1="12.3" x2="32.6" y2="12.3" stroke={mixRgb(c, white, 0.35)} strokeWidth="1.1" strokeLinecap="round" />
      {asleep ? (
        <g stroke={ink} strokeWidth="1.6" strokeLinecap="round">
          <line x1="15" y1="29.4" x2="18.4" y2="29.4" />
          <line x1="21.6" y1="29.4" x2="25" y2="29.4" />
        </g>
      ) : (
        <g fill={ink}>
          <ellipse cx="16.7" cy="29.2" rx="1.9" ry={tall ? 3.2 : 2.6} />
          <ellipse cx="23.3" cy="29.2" rx="1.9" ry={tall ? 3.2 : 2.6} />
        </g>
      )}
    </>
  )
}
