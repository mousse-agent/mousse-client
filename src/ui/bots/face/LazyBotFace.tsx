import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { BotFace, type BotFaceProps } from './BotFace'
import { sharedFaceRendererStatus, subscribeSharedFaceRenderer } from './faceRenderer'
import { LIVE_FACES } from './liveFaces'

/**
 * A face for lists (the Bots row, Recent, a chat's messages) that never slows the screen it is on.
 * With baked faces (the default) it is the face's pictures, like any `BotFace`. With `LIVE_FACES` it
 * shows the face's picture at once, and starts the live face only when both are true:
 * - the face renderer is ready: it starts after the screen has painted, off the render path, so
 *   opening the Chats tab never waits for the WebGL shader to compile;
 * - the face is on screen or close to it.
 * A face that went live stays live while it is mounted.
 */
export function LazyBotFace(props: BotFaceProps) {
  return LIVE_FACES ? <LiveLazyBotFace {...props} /> : <BotFace {...props} />
}

function LiveLazyBotFace(props: BotFaceProps) {
  const ready = useRendererReady()
  const [ref, near] = useNearScreen<HTMLSpanElement>()
  const go = ready && near
  return (
    <span ref={ref} className={`bot-face-lazy${props.className ? ` ${props.className}` : ''}`} style={{ display: 'inline-flex', flex: 'none', width: props.size, height: props.size }}>
      <BotFace {...props} className={undefined} hold={!go} />
    </span>
  )
}

// The renderer is warmed once per app run, when the browser is next idle after a lazy face mounts.
let warm = false
let warming = false
const warmListeners = new Set<() => void>()

function startWarming(): void {
  if (warm || warming) return
  warming = true
  const run = () => {
    warm = true
    warming = false
    // Making the renderer here (not during a render) starts the shader compile in the background.
    sharedFaceRendererStatus()
    for (const listener of [...warmListeners]) listener()
  }
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback
  // Two frames first, so the still faces are painted before any GPU work starts.
  requestAnimationFrame(() => requestAnimationFrame(() => (idle ? idle(run, { timeout: 600 }) : setTimeout(run, 120))))
}

function subscribeReady(listener: () => void): () => void {
  // Only once warm: subscribing holds the renderer open, which a still face should not do.
  let unsubscribe = warm ? subscribeSharedFaceRenderer(listener) : null
  const onWarm = () => {
    unsubscribe ??= subscribeSharedFaceRenderer(listener)
    listener()
  }
  if (!warm) warmListeners.add(onWarm)
  return () => {
    warmListeners.delete(onWarm)
    unsubscribe?.()
  }
}

function readyNow(): boolean {
  return warm && sharedFaceRendererStatus() === 'ready'
}

function useRendererReady(): boolean {
  useEffect(startWarming, [])
  return useSyncExternalStore(subscribeReady, readyNow, () => false)
}

/** True once the element is on screen or within a screen's height of it; it stays true after. */
function useNearScreen<T extends Element>(): [RefObject<T>, boolean] {
  const [near, setNear] = useState(false)
  const ref = useRef<T>(null)
  useEffect(() => {
    const node = ref.current
    if (near || !node) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true)
    }, { rootMargin: '100% 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [near])
  return [ref, near]
}

/** For tests: the next lazy face warms the renderer again. */
export function resetLazyFaces(): void {
  warm = false
  warming = false
}
