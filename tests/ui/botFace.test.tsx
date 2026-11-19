import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BotFace, normalizeFaceProps, type BotFaceState } from '../../src/ui/bots/face/BotFace'
import { LazyBotFace, resetLazyFaces } from '../../src/ui/bots/face/LazyBotFace'
import { currentFaceDiagnosticsLines } from '../../src/ui/bots/face/faceDiagnosticsText'
import { faceShot, resetFaceShots, saveFaceShot, type FaceFrameStore, type SavedFrameImage } from '../../src/ui/bots/face/faceShots'
import { FaceMotion, faceUniforms, hop, stillPose, type FaceUniforms } from '../../src/ui/bots/face/facePoses'
import {
  createWebGlGpu,
  createWorkerGpu,
  faceArtVersion,
  faceDiagnostics,
  FaceRenderer,
  faceDrawSide,
  faceRendererStats,
  FRAME_TIMEOUT_MS,
  IDLE_LIVE_SECONDS,
  IDLE_RELEASE_MS,
  LOST_CONTEXT_TIMEOUT_MS,
  MAX_NULL_FRAMES,
  READY_POLL_MS,
  resetSharedFaceRenderer,
  SAMPLE_BUDGET,
  sharedFaceRendererStatus,
  STARTUP_TIMEOUT_MS,
  stillFrameKey,
  UNFOCUSED_LIVE_SECONDS,
  WAKE_LEAD_MS,
  softwareWebGl,
  type FaceBatch,
  type FaceGpu,
  type FaceRendererEnv,
  type WorkerFaceGpu
} from '../../src/ui/bots/face/faceRenderer'
import type { FaceWorkerReply, FaceWorkerRequest } from '../../src/ui/bots/face/faceWorker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let webgl: 'none' | 'throws' | 'software' = 'none'
/** A WebGL context that Chromium hands out in software (its unsafe SwiftShader). */
const softwareContext = {
  getExtension: (name: string) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
  getParameter: () => 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'
}
let reducedMotion = false

const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>()
function fake2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  let ctx = contexts.get(canvas)
  if (!ctx) contexts.set(canvas, (ctx = { clearRect: vi.fn(), drawImage: vi.fn(), imageSmoothingQuality: 'low' } as unknown as CanvasRenderingContext2D))
  return ctx
}

beforeEach(() => {
  webgl = 'none'
  reducedMotion = false
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind === '2d') return fake2d(this)
    if (webgl === 'throws') throw new Error('no GPU process')
    if (webgl === 'software') return softwareContext as unknown as WebGLRenderingContext
    return null
  } as typeof HTMLCanvasElement.prototype.getContext)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reducedMotion && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }))
  resetFaceShots()
  // jsdom has no picture encoder: faces save no picture unless a test gives one.
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetSharedFaceRenderer()
  resetLazyFaces()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setVisibility('visible')
})

function render(element: ReactElement | null) {
  act(() => root.render(element))
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
}

class FakeObserver {
  static last: FakeObserver | null = null
  readonly targets = new Set<Element>()
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.last = this
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
  }
  fire(isIntersecting: boolean, only?: Element) {
    const entries = [...this.targets].filter((target) => !only || target === only).map((target) => ({ target, isIntersecting }))
    act(() => this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver))
  }
}

/** A renderer environment with a fake GPU and a manual frame clock. */
function fakeEnv(options: {
  observer?: boolean
  status?: () => ReturnType<FaceGpu['status']>
  pixelRatio?: number
  focus?: boolean
  saved?: FaceFrameStore
  /** The clock's start, in ms. */
  start?: number
  /** No `setTimer`: the renderer asks for a frame every display frame, as it did before shared ticks. */
  noTimers?: boolean
  /** Milliseconds each timer runs late (negative: early). */
  timerLate?: () => number
} = {}) {
  const frames = new Map<number, (now: number) => void>()
  let id = 0
  let now = options.start ?? 1000
  /** Each face drawn, with the time of the frame that drew it. */
  const draws: { side: number; uniforms: FaceUniforms; at: number }[] = []
  const lost = new Set<() => void>()
  const restored = new Set<() => void>()
  const timers = new Map<number, { at: number; callback: () => void }>()
  let ratio = options.pixelRatio ?? 1
  const ratioListeners = new Set<() => void>()
  let focused = true
  const focusListeners = new Set<() => void>()
  /** The shared drawing buffer's size, as the WebGL side keeps it: grown by draws, shrunk to 1×1. */
  const buffer = { width: 1, height: 1 }
  const gpu: FaceGpu = {
    canvas: document.createElement('canvas'),
    status: options.status ?? (() => 'ready'),
    ensureSize: vi.fn((width: number, height: number) => {
      buffer.width = Math.max(buffer.width, width)
      buffer.height = Math.max(buffer.height, height)
    }),
    draw: (_x, _y, side, uniforms) => draws.push({ side, uniforms, at: now }),
    finish: vi.fn(),
    onRestored: (listener) => restored.add(listener),
    onLost: (listener) => lost.add(listener),
    shrink: vi.fn(() => {
      buffer.width = buffer.height = 1
    }),
    dispose: vi.fn()
  }
  const log = vi.fn()
  const env: FaceRendererEnv = {
    createGpu: () => gpu,
    createCanvas: () => document.createElement('canvas'),
    requestFrame: (callback) => {
      frames.set(++id, callback)
      return id
    },
    cancelFrame: (frame) => frames.delete(frame),
    now: () => now,
    pixelRatio: () => ratio,
    ...(options.focus
      ? {
          hasFocus: () => focused,
          onFocusChange: (listener: () => void) => {
            focusListeners.add(listener)
            return () => focusListeners.delete(listener)
          }
        }
      : {}),
    onPixelRatioChange: (listener) => {
      ratioListeners.add(listener)
      return () => ratioListeners.delete(listener)
    },
    document,
    IntersectionObserver: options.observer ? (FakeObserver as unknown as typeof IntersectionObserver) : undefined,
    random: () => 0.5,
    ...(options.noTimers
      ? {}
      : {
          setTimer: (callback: () => void, ms: number) => {
            const timer = ++id
            timers.set(timer, { at: now + ms + (options.timerLate?.() ?? 0), callback })
            return () => timers.delete(timer)
          }
        }),
    frames: options.saved,
    log
  }
  /** Runs the timers due before `end` at their own times, in order, as the event loop does between display frames. */
  const runTimers = (end: number) => {
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined
      for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
      if (!next) return
      timers.delete(next[0])
      now = Math.max(now, next[1].at)
      next[1].callback()
    }
  }
  /** Advances the clock by `ms`, running the timers due on the way, then one display frame at the end. */
  const tick = (ms = 1000 / 30) => {
    const end = now + ms
    act(() => {
      runTimers(end)
      now = end
      const due = [...frames.values()]
      frames.clear()
      for (const callback of due) callback(now)
    })
  }
  /** Runs a display at `hz` for `ms`: timers at their own times, a frame every display frame. Returns the frame times that ran a frame callback. */
  const display = (ms: number, hz: number) => {
    const period = 1000 / hz
    const woke: number[] = []
    const frameCount = Math.round(ms / period)
    for (let i = 0; i < frameCount; i++) {
      const end = now + period
      act(() => {
        runTimers(end)
        now = end
        const due = [...frames.values()]
        frames.clear()
        if (due.length > 0) woke.push(now)
        for (const callback of due) callback(now)
      })
    }
    return woke
  }
  const lose = () => act(() => lost.forEach((listener) => listener()))
  const restore = () => act(() => restored.forEach((listener) => listener()))
  const setRatio = (next: number) => {
    ratio = next
    act(() => ratioListeners.forEach((listener) => listener()))
  }
  const setFocus = (next: boolean) => {
    focused = next
    act(() => focusListeners.forEach((listener) => listener()))
  }
  return {
    env, gpu, draws, buffer, log, tick, display, lose, restore, setRatio, setFocus,
    now: () => now,
    pending: () => frames.size,
    timers: () => timers.size
  }
}

