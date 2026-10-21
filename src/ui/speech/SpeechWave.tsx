import { useEffect, useRef } from 'react'
import { WAVE_BARS, type AudioLevels } from './audioLevels'

/** Height of a bar at silence, as a share of the full height. */
const REST = 0.2

/** The desktop's small sound wave (SpeechWave): bars follow the live audio from `levels`. */
export function SpeechWave({ levels }: { levels?: AudioLevels | null }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([])

  useEffect(() => {
    const draw = (values: readonly number[]): void => {
      bars.current.forEach((bar, index) => {
        if (bar) bar.style.transform = `scaleY(${REST + (1 - REST) * (values[index] ?? 0)})`
      })
    }
    if (!levels) {
      draw([])
      return
    }
    let frame = requestAnimationFrame(function tick() {
      draw(levels())
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [levels])

  return (
    <span className="m-speech-wave" aria-hidden="true">
      {Array.from({ length: WAVE_BARS }, (_, index) => (
        <span key={index} ref={(node) => { bars.current[index] = node }} className="m-speech-wave__bar" />
      ))}
    </span>
  )
}
