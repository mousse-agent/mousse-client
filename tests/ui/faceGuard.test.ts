import { afterEach, describe, expect, it, vi } from 'vitest'
import { faceGuardState, faceGuardTripped, faceMode, faceRendererAllowed, faceRendererReady, FACE_RENDERER_REVISION, resetFaceGuard, setFaceMode, CONFIRM_MS } from '../../src/ui/bots/face/faceGuard'
import { faceDiagnosticsLines, type FaceDiagnosticsInput } from '../../src/ui/bots/face/faceDiagnosticsText'

function memoryStore(initial: string | null) {
  const writes: string[] = []
  let value = initial
  return {
    writes,
    value: () => value,
    store: {
      get: async () => value,
      set: async (next: string) => { value = next; writes.push(next) },
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
    expect(disk.value()).toBe(`starting:${FACE_RENDERER_REVISION}`)
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
    expect(disk.writes).toEqual([`starting:${FACE_RENDERER_REVISION}`, 'ok'])
  })

  it('after a start of this renderer that died, faces stay on their pictures until turned back on', async () => {
    vi.useFakeTimers()
    const disk = memoryStore(`starting:${FACE_RENDERER_REVISION}`)
    resetFaceGuard(disk.store)
    faceRendererAllowed()
    await settle()
    expect(faceMode()).toBe('still')
    expect(faceGuardTripped()).toBe(true)
    expect(disk.value()).toBe(`tripped:${FACE_RENDERER_REVISION}`)
    vi.advanceTimersByTime(10_000)
    expect(faceRendererAllowed()).toBe(false)

    await setFaceMode('live')
    expect(faceGuardTripped()).toBe(false)
    expect(faceMode()).toBe('live')
    faceRendererAllowed()
    await settle()
    expect(disk.value()).toBe(`starting:${FACE_RENDERER_REVISION}`)
  })

  it('stays off on later launches of the same renderer', async () => {
    const disk = memoryStore(`tripped:${FACE_RENDERER_REVISION}`)
    resetFaceGuard(disk.store)
    faceRendererAllowed()
    await settle()
    expect(faceMode()).toBe('still')
    expect(faceGuardTripped()).toBe(true)
    expect(disk.writes).toEqual([])
  })

  for (const older of ['starting', 'off', 'tripped:1', `starting:${FACE_RENDERER_REVISION - 1}`]) {
    it(`tries 3D faces again, guarded, after an older renderer stopped the app (${older})`, async () => {
      vi.useFakeTimers()
      const disk = memoryStore(older)
      resetFaceGuard(disk.store)
      expect(faceRendererAllowed()).toBe(false)
      await settle()
      faceRendererAllowed()
      await settle()
      expect(faceMode()).toBe('live')
      expect(faceGuardTripped()).toBe(false)
      expect(faceGuardState().retrying).toBe(true)
      expect(disk.value()).toBe(`starting:${FACE_RENDERER_REVISION}`)
      vi.advanceTimersByTime(300)
      expect(faceRendererAllowed()).toBe(true)
    })
  }

  it('keeps 3D faces off when they were turned off in Settings, whatever the renderer', async () => {
    const disk = memoryStore(null)
    resetFaceGuard(disk.store)
    await setFaceMode('still')
    expect(disk.value()).toBe('user-off')
    resetFaceGuard(disk.store)
    faceRendererAllowed()
    await settle()
    expect(faceMode()).toBe('still')
    expect(faceGuardTripped()).toBe(false)
    expect(faceGuardState().offBecause).toBe('setting')
  })

  it('in a browser there is no guard', () => {
    resetFaceGuard(null)
    expect(faceRendererAllowed()).toBe(true)
  })

  it('keeps the GPU off when reading native storage stalls', async () => {
    vi.useFakeTimers()
    const never = new Promise<string | null>(() => {})
    resetFaceGuard({ get: () => never, set: async () => {} })
    expect(faceRendererAllowed()).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(faceMode()).toBe('still')
    expect(faceRendererAllowed()).toBe(false)
    expect(faceGuardState().offBecause).toBe('storage')
  })

  it('keeps the GPU off when saving the start mark stalls', async () => {
    vi.useFakeTimers()
    const neverWrite = new Promise<void>(() => {})
    resetFaceGuard({ get: async () => null, set: () => neverWrite })
    expect(faceRendererAllowed()).toBe(false)
    await settle()
    expect(faceRendererAllowed()).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(faceMode()).toBe('still')
    expect(faceRendererAllowed()).toBe(false)
    expect(faceGuardState().offBecause).toBe('storage')
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
    expect(view.container.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(view.container.querySelector('.bot-face-placeholder')).toBeNull()
    await act(() => setFaceMode('live'))
    expect(view.container.querySelector('canvas.bot-face-canvas')).not.toBeNull()
    view.unmount()
    resetSharedFaceRenderer()
    getContext.mockRestore()
  })
})