/** Lets promise callbacks run (saved pictures' decodes, a Worker's replies). */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

/** Saved still frames, as the phone keeps them, in memory: each saved canvas decodes to a picture of its size. */
function fakeSaved() {
  const saved = new Map<string, { width: number; height: number }>()
  const store: FaceFrameStore = {
    settled: () => true,
    onSettled(listener) {
      listener()
      return () => undefined
    },
    has: (key) => saved.has(key),
    take: () => null,
    image: async (key) => (saved.has(key) ? ({ ...saved.get(key)! } as unknown as SavedFrameImage) : null),
    save: vi.fn((key: string, canvas: HTMLCanvasElement) => {
      if (!saved.has(key)) saved.set(key, { width: canvas.width, height: canvas.height })
    }),
    forget: (key) => {
      saved.delete(key)
    }
  }
  return { saved, store }
}

/** What was last drawn into a face's canvas. */
function lastDrawn(canvas: HTMLCanvasElement) {
  return vi.mocked(fake2d(canvas).drawImage).mock.calls.at(-1)?.[0]
}

/** A local storage in memory. */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value))
  }
}

const coral = { colour: 'coral', accessory: 'none' } as const
const spec = (overrides: Partial<Parameters<FaceRenderer['register']>[1]> = {}) => ({
  look: { colour: 'teal', accessory: 'crown' } as const,
  state: 'idle' as const,
  size: 40,
  view: 'head' as const,
  still: false,
  ...overrides
})

describe('BotFace fallback', () => {
  it('shows the still face when there is no WebGL, without throwing', () => {
    render(createElement(BotFace, { look: { colour: 'blue', accessory: 'glasses' }, state: 'working', size: 40, view: 'head', label: 'Inbox helper' }))
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
    const svg = host.querySelector('.bot-face')!
    expect(svg.getAttribute('data-colour')).toBe('blue')
    expect(svg.getAttribute('data-accessory')).toBe('glasses')
    expect(svg.getAttribute('aria-label')).toBe('Inbox helper')
    expect(sharedFaceRendererStatus()).toBe('unavailable')
  })

  it('shows the still face when context creation throws', () => {
    webgl = 'throws'
    render(createElement(BotFace, { look: coral, state: 'idle', size: 34, view: 'head' }))
    expect(host.querySelector('svg.bot-face-still')?.getAttribute('aria-hidden')).toBe('true')
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('shows the still face when the shader fails to compile', () => {
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const fake = fakeEnv({ status: () => status })
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    expect(host.querySelector('canvas.bot-face-canvas')).not.toBeNull()
    status = 'failed'
    fake.tick()
    expect(host.querySelector('canvas')).toBeNull()
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
  })

  it('is not ready while the context is lost, and shows the still face when it does not come back', () => {
    let status: ReturnType<FaceGpu['status']> = 'ready'
    const fake = fakeEnv({ status: () => status })
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head', still: true }))
    fake.tick()
    expect(sharedFaceRendererStatus()).toBe('ready')
    status = 'lost'
    fake.lose()
    expect(sharedFaceRendererStatus()).toBe('pending')
    expect(host.querySelector('canvas.bot-face-canvas')).not.toBeNull()
    fake.tick(LOST_CONTEXT_TIMEOUT_MS)
    expect(sharedFaceRendererStatus()).toBe('failed')
    expect(host.querySelector('canvas')).toBeNull()
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
  })

  it('draws again when a lost context comes back in time', () => {
    let status: ReturnType<FaceGpu['status']> = 'ready'
    const fake = fakeEnv({ status: () => status })
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec())
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    status = 'lost'
    fake.lose()
    expect(renderer.status()).toBe('pending')
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    status = 'ready'
    fake.restore()
    fake.tick(LOST_CONTEXT_TIMEOUT_MS)
    expect(renderer.status()).toBe('ready')
    expect(fake.draws).toHaveLength(2)
    // The wait for a lost context is gone; the one timer left asks for the next tick.
    expect(fake.timers()).toBe(1)
    expect(fake.pending()).toBe(0)
    renderer.dispose()
  })

  it('shows the still face when WebGL is refused as software', () => {
    webgl = 'software'
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    expect(sharedFaceRendererStatus()).toBe('unavailable')
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('keeps the loader moving while the shader compiles within the deadline, and goes live within READY_POLL_MS of it being ready', () => {
    let status: ReturnType<FaceGpu['status']> = 'pending'
    // Off screen as far as the observer knows, so no tick runs to look at the compile.
    const fake = fakeEnv({ observer: true, status: () => status })
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    expect(sharedFaceRendererStatus()).toBe('pending')
    // A slow compile within the startup deadline keeps the loader.
    fake.tick(8_000)
    expect(sharedFaceRendererStatus()).toBe('pending')
    expect(host.querySelector('canvas.bot-face-canvas')).not.toBeNull()
    expect(host.querySelector('.bot-face-placeholder[data-loading]')).not.toBeNull()
    status = 'ready'
    fake.tick(READY_POLL_MS)
    expect(sharedFaceRendererStatus()).toBe('ready')
    expect(faceRendererStats()?.compileMs).toBe(8_000 + READY_POLL_MS)
    FakeObserver.last!.fire(true)
    fake.tick()
    expect(host.querySelector('.bot-face[data-drawn]')).not.toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
  })

  it('shows the still face when a compile in progress then fails', () => {
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const fake = fakeEnv({ status: () => status })
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    fake.tick(5_000)
    expect(host.querySelector('.bot-face-placeholder[data-loading]')).not.toBeNull()
    status = 'failed'
    fake.tick(READY_POLL_MS)
    expect(sharedFaceRendererStatus()).toBe('failed')
    expect(host.querySelector('canvas')).toBeNull()
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
  })

  it('shows the still face when the first frame reads back empty', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    const readBack = vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }))
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(function (this: HTMLCanvasElement, kind: string) {
      if (kind !== '2d') return null
      const ctx = fake2d(this) as unknown as Record<string, unknown>
      ctx.getImageData = readBack
      return ctx as unknown as CanvasRenderingContext2D
    } as typeof HTMLCanvasElement.prototype.getContext)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    expect(readBack).toHaveBeenCalledTimes(1)
    expect(sharedFaceRendererStatus()).toBe('failed')
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
  })

  it('reads back only the first frame, and keeps a face that has pixels', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    const readBack = vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }))
    ;(fake2d(canvas) as unknown as Record<string, unknown>).getImageData = readBack
    renderer.register(canvas, spec({ state: 'working' }))
    fake.tick()
    fake.tick()
    expect(fake.draws.length).toBeGreaterThan(1)
    expect(readBack).toHaveBeenCalledTimes(1)
    expect(renderer.status()).toBe('ready')
    renderer.dispose()
  })

  it('shows the still face when a canvas has no 2D context', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
  })
})

