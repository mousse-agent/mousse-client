import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'

/** How long a finger rests on a row before its options open, as on Android. */
export const LONG_PRESS_MS = 500
/** How far the finger may drift, in CSS pixels, before the press counts as a scroll and is let go. */
export const LONG_PRESS_SLOP_PX = 10

/** A light tick when the options open, where the device can vibrate. */
function tick(): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(10)
  } catch {
    // No vibration is fine.
  }
}

/** How long after the finger lifts the click it makes can still arrive. */
const LIFT_CLICK_MS = 400

/**
 * After a hold opened something, the click and the system menu that the lift makes are dropped wherever they land:
 * by then the options sheet lies under the finger, and a click on its backdrop would close it again.
 */
function swallowLiftClick(): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(timer)
    window.removeEventListener('click', onClick, true)
    window.removeEventListener('contextmenu', onMenu, true)
    window.removeEventListener('pointerup', onLift, true)
    window.removeEventListener('pointercancel', onLift, true)
  }
  const onClick = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    stop()
  }
  const onMenu = (event: Event) => event.preventDefault()
  const onLift = () => {
    clearTimeout(timer)
    timer = setTimeout(stop, LIFT_CLICK_MS)
  }
  window.addEventListener('click', onClick, true)
  window.addEventListener('contextmenu', onMenu, true)
  window.addEventListener('pointerup', onLift, true)
  window.addEventListener('pointercancel', onLift, true)
  // A finger that never lifts (the app went to the background) lets go of the guard too.
  timer = setTimeout(stop, 10_000)
}

export interface LongPressHandlers {
  onPointerDown(event: PointerEvent<HTMLElement>): void
  onPointerMove(event: PointerEvent<HTMLElement>): void
  onPointerUp(): void
  onPointerCancel(): void
  onPointerLeave(): void
  onContextMenu(event: MouseEvent<HTMLElement>): void
  onKeyDown(event: KeyboardEvent<HTMLElement>): void
}

/**
 * Press and hold on a row: `onHold` runs after `LONG_PRESS_MS` unless the finger moved (a scroll) or lifted first.
 * The tap that ends a hold does not also activate the row. A right-click, the context-menu key and Shift+F10 open
 * the same thing, and the system's own long-press menu (text selection, link preview) never shows. Without `onHold`
 * the handlers do nothing, so a row can spread them unconditionally.
 */
export function useLongPress(onHold: (() => void) | undefined, ms = LONG_PRESS_MS): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const start = useRef<{ x: number; y: number }>(undefined)
  /** This press already opened the options. */
  const held = useRef(false)
  const hold = useRef(onHold)
  hold.current = onHold

  const cancel = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    start.current = undefined
  }, [])
  useEffect(() => cancel, [cancel])

  const fire = useCallback(() => {
    // Only a press still down has a lift to come; a right-click has none.
    const pressing = start.current !== undefined
    cancel()
    if (!hold.current) return
    held.current = true
    if (pressing) swallowLiftClick()
    tick()
    hold.current()
  }, [cancel])

  return {
    onPointerDown(event) {
      held.current = false
      if (!hold.current || event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return
      cancel()
      start.current = { x: event.clientX, y: event.clientY }
      timer.current = setTimeout(fire, ms)
    },
    onPointerMove(event) {
      const from = start.current
      if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > LONG_PRESS_SLOP_PX) cancel()
    },
    onPointerUp: cancel,
    // The browser took the touch for a scroll.
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu(event) {
      if (!hold.current) return
      // Android sends this for its own long press, a mouse for a right-click: either way the options, once.
      event.preventDefault()
      if (!held.current) fire()
    },
    onKeyDown(event) {
      if (!hold.current) return
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault()
        held.current = false
        hold.current()
      }
    },
  }
}