describe('the Bot faces row in Settings → Advanced', () => {
  const base: FaceDiagnosticsInput = {
    diagnostics: { path: null, renderer: null, parallelCompile: null, highp: null, compileMs: null, drawn: false, problem: null },
    status: 'none',
    guard: { guarded: true, phase: 'armed', offBecause: null, retrying: false, confirmed: false },
    readyMs: null,
    webView: '131.0.6778.200'
  }
  const worker = { path: 'worker' as const, renderer: 'Adreno (TM) 642L', parallelCompile: false, highp: true, compileMs: 840, drawn: true, problem: null }

  it('says 3D faces are on, the GPU, where they draw and how long the shader took', () => {
    expect(faceDiagnosticsLines({ ...base, status: 'ready', diagnostics: worker, readyMs: 1210 })).toEqual([
      'On',
      'GPU: Adreno (TM) 642L',
      'Drawn in the background (Worker), no parallel compile',
      'Shader: compiled in 840 ms, ready 1.2 s after start',
      'WebView 131.0.6778.200'
    ])
  })

  it('does not say On while the shader is ready but no frame has drawn', () => {
    expect(faceDiagnosticsLines({ ...base, status: 'ready', diagnostics: { ...worker, drawn: false }, readyMs: 840 })[0]).toBe('Waiting: shader ready, waiting for the first frame')
  })

  it('says why they are off', () => {
    expect(faceDiagnosticsLines({ ...base, status: 'failed', diagnostics: { ...worker, compileMs: null, drawn: false, problem: 'the face shader did not compile: ERROR: 0:1' } })[0]).toBe('Off: the face shader did not compile: ERROR: 0:1')
    expect(faceDiagnosticsLines({ ...base, status: 'unavailable', diagnostics: { ...base.diagnostics, path: 'page', problem: 'WebGL refused as slow or software (Mali-400)' } })[0]).toBe('Off: WebGL refused as slow or software (Mali-400)')
    expect(faceDiagnosticsLines({ ...base, guard: { ...base.guard, phase: 'off', offBecause: 'tripped' } })[0]).toMatch(/^Off: a start of the 3D faces stopped the app here/)
    expect(faceDiagnosticsLines({ ...base, guard: { ...base.guard, phase: 'off', offBecause: 'setting' } })[0]).toBe('Off: turned off above, in Bots')
    expect(faceDiagnosticsLines({ ...base, guard: { ...base.guard, phase: 'off', offBecause: 'storage' } })[0]).toMatch(/^Off: could not confirm the safety mark/)
  })

  it('says when they are waiting, resting, or trying again after an older version stopped', () => {
    expect(faceDiagnosticsLines({ ...base, status: 'pending', diagnostics: { ...worker, compileMs: null, drawn: false } })[0]).toBe('Waiting: the shader is compiling')
    expect(faceDiagnosticsLines({ ...base, guard: { ...base.guard, phase: 'arming' } })[0]).toBe('Waiting: starting safely')
    expect(faceDiagnosticsLines({ ...base, diagnostics: worker })[0]).toBe('On, resting: no bot face is on screen')
    expect(faceDiagnosticsLines(base)[0]).toBe('Not started yet: the first bot face on screen starts them')
    expect(faceDiagnosticsLines({ ...base, status: 'ready', diagnostics: worker, guard: { ...base.guard, retrying: true } })).toContain('Trying again after an older version stopped')
  })
})