describe('releasing the WebGL context while no face shows', () => {
  const face = () => createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' })

  it('lets the context go once no face has shown for the idle time', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    render(null)
    fake.tick(IDLE_RELEASE_MS - 1)
    expect(fake.gpu.dispose).not.toHaveBeenCalled()
    expect(faceRendererStats()).not.toBeNull()
    fake.tick(1)
    expect(fake.gpu.dispose).toHaveBeenCalledTimes(1)
    expect(faceRendererStats()).toBeNull()
    expect(fake.timers()).toBe(0)
    expect(fake.pending()).toBe(0)
  })

  it('keeps the context while a face shows, and when one comes back within the idle time', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    fake.tick(IDLE_RELEASE_MS * 2)
    render(null)
    fake.tick(IDLE_RELEASE_MS - 1)
    render(face())
    fake.tick(IDLE_RELEASE_MS * 2)
    expect(fake.gpu.dispose).not.toHaveBeenCalled()
    expect(host.querySelector('canvas.bot-face-canvas')).not.toBeNull()
  })

  it('makes a new context for the next face, which shows its loader while the shader compiles again, then draws live', () => {
    let status: ReturnType<FaceGpu['status']> = 'ready'
    const fake = fakeEnv({ status: () => status })
    const createGpu = vi.spyOn(fake.env, 'createGpu')
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    fake.tick()
    render(null)
    fake.tick(IDLE_RELEASE_MS)
    expect(fake.gpu.dispose).toHaveBeenCalledTimes(1)

    status = 'pending'
    render(face())
    expect(createGpu).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.bot-face-placeholder[data-loading]')).not.toBeNull()
    fake.tick(READY_POLL_MS * 3)
    expect(host.querySelector('.bot-face-placeholder[data-loading]')).not.toBeNull()

    status = 'ready'
    fake.tick(READY_POLL_MS)
    expect(sharedFaceRendererStatus()).toBe('ready')
    const drawn = fake.draws.length
    fake.tick()
    expect(fake.draws.length).toBeGreaterThan(drawn)
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
    expect(host.querySelector('.bot-face[data-drawn]')).not.toBeNull()
  })

  it('shows the still face when the new context fails to compile', () => {
    let status: ReturnType<FaceGpu['status']> = 'ready'
    const fake = fakeEnv({ status: () => status })
    resetSharedFaceRenderer(() => fake.env)
    render(face())
    fake.tick()
    render(null)
    fake.tick(IDLE_RELEASE_MS)
    status = 'failed'
    render(face())
    // Found failed at its first check, as it is made: no 3D faces until the next launch.
    expect(sharedFaceRendererStatus()).toBe('unavailable')
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
  })

  it('has nothing to release without WebGL', () => {
    render(face())
    render(null)
    expect(sharedFaceRendererStatus()).toBe('unavailable')
  })
})

describe('BotFace props', () => {
  it('reads unknown looks, states, sizes and views as the defaults', () => {
    expect(normalizeFaceProps({ look: { colour: 'mauve', accessory: 'monocle' }, state: 'dancing' as never, size: Number.NaN, view: 'side' as never })).toEqual({
      look: { colour: 'coral', accessory: 'none' },
      state: 'idle',
      size: 40,
      view: 'head'
    })
    expect(normalizeFaceProps({ look: { colour: 'pink', accessory: 'hood' }, state: 'happy', size: 103.6, view: 'full' })).toEqual({
      look: { colour: 'pink', accessory: 'hood' },
      state: 'happy',
      size: 104,
      view: 'full'
    })
    expect(normalizeFaceProps({ look: coral, state: 'idle', size: 4000, view: 'head' }).size).toBe(256)
    expect(normalizeFaceProps({ look: coral, state: 'idle', size: -3, view: 'head' }).size).toBe(40)
  })

  it('draws a Mousse in the fallback and passes its kind and eyes to the shader', () => {
    render(createElement(BotFace, { look: { colour: 'purple', accessory: 'none', kind: 'mousse', eyes: 'star' }, state: 'idle', size: 48, view: 'head' }))
    expect(host.querySelector('.bot-face')!.getAttribute('data-kind')).toBe('mousse')
    expect(faceUniforms({ colour: 'purple', accessory: 'none', kind: 'mousse', eyes: 'star' }, stillPose('idle'), { view: 'head', size: 40, samples: 1 }).uK).toEqual([1, 6, 1])
    expect(faceUniforms({ colour: 'purple', accessory: 'none' }, stillPose('idle'), { view: 'head', size: 40, samples: 1 }).uK).toEqual([0, 0, 1])
    expect(faceUniforms({ colour: 'yellow', accessory: 'none', kind: 'mousse' }, stillPose('idle'), { view: 'head', size: 40, samples: 1 }).uK).toEqual([1, 0, 0])
  })

  it('keeps unknown stored values drawable in the fallback', () => {
    render(createElement(BotFace, { look: { colour: 'mauve', accessory: 'monocle' }, state: 'dancing' as never, size: 48, view: 'head' }))
    const svg = host.querySelector('.bot-face')!
    expect(svg.getAttribute('data-colour')).toBe('coral')
    expect(svg.getAttribute('data-accessory')).toBe('none')
    expect(svg.getAttribute('data-state')).toBe('idle')
  })

  it('sizes the live face, shows the z when paused and is decorative without a label', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: { colour: 'green', accessory: 'cap' }, state: 'paused', size: 48, view: 'head' }))
    const face = host.querySelector<HTMLElement>('.bot-face')!
    expect(face.style.width).toBe('48px')
    expect(face.getAttribute('aria-hidden')).toBe('true')
    expect(face.getAttribute('data-still')).toBeNull()
    expect(host.querySelector('.bot-face-z')?.textContent).toBe('z')
    expect(host.querySelector('canvas')!.width).toBe(48)
  })
})

describe('reduced motion', () => {
  it('draws each pose once, still, and stops the loop', () => {
    reducedMotion = true
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    const look = { colour: 'yellow', accessory: 'beret' }
    render(createElement('div', null,
      createElement(BotFace, { look, state: 'stuck', size: 40, view: 'head' }),
      createElement(BotFace, { look, state: 'stuck', size: 40, view: 'head' }),
      createElement(BotFace, { look, state: 'happy', size: 40, view: 'head' })
    ))
    expect(host.querySelectorAll('.bot-face[data-still="true"]')).toHaveLength(2 + 1)
    for (let i = 0; i < 5; i++) fake.tick()
    // The two alike faces share one cached frame (past the budget the third first shows a one-sample draft).
    expect(fake.draws.filter((draw) => draw.uniforms.uV[2] === 2)).toHaveLength(2)
    expect(fake.draws[0]!.uniforms).toEqual(faceUniforms({ colour: 'yellow', accessory: 'beret' }, stillPose('stuck'), { view: 'head', size: 40, samples: 2 }))
    expect(fake.pending()).toBe(0)
  })

  it('draws a still face again at a new pixel ratio', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ size: 104, view: 'full', still: true }))
    fake.tick()
    expect(fake.draws.map((draw) => draw.side)).toEqual([104])
    expect(renderer.running).toBe(false)
    fake.setRatio(2)
    expect(canvas.width).toBe(208)
    fake.tick()
    expect(fake.draws.map((draw) => draw.side)).toEqual([104, 208])
    // Past the cap of 2 nothing changes, so nothing is drawn.
    fake.setRatio(3)
    fake.tick()
    expect(fake.draws).toHaveLength(2)
    renderer.dispose()
  })

  it('draws a still face again when its state changes', () => {
    const fake = fakeEnv()
    resetSharedFaceRenderer(() => fake.env)
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head', still: true }))
    fake.tick()
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    render(createElement(BotFace, { look: coral, state: 'needs_you', size: 40, view: 'head', still: true }))
    fake.tick()
    expect(fake.draws).toHaveLength(2)
    expect(fake.draws[1]!.uniforms.uE2[2]).toBe(1.2)
    expect(fake.pending()).toBe(0)
  })
})

