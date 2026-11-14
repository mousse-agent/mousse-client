import { afterEach, describe, expect, it, vi } from 'vitest'
import { faceGuardTripped, faceMode, faceRendererAllowed, faceRendererReady, resetFaceGuard, setFaceMode, CONFIRM_MS } from '../../src/ui/bots/face/faceGuard'

function memoryStore(initial: string | null) {
  const writes: string[] = []
  let value = initial
  return {
    writes,
    value: () => value,
    store: {
      get: async () => value,
      set: async (next: 'ok' | 'starting' | 'off') => { value = next; writes.push(next) },
    },
  }
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  resetFaceGuard(null)
})

describe('bot face guard', () => {
  it('marks a start on disk before allowing the renderer, and clears it once faces have drawn', async () => {
    vi.useFakeTimers()
    const disk = memoryStore(null)
    resetFaceGuard(disk.store)
    expect(faceRendererAllowed()).toBe(false)
    await settle()
    expect(faceRendererAllowed()).toBe(false)
    await settle()
    expect(disk.value()).toBe('starting')
    vi.advanceTimersByTime(300)
    expect(faceRendererAllowed()).toBe(true)
    faceRendererReady()
    vi.advanceTimersByTime(CONFIRM_MS)
    await settle()
    expect(disk.value()).toBe('ok')
  })

  it('a phone already marked ok is guarded again on the next launch', async () => {
    vi.useFakeTimers()
    const disk = memoryStore('ok')
    resetFaceGuard(disk.store)
    faceRendererAllowed()
    await settle()
    faceRendererAllowed()
    await settle()
    vi.advanceTimersByTime(300)
    expect(faceRendererAllowed()).toBe(true)
    faceRendererReady()
    vi.advanceTimersByTime(CONFIRM_MS)
    await settle()
    expect(disk.writes).toEqual(['starting', 'ok'])
  })

  it('after a start that died, faces stay still until turned back on', async () => {
    vi.useFakeTimers()
    const disk = memoryStore('starting')
    resetFaceGuard(disk.store)
    faceRendererAllowed()
    await settle()
    expect(faceMode()).toBe('still')
    expect(faceGuardTripped()).toBe(true)
    expect(disk.value()).toBe('off')
    vi.advanceTimersByTime(10_000)
    expect(faceRendererAllowed()).toBe(false)

    await setFaceMode('live')
    expect(faceGuardTripped()).toBe(false)
    expect(faceMode()).toBe('live')
    faceRendererAllowed()
    await settle()
    expect(disk.value()).toBe('starting')
  })

  it('in a browser there is no guard', () => {
    resetFaceGuard(null)
    expect(faceRendererAllowed()).toBe(true)
  })
})

describe('turning 3D faces off', () => {
  it('stops faces that are already live', async () => {
    const { createElement } = await import('react')
    const { render, act } = await import('@testing-library/react')
    const { BotFace } = await import('../../src/ui/bots/face/BotFace')
    const { resetSharedFaceRenderer } = await import('../../src/ui/bots/face/faceRenderer')
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, drawImage() {} } as never)
    const ready = { status: () => 'ready' as const, canvas: document.createElement('canvas'), ensureSize() {}, draw() {}, finish() {}, onRestored() {}, dispose() {} }
    resetSharedFaceRenderer(() => ({ createGpu: () => ready, createCanvas: () => document.createElement('canvas'), requestFrame: () => 0, cancelFrame() {}, now: () => 0, pixelRatio: () => 1 }) as never)
    const view = render(createElement(BotFace, { look: { colour: 'coral', accessory: 'none' }, state: 'idle', size: 40, view: 'head' }))
    expect(view.container.querySelector('canvas.bot-face-canvas')).not.toBeNull()
    await act(() => setFaceMode('still'))
    expect(view.container.querySelector('canvas')).toBeNull()
    expect(view.container.querySelector('.bot-face-placeholder:not([data-loading])')).not.toBeNull()
    await act(() => setFaceMode('live'))
    expect(view.container.querySelector('canvas.bot-face-canvas')).not.toBeNull()
    view.unmount()
    resetSharedFaceRenderer()
    getContext.mockRestore()
  })
})
