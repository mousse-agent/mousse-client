// The Mousse mascot on the empty Bots page (#1579): the clay Mousse goblet with a bow tie on an
// accent glow. Its eyes follow the pointer or touch anywhere in the window, blink periodically, and
// ease back to the centre after the pointer stops or leaves. A tap makes it hop and shut its eyes
// into happy arcs for a moment. Respects reduced motion without touching the 3D face renderer internals.
import { useEffect, useId, useRef, useState } from 'react'
import { useMotionScale } from './motion'

const CHEER_MS = 1400
const HOP_MS = 620
const FOLLOW_REST_MS = 1800
const MAX_EYE_X = 2.6
const MAX_EYE_Y = 1.6
const FOLLOW_REACH = 1.8

const HOP_FRAMES: Keyframe[] = [
  { transform: 'translateY(0) scale(1, 1) rotate(0deg)', easing: 'ease-out' },
  { transform: 'translateY(2px) scale(1.07, 0.92) rotate(0deg)', offset: 0.18, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
  { transform: 'translateY(-18px) scale(0.96, 1.05) rotate(-4deg)', offset: 0.48, easing: 'cubic-bezier(0.6, 0, 0.8, 0.4)' },
  { transform: 'translateY(1px) scale(1.05, 0.95) rotate(0deg)', offset: 0.78, easing: 'ease-out' },
  { transform: 'translateY(0) scale(1, 1) rotate(0deg)' },
]

/** How far the mascot's eyes turn (in SVG viewBox units) towards a point `(x, y)` relative to `box`. */
export function mascotEyeOffset(box: { left: number; top: number; width: number; height: number }, x: number, y: number): { x: number; y: number } {
  if (!(box.width > 0)) return { x: 0, y: 0 }
  const reach = box.width * FOLLOW_REACH
  const dx = (x - (box.left + box.width / 2)) / reach
  const dy = (y - (box.top + box.height / 2)) / reach
  const far = Math.hypot(dx, dy)
  const pull = far > 0 ? Math.pow(Math.min(1, far), 0.6) / far : 0
  return {
    x: dx * pull * MAX_EYE_X + 0,
    y: dy * pull * MAX_EYE_Y + 0,
  }
}

export function Mascot({ size = 96, className }: { size?: number; className?: string }) {
  const id = useId()
  const [cheering, setCheering] = useState(false)
  const [blinking, setBlinking] = useState(false)
  const [look, setLook] = useState<{ x: number; y: number; ms: number }>({ x: 0, y: 0, ms: 220 })
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const hopper = useRef<HTMLSpanElement>(null)
  const root = useRef<HTMLButtonElement>(null)
  const hop = useRef<Animation | null>(null)
  const moving = useMotionScale() !== 0

  useEffect(() => () => { clearTimeout(timer.current); hop.current?.cancel() }, [])

  // Periodic natural blinking while idle and motion is allowed.
  useEffect(() => {
    if (!moving || cheering) { setBlinking(false); return }
    let nextTimer: ReturnType<typeof setTimeout>
    let endTimer: ReturnType<typeof setTimeout>
    const schedule = () => {
      nextTimer = setTimeout(() => {
        if (document.visibilityState !== 'hidden') {
          setBlinking(true)
          endTimer = setTimeout(() => setBlinking(false), 160)
        }
        schedule()
      }, 2400 + Math.random() * 2600)
    }
    schedule()
    return () => { clearTimeout(nextTimer); clearTimeout(endTimer) }
  }, [moving, cheering])

  // Follow pointer and touch anywhere in the window; drift back to centre after idle or leave/blur.
  useEffect(() => {
    if (!moving) { setLook({ x: 0, y: 0, ms: 0 }); return }
    let frame = 0
    let rest: ReturnType<typeof setTimeout> | undefined
    let at: { x: number; y: number } | null = null
    const centre = () => {
      at = null
      clearTimeout(rest)
      setLook({ x: 0, y: 0, ms: 700 })
    }
    const apply = () => {
      frame = 0
      const box = root.current?.getBoundingClientRect()
      if (!at || !box || box.width === 0) return
      const offset = mascotEyeOffset(box, at.x, at.y)
      setLook({ x: offset.x, y: offset.y, ms: 180 })
    }
    const track = (x: number, y: number) => {
      at = { x, y }
      if (!frame) frame = requestAnimationFrame(apply)
      clearTimeout(rest)
      rest = setTimeout(centre, FOLLOW_REST_MS)
    }
    const onPointer = (event: PointerEvent) => track(event.clientX, event.clientY)
    const onTouch = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (touch) track(touch.clientX, touch.clientY)
    }
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('pointerdown', onPointer, { passive: true })
    window.addEventListener('touchmove', onTouch, { passive: true })
    window.addEventListener('touchstart', onTouch, { passive: true })
    document.documentElement.addEventListener('pointerleave', centre)
    window.addEventListener('blur', centre)
    return () => {
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('touchmove', onTouch)
      window.removeEventListener('touchstart', onTouch)
      document.documentElement.removeEventListener('pointerleave', centre)
      window.removeEventListener('blur', centre)
      if (frame) cancelAnimationFrame(frame)
      clearTimeout(rest)
    }
  }, [moving])

  const poke = () => {
    clearTimeout(timer.current)
    setCheering(true)
    timer.current = setTimeout(() => setCheering(false), CHEER_MS)
    if (!moving || hop.current?.playState === 'running' || typeof hopper.current?.animate !== 'function') return
    hop.current = hopper.current.animate(HOP_FRAMES, { duration: HOP_MS })
  }

  const eyeTransform = `translate(${look.x.toFixed(2)}px, ${look.y.toFixed(2)}px)`
  const eyeTransition = moving && look.ms > 0 ? `transform ${look.ms}ms cubic-bezier(0.25, 0.6, 0.3, 1)` : 'none'

  return (
    <button
      ref={root}
      type="button"
      className={`bot-mascot${className ? ` ${className}` : ''}`}
      data-state={cheering ? 'happy' : 'idle'}
      aria-label="Mousse mascot"
      onClick={poke}
    >
      <span className="bot-mascot__body">
        <span ref={hopper} className="bot-mascot__hopper">
          <svg
            width={size}
            height={size}
            viewBox="0 0 40 40"
            className="bot-mascot__svg"
            overflow="visible"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={`${id}-body`} x1="0" y1="3" x2="0" y2="36.6" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#ffaba4" />
                <stop offset="0.35" stopColor="#ffbbb5" />
                <stop offset="0.55" stopColor="#ff887f" />
                <stop offset="0.78" stopColor="#e24b3f" />
                <stop offset="1" stopColor="#8f2924" />
              </linearGradient>
              <radialGradient id={`${id}-shine`} cx="35%" cy="28%" r="48%">
                <stop offset="0" stopColor="#ffffff" stopOpacity="0.45" />
                <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
              </radialGradient>
            </defs>
            {/* Clay Mousse silhouette (mousse in a goblet with curled whip top). */}
            <path
              d="M20 36.6L23.6 36.2L27 35.5L29.8 33.8L31.6 31.2L32.6 27.9L32.8 24.4L32.5 21.1L32.1 18.2L31.4 16.8L30.7 15.5L29.3 14.2L27.8 13.2L27 12.4L26.7 11.4L26.1 10.6L25.2 9.6L24.1 8.8L23.2 7.9L22.5 6.9L22.2 6.1L22.2 5.1L22.8 4.2L23.3 3.5L23 3.1L22.1 3.5L21.2 4.2L20.3 5.1L19.6 6.1L18.9 6.9L18.4 7.9L18 8.8L18 9.6L17.8 10.6L17.5 11.4L16.6 12.4L15.2 13.2L13.1 14.2L10.5 15.5L8.9 16.8L7.9 18.2L7.5 21.1L7.2 24.4L7.4 27.9L8.4 31.2L10.2 33.8L13 35.5L16.4 36.2Z"
              fill={`url(#${id}-body)`}
            />
            <path
              d="M20 36.6L23.6 36.2L27 35.5L29.8 33.8L31.6 31.2L32.6 27.9L32.8 24.4L32.5 21.1L32.1 18.2L31.4 16.8L30.7 15.5L29.3 14.2L27.8 13.2L27 12.4L26.7 11.4L26.1 10.6L25.2 9.6L24.1 8.8L23.2 7.9L22.5 6.9L22.2 6.1L22.2 5.1L22.8 4.2L23.3 3.5L23 3.1L22.1 3.5L21.2 4.2L20.3 5.1L19.6 6.1L18.9 6.9L18.4 7.9L18 8.8L18 9.6L17.8 10.6L17.5 11.4L16.6 12.4L15.2 13.2L13.1 14.2L10.5 15.5L8.9 16.8L7.9 18.2L7.5 21.1L7.2 24.4L7.4 27.9L8.4 31.2L10.2 33.8L13 35.5L16.4 36.2Z"
              fill={`url(#${id}-shine)`}
            />
            {/* Glass bowl outline and rim. */}
            <path
              d="M7.8 12.3L7.6 15.1L7.1 17.8L6.6 20.4L6.3 23.6L6.4 25.9L6.7 28.6L7.6 31.2L9.2 33.5L11 35.1L15.1 36.6L20 37L24.9 36.6L29 35.1L30.8 33.5L32.4 31.2L33.3 28.6L33.6 25.9L33.7 23.6L33.4 20.4L32.9 17.8L32.4 15.1L32.2 12.3"
              fill="none"
              stroke="rgba(120, 32, 28, 0.42)"
              strokeWidth="0.9"
              strokeLinejoin="round"
            />
            <line x1="7.4" y1="12.3" x2="32.6" y2="12.3" stroke="rgba(255, 224, 220, 0.55)" strokeWidth="1.1" strokeLinecap="round" />
            {/* Eyes that follow the pointer / touch, blink, or shut into happy arcs on tap. */}
            <g className="bot-mascot__eyes" style={{ transform: cheering ? 'none' : eyeTransform, transition: eyeTransition }}>
              {cheering ? (
                <g stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" fill="none">
                  <path d="M14.4 29.8 A 2.4 2.4 0 0 1 19.0 29.8" />
                  <path d="M21.0 29.8 A 2.4 2.4 0 0 1 25.6 29.8" />
                </g>
              ) : (
                <g fill="#ffffff" style={{ transformOrigin: '20px 28.8px', transform: blinking ? 'scaleY(0.08)' : 'scaleY(1)', transition: 'transform 70ms ease-out' }}>
                  <ellipse cx="16.5" cy="28.8" rx="1.9" ry="2.65" />
                  <ellipse cx="23.5" cy="28.8" rx="1.9" ry="2.65" />
                </g>
              )}
            </g>
            {/* Signature bow tie. */}
            <g fill="#1e1e22" stroke="rgba(255,255,255,0.14)" strokeWidth="0.45">
              <path d="M19.2 35.6 L15.2 33.8 L15.2 37.6 Z" />
              <path d="M20.8 35.6 L24.8 33.8 L24.8 37.6 Z" />
              <circle cx="20" cy="35.7" r="1.25" />
            </g>
          </svg>
        </span>
      </span>
    </button>
  )
}