describe('the shared renderer', () => {
  it('animates only faces on screen, and stops when none are', () => {
    const fake = fakeEnv({ observer: true })
    const renderer = new FaceRenderer(fake.env)
    const a = document.createElement('canvas')
    const b = document.createElement('canvas')
    renderer.register(a, spec())
    renderer.register(b, spec({ state: 'working' }))
    // Nothing is known to be on screen yet.
    expect(renderer.running).toBe(false)
    FakeObserver.last!.fire(true, a)
    expect(renderer.running).toBe(true)
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    for (let i = 0; i < 10; i++) fake.tick()
    expect(fake.draws.length).toBeGreaterThan(5)
    FakeObserver.last!.fire(false, a)
    const drawn = fake.draws.length
    fake.tick()
    expect(fake.draws).toHaveLength(drawn)
    expect(renderer.running).toBe(false)
    renderer.dispose()
  })

  it('stops while the document is hidden and resumes when shown', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec({ state: 'happy' }))
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    setVisibility('hidden')
    fake.tick()
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    expect(renderer.running).toBe(false)
    setVisibility('visible')
    expect(renderer.running).toBe(true)
    fake.tick()
    expect(fake.draws).toHaveLength(2)
    renderer.dispose()
  })

  it('stops when the last face goes away', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const handle = renderer.register(document.createElement('canvas'), spec())!
    expect(renderer.running).toBe(true)
    handle.dispose()
    expect(renderer.running).toBe(false)
    expect(fake.pending()).toBe(0)
    renderer.dispose()
  })

  it('waits while the shader compiles', () => {
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const fake = fakeEnv({ status: () => status })
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec())
    fake.tick()
    expect(fake.draws).toHaveLength(0)
    expect(renderer.status()).toBe('pending')
    status = 'ready'
    fake.tick()
    expect(fake.draws).toHaveLength(1)
    expect(renderer.status()).toBe('ready')
    renderer.dispose()
  })

  it('settles an idle face into its still pose a few seconds after its state changed, and moves it on a new state', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const handle = renderer.register(document.createElement('canvas'), spec())!
    const ticks = Math.ceil((IDLE_LIVE_SECONDS * 1000) / 50) + 1
    for (let i = 0; i < ticks; i++) fake.tick(50)
    // Stopped completely: no frame asked for and no timer to ask for one.
    expect(renderer.running).toBe(false)
    expect(fake.pending()).toBe(0)
    expect(fake.timers()).toBe(0)
    expect(fake.draws.at(-1)!.uniforms).toEqual(faceUniforms(spec().look, stillPose('idle'), { view: 'head', size: 40, samples: 2 }))
    const drawn = fake.draws.length
    fake.tick(1000)
    expect(fake.draws).toHaveLength(drawn)
    handle.update(spec({ state: 'working' }))
    expect(renderer.running).toBe(true)
    for (let i = 0; i < 5; i++) fake.tick(50)
    expect(fake.draws.length).toBeGreaterThan(drawn + 3)
    renderer.dispose()
  })

  it('settles a busy face while the window has no focus, and moves it again with focus', () => {
    const fake = fakeEnv({ focus: true })
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec({ state: 'working' }))
    fake.tick()
    fake.setFocus(false)
    const ticks = Math.ceil((UNFOCUSED_LIVE_SECONDS * 1000) / 50) + 1
    for (let i = 0; i < ticks; i++) fake.tick(50)
    expect(renderer.running).toBe(false)
    expect(fake.pending()).toBe(0)
    expect(fake.timers()).toBe(0)
    expect(fake.draws.at(-1)!.uniforms).toEqual(faceUniforms(spec().look, stillPose('working'), { view: 'head', size: 40, samples: 2 }))
    const drawn = fake.draws.length
    fake.setFocus(true)
    expect(renderer.running).toBe(true)
    for (let i = 0; i < 5; i++) fake.tick(50)
    expect(fake.draws.length).toBeGreaterThan(drawn + 3)
    renderer.dispose()
  })

  it('draws every blank face on its first tick, then keeps each tick within the sample budget', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvases = Array.from({ length: 20 }, () => document.createElement('canvas'))
    const drawnTo = new Set<HTMLCanvasElement>()
    for (const canvas of canvases) {
      renderer.register(canvas, spec({ state: 'working' }))
      vi.mocked(canvas.getContext('2d')!.drawImage).mockImplementation(() => drawnTo.add(canvas))
    }
    const side = faceDrawSide(40, 1)
    expect(side).toBe(80)
    const perTick = Math.floor(SAMPLE_BUDGET / (side * side))
    expect(perTick).toBeLessThan(20)
    fake.tick()
    expect(drawnTo.size).toBe(20)
    const counts: number[] = []
    for (let i = 0; i < 4; i++) {
      const before = fake.draws.length
      fake.tick()
      counts.push(fake.draws.length - before)
    }
    expect(Math.max(...counts)).toBe(perTick)
    for (const draw of fake.draws) expect(draw.side).toBe(80)
    renderer.dispose()
  })

  it('draws still faces with 2×2 samples, counted four times; past the budget a blank one gets a one-sample draft, drawn clean later', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const looks = ['coral', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
    for (const colour of looks) renderer.register(document.createElement('canvas'), spec({ look: { colour, accessory: 'none' }, still: true }))
    const perTick = Math.max(1, Math.floor(SAMPLE_BUDGET / (80 * 80 * 4)))
    const clean = () => fake.draws.filter((draw) => draw.uniforms.uV[2] === 2)
    fake.tick()
    // All eight show at once: the first within the budget clean, the rest as drafts.
    expect(fake.draws).toHaveLength(looks.length)
    expect(clean()).toHaveLength(perTick)
    while (clean().length < looks.length) fake.tick()
    expect(new Set(clean().map((draw) => draw.uniforms.uCol.join()))).toHaveProperty('size', looks.length)
    // Then nothing more: each clean frame is drawn once.
    const drawn = fake.draws.length
    fake.tick()
    expect(fake.draws).toHaveLength(drawn)
    renderer.dispose()
  })

  it('draws live faces with one sample', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec({ state: 'working' }))
    fake.tick()
    expect(fake.draws[0]!.uniforms.uV[2]).toBe(1)
    renderer.dispose()
  })

  it('draws small faces at 2x and large ones at the pixel ratio, capped at 2', () => {
    expect(faceDrawSide(40, 1)).toBe(80)
    expect(faceDrawSide(48, 3)).toBe(96)
    expect(faceDrawSide(104, 1)).toBe(104)
    expect(faceDrawSide(104, 1.5)).toBe(156)
    const fake = fakeEnv({ pixelRatio: 3 })
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ size: 104, view: 'full' }))
    expect(canvas.width).toBe(208)
    fake.tick()
    expect(fake.draws[0]!.side).toBe(208)
    // Whiskers show from 56 px up.
    expect(fake.draws[0]!.uniforms.uV[3]).toBe(0)
    renderer.dispose()
  })
})

