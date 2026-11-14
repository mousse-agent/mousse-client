import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useVisualViewport } from '../../src/ui/hooks/useVisualViewport'

/** A visual viewport the test resizes, as the WebView does when the keyboard opens. */
class FakeViewport extends EventTarget {
  height = 900
  offsetTop = 0
}

let viewport: FakeViewport

function resize(page: { innerHeight: number; viewportHeight?: number }) {
  Object.defineProperty(window, 'innerHeight', { value: page.innerHeight, configurable: true })
  viewport.height = page.viewportHeight ?? page.innerHeight
  viewport.dispatchEvent(new Event('resize'))
  vi.runAllTimers()
}

const keyboard = () => document.documentElement.dataset.keyboard
const vvHeight = () => document.documentElement.style.getPropertyValue('--vv-height')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  viewport = new FakeViewport()
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
  Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true })
  resize({ innerHeight: 900 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useVisualViewport', () => {
  it('sees the keyboard when Android ends the page above it (the whole page shrinks)', () => {
    renderHook(() => useVisualViewport())
    vi.runAllTimers()
    expect(keyboard()).toBe('closed')

    resize({ innerHeight: 560 })
    expect(keyboard()).toBe('open')
    expect(vvHeight()).toBe('560px')

    resize({ innerHeight: 900 })
    expect(keyboard()).toBe('closed')
    expect(vvHeight()).toBe('900px')
  })

  it('sees the keyboard when only the visual viewport shrinks (iOS)', () => {
    renderHook(() => useVisualViewport())
    resize({ innerHeight: 900, viewportHeight: 560 })
    expect(keyboard()).toBe('open')
    expect(vvHeight()).toBe('560px')
  })

  it('does not take a rotated phone for a keyboard', () => {
    renderHook(() => useVisualViewport())
    Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true })
    resize({ innerHeight: 400 })
    expect(keyboard()).toBe('closed')
  })
})