describe('shared ticks', () => {
  const colours = ['coral', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
  const face = (i: number, state: BotFaceState) => spec({ look: { colour: colours[i]!, accessory: 'none' }, state })
  const colourOf = (i: number) => faceUniforms({ colour: colours[i]!, accessory: 'none' }, stillPose('idle'), { view: 'head', size: 40, samples: 1 }).uCol.join()
  /** The frame times face `i` was drawn at, from draw `from` on. */
  const drawnAt = (fake: ReturnType<typeof fakeEnv>, i: number, from = 0) =>
    fake.draws.slice(from).filter((draw) => draw.uniforms.uCol.join() === colourOf(i)).map((draw) => draw.at)
  const gaps = (times: number[]) => times.slice(1).map((at, i) => Math.round(at - times[i]!))

  it('draws faces registered at different times on the same ticks, and every face due on a tick', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), face(0, 'working'))
    fake.display(37, 100)
    renderer.register(document.createElement('canvas'), face(1, 'working'))
    fake.display(53, 100)
    renderer.register(document.createElement('canvas'), face(2, 'idle'))
    fake.display(21, 100)
    renderer.register(document.createElement('canvas'), face(3, 'paused'))
    fake.display(100, 100)
    const from = fake.draws.length
    fake.display(1000, 100)
    const busy = drawnAt(fake, 0, from)
    expect(drawnAt(fake, 1, from)).toEqual(busy)
    expect(drawnAt(fake, 3, from)).toEqual(drawnAt(fake, 2, from))
    for (const at of drawnAt(fake, 2, from)) expect(busy).toContain(at)
    // No frame of its own between ticks: every frame that drew is a busy tick, 30 or 40 ms apart on a 100 Hz display.
    expect(new Set(fake.draws.slice(from).map((draw) => draw.at))).toEqual(new Set(busy))
    expect(new Set(gaps(busy))).toEqual(new Set([30, 40]))
    renderer.dispose()
  })

  it('moves the busy states 30 times a second, idle and paused 15', () => {
    const states: BotFaceState[] = ['working', 'needs_you', 'stuck', 'happy', 'idle', 'paused']
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    states.forEach((state, i) => {
      renderer.register(document.createElement('canvas'), face(i, state))
      fake.display(13, 100)
    })
    const from = fake.draws.length
    fake.display(3000, 100)
    // Within the seconds an idle or paused face moves before it settles (`IDLE_LIVE_SECONDS`).
    expect(states.map((_, i) => drawnAt(fake, i, from).length)).toEqual([90, 90, 90, 90, 45, 45])
    renderer.dispose()
  })

  it('sleeps between ticks: no frame is asked for while nothing is due, and a timer asks for the next tick', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), face(0, 'working'))
    renderer.register(document.createElement('canvas'), face(1, 'idle'))
    fake.display(100, 100)
    const from = fake.draws.length
    const woke: number[] = []
    for (let i = 0; i < 100; i++) {
      const drawn = fake.draws.length
      woke.push(...fake.display(10, 100))
      if (fake.draws.length === drawn) continue
      // Right after a drawing tick: asleep until the next.
      expect(fake.pending()).toBe(0)
      expect(fake.timers()).toBe(1)
      expect(renderer.running).toBe(true)
    }
    const ticks = [...new Set(fake.draws.slice(from).map((draw) => draw.at))]
    expect(ticks).toHaveLength(30)
    // A frame that draws nothing is asked for at most one display frame before a tick, never every frame.
    for (const at of woke) expect(ticks.includes(at) || ticks.includes(at + 10)).toBe(true)
    expect(woke.length).toBeLessThanOrEqual(40)
    renderer.dispose()
  })

  it('asks for a frame at once for a face that is new on screen, changed or resized', () => {
    const fake = fakeEnv({ observer: true })
    const renderer = new FaceRenderer(fake.env)
    const a = document.createElement('canvas')
    const handle = renderer.register(a, face(0, 'working'))!
    FakeObserver.last!.fire(true, a)
    // Asleep, and far enough from the last tick that the next may draw (ticks are `MIN_TICK` apart).
    const asleep = () => {
      const ready = () => fake.pending() === 0 && fake.timers() === 1 && fake.now() - fake.draws.at(-1)!.at >= 20
      for (let i = 0; i < 10 && !ready(); i++) fake.display(10, 100)
      expect(ready()).toBe(true)
    }
    const drawsNextFrame = (i: number) => {
      expect(fake.pending()).toBe(1)
      expect(fake.timers()).toBe(0)
      const before = drawnAt(fake, i).length
      fake.display(10, 100)
      expect(drawnAt(fake, i)).toHaveLength(before + 1)
      expect(drawnAt(fake, i).at(-1)).toBe(fake.now())
    }
    asleep()
    const b = document.createElement('canvas')
    renderer.register(b, face(1, 'working'))
    // Not known to be on screen yet.
    expect(fake.pending()).toBe(0)
    FakeObserver.last!.fire(true, b)
    drawsNextFrame(1)
    asleep()
    handle.update(face(0, 'happy'))
    drawsNextFrame(0)
    asleep()
    handle.update({ ...face(0, 'happy'), size: 48 })
    drawsNextFrame(0)
    renderer.dispose()
  })

  it('defers faces past the sample budget to the next shared tick, most overdue first, never to a frame of their own', () => {
    const fake = fakeEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvases = Array.from({ length: 20 }, () => document.createElement('canvas'))
    const drawnIn = new Map<number, Set<HTMLCanvasElement>>()
    for (const canvas of canvases) {
      renderer.register(canvas, face(0, 'working'))
      vi.mocked(canvas.getContext('2d')!.drawImage).mockImplementation(() => {
        const set = drawnIn.get(fake.now()) ?? new Set()
        drawnIn.set(fake.now(), set.add(canvas))
      })
    }
    const perTick = Math.floor(SAMPLE_BUDGET / (faceDrawSide(40, 1) ** 2))
    fake.display(1000, 100)
    const ticks = [...drawnIn.keys()]
    // The first frame draws every blank face at once; then each tick its budget, on the shared ticks only.
    expect(drawnIn.get(ticks[0]!)!.size).toBe(20)
    expect(new Set(gaps(ticks.slice(1)))).toEqual(new Set([30, 40]))
    const later = ticks.slice(1).map((at) => drawnIn.get(at)!)
    for (const set of later) expect(set.size).toBe(perTick)
    // Those the budget deferred draw on the next tick: no face draws on two ticks running.
    for (let i = 1; i < later.length; i++) for (const canvas of later[i]!) expect(later[i - 1]!.has(canvas)).toBe(false)
    for (let i = 2; i < later.length; i++) expect(new Set([...later[i - 2]!, ...later[i - 1]!, ...later[i]!]).size).toBe(Math.min(20, perTick * 3))
    renderer.dispose()
  })

  it('draws on the same display frames as asking for a frame every display frame, at 60 and 100 Hz, with timers early or late within WAKE_LEAD_MS', () => {
    const late = [-0.9, 0, WAKE_LEAD_MS - 0.1, 0.7, -0.4, 1.5]
    for (const hz of [60, 100]) {
      for (let offset = 0; offset < 1000 / hz; offset += 0.5) {
        const run = (options: Parameters<typeof fakeEnv>[0]) => {
          const fake = fakeEnv({ start: 1000 + offset, ...options })
          const renderer = new FaceRenderer(fake.env)
          renderer.register(document.createElement('canvas'), face(0, 'working'))
          fake.display(17, hz)
          renderer.register(document.createElement('canvas'), face(1, 'idle'))
          fake.display(1000, hz)
          renderer.dispose()
          return fake.draws.map((draw) => `${draw.at} ${draw.uniforms.uCol.join()}`)
        }
        let n = 0
        const asleep = run({ timerLate: () => late[n++ % late.length]! })
        const everyFrame = run({ noTimers: true })
        expect(asleep, `${hz} Hz, offset ${offset} ms`).toEqual(everyFrame)
      }
    }
  })

  it('asks for a frame every display frame without timers', () => {
    const fake = fakeEnv({ noTimers: true })
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), face(0, 'working'))
    expect(fake.display(500, 100)).toHaveLength(50)
    expect(new Set(fake.draws.map((draw) => draw.at)).size).toBe(16)
    renderer.dispose()
  })
})

describe('software WebGL', () => {
  const gl = (renderer: string | null) => ({
    getExtension: (name: string) => (name === 'WEBGL_debug_renderer_info' && renderer !== null ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
    getParameter: () => renderer
  }) as unknown as WebGLRenderingContext
  it('fails a context that comes back from a loss in software', () => {
    let renderer = 'ANGLE (Intel, Mesa Intel(R) Graphics, OpenGL 4.6)'
    const listeners = new Map<string, (event: Event) => void>()
    const context = new Proxy({} as Record<string | symbol, unknown>, {
      get: (target, key) => {
        if (key === 'getExtension') return (name: string) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null)
        if (key === 'getParameter') return (name: number) => (name === 0x9246 ? renderer : true)
        if (key === 'getProgramParameter') return () => true
        if (key === 'isContextLost') return () => false
        if (typeof key === 'string' && /^[A-Z_]+$/.test(key)) return 1
        return (target[key] ??= vi.fn(() => ({})))
      }
    })
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => context,
      addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener)
    }
    const gpu = createWebGlGpu({ createElement: () => canvas } as unknown as Document)!
    expect(gpu.status()).toBe('ready')
    listeners.get('webglcontextlost')!({ preventDefault() {} } as Event)
    expect(gpu.status()).toBe('lost')
    renderer = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'
    listeners.get('webglcontextrestored')!(new Event('webglcontextrestored'))
    expect(gpu.status()).toBe('failed')
  })

  it('counts as no WebGL, so faces stay still instead of burning the CPU', () => {
    expect(softwareWebGl(gl('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'))).toBe(true)
    expect(softwareWebGl(gl('llvmpipe (LLVM 17.0.6, 256 bits)'))).toBe(true)
    expect(softwareWebGl(gl('ANGLE (Intel, Mesa Intel(R) Graphics, OpenGL 4.6)'))).toBe(false)
    expect(softwareWebGl(gl(null))).toBe(false)
  })
})

describe('face poses', () => {
  it('settles each state in its pose', () => {
    expect(stillPose('paused')).toMatchObject({ closed: 1, arc: -1 })
    expect(stillPose('happy')).toMatchObject({ closed: 1, arc: 1, armL: 1.9, armR: 1.9 })
    expect(stillPose('working')).toMatchObject({ laptop: 1, open: 0.8 })
    expect(stillPose('needs_you')).toMatchObject({ es: 1.2, armR: 2.5 })
    expect(stillPose('stuck')).toMatchObject({ worried: 0.85, sweat: 1 })
    expect(stillPose('idle')).toMatchObject({ lookX: 0, closed: 0, open: 1 })
    expect(stillPose('stuck')).toEqual(stillPose('stuck'))
  })

  it('eases towards a new state instead of jumping', () => {
    const motion = new FaceMotion('idle', () => 0.5, 0)
    motion.frame(0, 1 / 30)
    motion.set('working', 0.04)
    const pose = motion.frame(1 / 15, 1 / 30)
    expect(pose.laptop).toBeGreaterThan(0)
    expect(pose.laptop).toBeLessThan(1)
  })

  it('hops when it needs you', () => {
    expect(hop(-0.1)).toEqual([0, 1])
    expect(hop(0.59)[0]).toBeCloseTo(1, 1)
    const motion = new FaceMotion('needs_you', () => 0.5, 0)
    motion.frame(0, 0)
    const heights = Array.from({ length: 40 }, (_, i) => motion.frame(i / 30, 1 / 30).hop)
    expect(Math.max(...heights)).toBeGreaterThan(0.25)
  })
})

describe('saved face pictures', () => {
  it('shows a face drawn on an earlier visit at once, and the still face for a pose with no picture', () => {
    const look = normalizeFaceProps({ look: coral, state: 'idle', size: 40, view: 'head' }).look
    const key = stillFrameKey({ look, state: 'idle', view: 'head', size: 40 }, 40 * Math.min(2, window.devicePixelRatio || 1))
    const canvas = document.createElement('canvas')
    const picture = `data:image/webp;base64,${'A'.repeat(400)}`
    canvas.toDataURL = () => picture
    saveFaceShot(key, canvas)
    // No WebGL here: the saved picture stands in for the 3D face, with no loader.
    render(createElement(BotFace, { look: coral, state: 'idle', size: 40, view: 'head' }))
    expect(host.querySelector<HTMLImageElement>('img.bot-face-shot')?.src).toBe(picture)
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
    expect(host.querySelector('svg.bot-face-still')).toBeNull()
    // Another pose has no picture yet: the still face, not a loader.
    render(createElement(BotFace, { look: coral, state: 'working', size: 40, view: 'head' }))
    expect(host.querySelector('img.bot-face-shot')).toBeNull()
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
    resetFaceShots()
  })
})

describe('saved still frames', () => {
  it('saves each still frame drawn under its spec, and copies it in on a later run instead of drawing it again', async () => {
    const { saved, store } = fakeSaved()
    const first = fakeEnv({ saved: store })
    const renderer = new FaceRenderer(first.env)
    renderer.register(document.createElement('canvas'), spec({ look: coral, still: true }))
    first.tick()
    expect(first.draws).toHaveLength(1)
    expect([...saved.keys()]).toEqual([stillFrameKey({ look: coral, state: 'idle', view: 'head', size: 40 }, 40)])
    renderer.dispose()

    const next = fakeEnv({ saved: store })
    const again = new FaceRenderer(next.env)
    const canvas = document.createElement('canvas')
    const drawn = vi.fn()
    again.register(canvas, spec({ look: coral, still: true }), { onDrawn: drawn })
    next.tick()
    await settle()
    next.tick()
    expect(next.draws).toHaveLength(0)
    expect(lastDrawn(canvas)).toMatchObject({ width: 40, height: 40 })
    expect(drawn).toHaveBeenCalledTimes(1)
    again.dispose()
  })

  it("saves a moving face's still pose once, without drawing it into the face", () => {
    const { saved, store } = fakeSaved()
    const fake = fakeEnv({ saved: store })
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ look: coral, state: 'working' }))
    for (let i = 0; i < 5; i++) fake.tick()
    const stillUniforms = faceUniforms(coral, stillPose('working'), { view: 'head', size: 40, samples: 2 })
    expect(fake.draws.filter((draw) => JSON.stringify(draw.uniforms) === JSON.stringify(stillUniforms))).toHaveLength(1)
    expect(saved.has(stillFrameKey({ look: coral, state: 'working', view: 'head', size: 40 }, 40))).toBe(true)
    const sources = vi.mocked(fake2d(canvas).drawImage).mock.calls.map((call) => call[0])
    expect(sources).toHaveLength(5)
    expect(sources.every((source) => source === (fake.gpu as { canvas: unknown }).canvas)).toBe(true)
    renderer.dispose()
  })

  it('keys saved pictures by the art version, so a changed shader never shows an old picture', () => {
    const key = stillFrameKey({ look: coral, state: 'idle', view: 'head', size: 40 }, 40)
    vi.stubGlobal('localStorage', memoryStorage())
    resetFaceShots()
    const canvas = document.createElement('canvas')
    canvas.toDataURL = () => `data:image/webp;base64,${'A'.repeat(400)}`
    vi.useFakeTimers()
    saveFaceShot(key, canvas)
    vi.advanceTimersByTime(500)
    vi.useRealTimers()
    const stored = JSON.parse(localStorage.getItem('mousse.botFaceShots.v2')!) as { version: string; shots: [string, string][] }
    expect(stored.version).toBe(faceArtVersion())
    expect(stored.shots.map(([k]) => k)).toEqual([key])
    // Pictures drawn with another shader are dropped as the store loads.
    localStorage.setItem('mousse.botFaceShots.v2', JSON.stringify({ ...stored, version: 'older' }))
    resetFaceShots()
    expect(faceShot(key)).toBeUndefined()
  })
})

/** A GPU in a Worker whose frames come back only when the test says so. */
function fakeWorkerGpu(status: () => ReturnType<FaceGpu['status']> = () => 'ready') {
  const sent: { batches: FaceBatch[]; resolve: (pictures: CanvasImageSource[] | null) => void }[] = []
  const gpu: WorkerFaceGpu = {
    status,
    drawBatches: (batches) => new Promise((resolve) => sent.push({ batches, resolve })),
    onRestored: vi.fn(),
    onLost: vi.fn(),
    dispose: vi.fn()
  }
  /** Sends back the oldest frame message's pictures (null: it could not be drawn). */
  const answer = async (ok = true) => {
    const next = sent.shift()!
    const pictures = ok ? next.batches.map(() => ({ close: vi.fn() }) as unknown as CanvasImageSource) : null
    next.resolve(pictures)
    await settle()
    return pictures
  }
  return { gpu, sent, answer }
}

describe('drawing in a Worker', () => {
  function workerEnv(status?: () => ReturnType<FaceGpu['status']>) {
    const fake = fakeEnv()
    const worker = fakeWorkerGpu(status)
    fake.env.createGpu = () => worker.gpu
    return { fake, worker }
  }

  it('sends a tick’s faces to the Worker, copies the pictures in when they come back, and runs no other tick meanwhile', async () => {
    const { fake, worker } = workerEnv()
    const renderer = new FaceRenderer(fake.env)
    const a = document.createElement('canvas')
    const b = document.createElement('canvas')
    const drawn = vi.fn()
    renderer.register(a, spec({ state: 'working' }), { onDrawn: drawn })
    renderer.register(b, spec({ look: coral, state: 'working' }))
    fake.tick()
    expect(worker.sent).toHaveLength(1)
    expect(worker.sent[0]!.batches).toHaveLength(1)
    expect(worker.sent[0]!.batches[0]!.draws.map((draw) => [draw.x, draw.y, draw.side])).toEqual([[0, 0, 80], [80, 0, 80]])
    expect(drawn).not.toHaveBeenCalled()
    // Waiting for the Worker: no frame is asked for and nothing else is sent, however long it takes.
    for (let i = 0; i < 10; i++) fake.tick()
    expect(worker.sent).toHaveLength(1)
    expect(renderer.running).toBe(true)
    const pictures = await worker.answer()
    expect(lastDrawn(a)).toBe(pictures![0])
    expect(lastDrawn(b)).toBe(pictures![0])
    expect(vi.mocked(fake2d(a).drawImage).mock.calls.at(-1)!.slice(1)).toEqual([0, 0, 80, 80, 0, 0, 40, 40])
    expect(vi.mocked(fake2d(b).drawImage).mock.calls.at(-1)!.slice(1)).toEqual([80, 0, 80, 80, 0, 0, 40, 40])
    expect((pictures![0] as unknown as { close: () => void }).close).toHaveBeenCalled()
    expect(drawn).toHaveBeenCalledTimes(1)
    // The next tick goes out once the last is back.
    fake.tick()
    fake.tick()
    expect(worker.sent).toHaveLength(1)
    renderer.dispose()
  })

  it('leaves out a face that changed or went away while its frame was in the Worker, and draws the changed one again', async () => {
    const { fake, worker } = workerEnv()
    const renderer = new FaceRenderer(fake.env)
    const a = document.createElement('canvas')
    const b = document.createElement('canvas')
    const handle = renderer.register(a, spec({ state: 'working' }))!
    renderer.register(b, spec({ look: coral, state: 'working' }))!.dispose()
    fake.tick()
    expect(worker.sent[0]!.batches[0]!.draws).toHaveLength(1)
    handle.update(spec({ state: 'stuck' }))
    await worker.answer()
    expect(fake2d(a).drawImage).not.toHaveBeenCalled()
    fake.tick()
    expect(worker.sent).toHaveLength(1)
    const stuck = worker.sent[0]!.batches[0]!.draws[0]!.uniforms
    expect(stuck).not.toEqual(faceUniforms(spec().look, stillPose('working'), { view: 'head', size: 40, samples: 1 }))
    await worker.answer()
    expect(fake2d(a).drawImage).toHaveBeenCalledTimes(1)
    renderer.dispose()
  })

  it('draws again on a later tick when the Worker could not draw a frame', async () => {
    const { fake, worker } = workerEnv()
    const renderer = new FaceRenderer(fake.env)
    const a = document.createElement('canvas')
    renderer.register(a, spec({ still: true }))
    fake.tick()
    await worker.answer(false)
    expect(fake2d(a).drawImage).not.toHaveBeenCalled()
    fake.tick()
    expect(worker.sent).toHaveLength(1)
    await worker.answer()
    expect(fake2d(a).drawImage).toHaveBeenCalledTimes(1)
    renderer.dispose()
  })

  it('checks a compile in the Worker without waiting on it, and goes live when it says it is ready', () => {
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const { fake } = workerEnv(() => status)
    const renderer = new FaceRenderer(fake.env)
    renderer.register(document.createElement('canvas'), spec())
    fake.tick(10_000)
    expect(renderer.status()).toBe('pending')
    status = 'ready'
    fake.tick(READY_POLL_MS)
    expect(renderer.status()).toBe('ready')
    renderer.dispose()
  })

  it('recovers from an unanswered frame request after drawing a frame and stays live when the next reply arrives', async () => {
    const { fake, worker } = workerEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ state: 'working' }))
    fake.tick()
    await worker.answer()
    expect(fake2d(canvas).drawImage).toHaveBeenCalledTimes(1)
    // Next frame request goes unanswered past FRAME_TIMEOUT_MS: counts as a miss, does not fail.
    fake.tick()
    expect(worker.sent).toHaveLength(1)
    worker.sent.shift()
    fake.tick(FRAME_TIMEOUT_MS)
    expect(renderer.status()).toBe('ready')
    expect(worker.gpu.dispose).not.toHaveBeenCalled()
    // Rescheduled tick sends a fresh request; when it replies, the face draws and stays live.
    fake.tick()
    expect(worker.sent).toHaveLength(1)
    const fresh = await worker.answer()
    expect(lastDrawn(canvas)).toBe(fresh![0])
    expect(fake2d(canvas).drawImage).toHaveBeenCalledTimes(2)
    expect(renderer.status()).toBe('ready')
    expect(renderer.running).toBe(true)
    renderer.dispose()
  })

  it('drops a stale late reply after a timeout, closing its pictures without disturbing the newer request', async () => {
    const { fake, worker } = workerEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ state: 'working' }))
    fake.tick()
    await worker.answer()
    expect(fake2d(canvas).drawImage).toHaveBeenCalledTimes(1)
    // Second request times out and a third request is sent.
    fake.tick()
    const stale = worker.sent.shift()!
    fake.tick(FRAME_TIMEOUT_MS)
    fake.tick()
    expect(worker.sent).toHaveLength(1)
    // Late reply for the timed-out request arrives while the third is still in flight.
    const stalePicture = { close: vi.fn() } as unknown as CanvasImageSource
    stale.resolve([stalePicture])
    await settle()
    expect((stalePicture as unknown as { close: () => void }).close).toHaveBeenCalledTimes(1)
    expect(fake2d(canvas).drawImage).toHaveBeenCalledTimes(1)
    // Newer request is still in flight: ticking does not send a duplicate request.
    fake.tick()
    expect(worker.sent).toHaveLength(1)
    // Answering the newer request draws normally.
    const fresh = await worker.answer()
    expect(lastDrawn(canvas)).toBe(fresh![0])
    expect(fake2d(canvas).drawImage).toHaveBeenCalledTimes(2)
    expect(renderer.status()).toBe('ready')
    renderer.dispose()
  })

  it('fails after MAX_NULL_FRAMES consecutive unanswered requests once live', async () => {
    const { fake, worker } = workerEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ state: 'working' }))
    fake.tick()
    await worker.answer()
    for (let i = 0; i < MAX_NULL_FRAMES; i++) {
      fake.tick()
      expect(worker.sent).toHaveLength(i + 1)
      fake.tick(FRAME_TIMEOUT_MS)
      if (i < MAX_NULL_FRAMES - 1) {
        expect(renderer.status()).toBe('ready')
        expect(worker.gpu.dispose).not.toHaveBeenCalled()
      }
    }
    expect(renderer.status()).toBe('failed')
    expect(worker.gpu.dispose).toHaveBeenCalledTimes(1)
    renderer.dispose()
  })

  it('does not count frame or startup timeouts while the document is hidden', async () => {
    // Frame timer does not count misses while hidden, and re-arms on returning to visible.
    const { fake, worker } = workerEnv()
    const renderer = new FaceRenderer(fake.env)
    const canvas = document.createElement('canvas')
    renderer.register(canvas, spec({ state: 'working' }))
    fake.tick()
    await worker.answer()
    fake.tick()
    expect(worker.sent).toHaveLength(1)
    setVisibility('hidden')
    fake.tick(FRAME_TIMEOUT_MS * (MAX_NULL_FRAMES + 2))
    expect(renderer.status()).toBe('ready')
    expect(worker.gpu.dispose).not.toHaveBeenCalled()
    expect(worker.sent).toHaveLength(1)
    setVisibility('visible')
    fake.tick(FRAME_TIMEOUT_MS - 1)
    expect(worker.sent).toHaveLength(1)
    const pictures = await worker.answer()
    expect(lastDrawn(canvas)).toBe(pictures![0])
    expect(renderer.status()).toBe('ready')
    renderer.dispose()

    // Startup deadline does not expire while hidden, and restarts on becoming visible.
    let status: ReturnType<FaceGpu['status']> = 'pending'
    const startup = workerEnv(() => status)
    const pendingRenderer = new FaceRenderer(startup.fake.env)
    pendingRenderer.register(document.createElement('canvas'), spec())
    setVisibility('hidden')
    startup.fake.tick(STARTUP_TIMEOUT_MS * 2)
    expect(pendingRenderer.status()).toBe('pending')
    setVisibility('visible')
    startup.fake.tick(STARTUP_TIMEOUT_MS - READY_POLL_MS)
    expect(pendingRenderer.status()).toBe('pending')
    status = 'ready'
    startup.fake.tick(READY_POLL_MS)
    expect(pendingRenderer.status()).toBe('ready')
    pendingRenderer.dispose()
  })
})

/** A Worker that records what it is sent and answers as the test says. */
class FakeWorker {
  static last: FakeWorker | null = null
  readonly sent: FaceWorkerRequest[] = []
  onmessage: ((event: MessageEvent<FaceWorkerReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  constructor() {
    FakeWorker.last = this
  }
  postMessage(message: FaceWorkerRequest) {
    this.sent.push(message)
  }
  terminate() {
    this.terminated = true
  }
  reply(message: FaceWorkerReply) {
    this.onmessage?.({ data: message } as MessageEvent<FaceWorkerReply>)
  }
}

describe('the Worker GPU', () => {
  const make = () => createWorkerGpu(() => new FakeWorker() as unknown as Worker)!

  it('starts the Worker, is pending until it says the shader is ready, and records what Settings shows', () => {
    const gpu = make()
    const worker = FakeWorker.last!
    expect(worker.sent).toEqual([{ type: 'start' }])
    expect(gpu.status()).toBe('pending')
    worker.reply({ type: 'info', renderer: 'Adreno (TM) 642L', parallel: false, highp: true })
    expect(gpu.status()).toBe('pending')
    worker.reply({ type: 'ready', compileMs: 840 })
    expect(gpu.status()).toBe('ready')
    expect(faceDiagnostics()).toMatchObject({ path: 'worker', renderer: 'Adreno (TM) 642L', parallelCompile: false, highp: true, compileMs: 840, problem: null })
    gpu.dispose()
    expect(worker.terminated).toBe(true)
  })

  it('hands back each frame’s pictures, and null for frames it can’t draw or when it closes', async () => {
    const gpu = make()
    const worker = FakeWorker.last!
    worker.reply({ type: 'ready', compileMs: 10 })
    const batches: FaceBatch[] = [{ width: 80, height: 80, draws: [{ x: 0, y: 0, side: 80, uniforms: faceUniforms(coral, stillPose('idle'), { view: 'head', size: 40, samples: 1 }) }] }]
    const first = gpu.drawBatches(batches)
    const sent = worker.sent.at(-1) as Extract<FaceWorkerRequest, { type: 'frame' }>
    expect(sent).toMatchObject({ type: 'frame', batches })
    const picture = { close: vi.fn() } as unknown as ImageBitmap
    worker.reply({ type: 'frame', id: sent.id, pictures: [picture] })
    await expect(first).resolves.toEqual([picture])
    const second = gpu.drawBatches(batches)
    worker.reply({ type: 'lost' })
    expect(gpu.status()).toBe('lost')
    await expect(second).resolves.toBeNull()
    await expect(gpu.drawBatches(batches)).resolves.toBeNull()
    worker.reply({ type: 'restored' })
    expect(gpu.status()).toBe('pending')
    worker.reply({ type: 'ready', compileMs: 10 })
    const third = gpu.drawBatches(batches)
    gpu.dispose()
    await expect(third).resolves.toBeNull()
  })

  it('fails with the reason the Worker gives, or when the Worker stops', () => {
    const gpu = make()
    FakeWorker.last!.reply({ type: 'failed', problem: 'the face shader did not compile: ERROR: 0:12: too many uniforms' })
    expect(gpu.status()).toBe('failed')
    expect(faceDiagnostics().problem).toBe('the face shader did not compile: ERROR: 0:12: too many uniforms')
    const other = make()
    FakeWorker.last!.onerror?.({ message: 'Script error', preventDefault() {} } as ErrorEvent)
    expect(other.status()).toBe('failed')
    expect(faceDiagnostics().problem).toContain('stopped')
  })

  it('is null when the Worker can’t be made', () => {
    expect(createWorkerGpu(() => {
      throw new Error('blocked')
    })).toBeNull()
    expect(faceDiagnostics().problem).toBe('the background renderer could not start')
  })
})

describe('LazyBotFace stalled Worker fallback', () => {
  /** Sets up a visible LazyBotFace with an empty shot cache, fake timers, and a FakeWorker. */
  function mountLazyWithWorker(onMessage?: (worker: FakeWorker, message: FaceWorkerRequest) => void) {
    vi.useFakeTimers()
    resetFaceShots()
    resetLazyFaces()
    const observers: FakeObserver[] = []
    class TrackingObserver extends FakeObserver {
      constructor(callback: IntersectionObserverCallback) {
        super(callback)
        observers.push(this)
      }
      override observe(target: Element) {
        super.observe(target)
        this.fire(true, target)
      }
    }
    vi.stubGlobal('IntersectionObserver', TrackingObserver)
    let worker: FakeWorker | null = null
    class ScriptedWorker extends FakeWorker {
      override postMessage(message: FaceWorkerRequest) {
        super.postMessage(message)
        onMessage?.(this, message)
      }
    }
    resetSharedFaceRenderer(() => ({
      createGpu: () => createWorkerGpu(() => {
        worker = new ScriptedWorker()
        return worker as unknown as Worker
      }),
      createCanvas: () => document.createElement('canvas'),
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
      now: () => performance.now(),
      pixelRatio: () => 1,
      setTimer: (callback, ms) => {
        const handle = window.setTimeout(callback, ms)
        return () => window.clearTimeout(handle)
      },
      document,
      IntersectionObserver: TrackingObserver as unknown as typeof IntersectionObserver
    }))
    render(createElement(LazyBotFace, { look: coral, state: 'idle', size: 40, view: 'head', label: 'Helper' }))
    return { getWorker: () => worker!, observers }
  }

  it('shows a still face and terminates the worker when it never replies to start', async () => {
    const { getWorker } = mountLazyWithWorker()
    const worker = getWorker()
    expect(worker.sent).toEqual([{ type: 'start' }])
    expect(host.querySelector('.bot-face-placeholder[data-loading]')).not.toBeNull()
    // Slow compiles up to STARTUP_TIMEOUT_MS stay pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(worker.terminated).toBe(false)
    expect(sharedFaceRendererStatus()).toBe('pending')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS - 15_000 + READY_POLL_MS)
    })
    expect(worker.terminated).toBe(true)
    expect(sharedFaceRendererStatus()).toBe('failed')
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('[data-loading]')).toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
    expect(currentFaceDiagnosticsLines()[0]).toMatch(/^Off:.*start/i)
  })

  it('shows a still face and terminates the worker when it sends ready and then ignores frame', async () => {
    const { getWorker } = mountLazyWithWorker()
    const worker = getWorker()
    worker.reply({ type: 'ready', compileMs: 40 })
    // Let ready poll + LazyBotFace warming commit so BotFaceCanvas mounts, then run the first frame tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(worker.sent.some((m) => m.type === 'frame')).toBe(true)
    // Diagnostics must not report "On" while no frame has drawn.
    expect(currentFaceDiagnosticsLines()[0]).not.toBe('On')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(worker.terminated).toBe(true)
    expect(sharedFaceRendererStatus()).toBe('failed')
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('[data-loading]')).toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
    expect(currentFaceDiagnosticsLines()[0]).toMatch(/^Off:.*first 3D frame/i)
  })

  it('shows a still face and terminates the worker when it always returns null frames', async () => {
    const { getWorker } = mountLazyWithWorker((w, message) => {
      if (message.type === 'frame') {
        queueMicrotask(() => {
          if (!w.terminated) w.reply({ type: 'frame', id: message.id, pictures: null })
        })
      }
    })
    const worker = getWorker()
    worker.reply({ type: 'ready', compileMs: 40 })
    // Let ready poll + LazyBotFace warming commit so BotFaceCanvas mounts, then advance through retries.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    const framesSent = worker.sent.filter((m) => m.type === 'frame')
    expect(framesSent.length).toBeGreaterThanOrEqual(2)
    expect(worker.terminated).toBe(true)
    expect(sharedFaceRendererStatus()).toBe('failed')
    expect(host.querySelector('svg.bot-face-still')).not.toBeNull()
    expect(host.querySelector('[data-loading]')).toBeNull()
    expect(host.querySelector('.bot-face-placeholder')).toBeNull()
    expect(currentFaceDiagnosticsLines()[0]).toMatch(/^Off:.*first frame/i)
  })
})
