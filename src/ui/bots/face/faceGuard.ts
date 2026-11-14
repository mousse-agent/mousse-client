import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

/**
 * Keeps the 3D bot faces from taking the app down on a phone whose GPU can't run their shader.
 *
 * On Android the WebView's GPU work runs in the app's own process. A driver that stalls compiling or
 * drawing the face shader freezes the whole app, and Android closes it after 5 seconds, so no
 * JavaScript error handler ever runs. The guard leaves a mark on disk before the face renderer
 * starts and clears it once faces have drawn for a while. A launch that finds the mark still there
 * knows the last start never finished, and keeps to the still faces until the person turns 3D faces
 * on again in Settings.
 *
 * Stored values: `ok` (3D faces ran here), `starting` (a start in progress, or one that died),
 * `off` (still faces only). Nothing stored means 3D faces have never started on this phone.
 * In a browser (the demo, tests) there is no guard: faces start at once.
 */
export type FaceMode = 'live' | 'still'
type Stored = 'ok' | 'starting' | 'off'

const KEY = 'mousse.botFaces.v1'
/** Faces that have drawn this long after the shader was ready count as safe on this phone. */
export const CONFIRM_MS = 2_500
/** A gap between writing the mark and starting the GPU, so the mark is on disk before any stall. */
const SETTLE_MS = 250

type Phase = 'loading' | 'idle' | 'arming' | 'armed' | 'off'

interface GuardStore {
  get(): Promise<string | null>
  set(value: Stored): Promise<void>
}

const preferencesStore: GuardStore = {
  get: async () => (await Preferences.get({ key: KEY })).value ?? null,
  set: (value) => Preferences.set({ key: KEY, value })
}

let store: GuardStore | null = Capacitor.isNativePlatform() ? preferencesStore : null
let phase: Phase = store ? 'loading' : 'armed'
/** The last start died: shown once in Settings so the person knows why faces are still. */
let tripped = false
let confirmed = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function setPhase(next: Phase): void {
  if (phase === next) return
  phase = next
  emit()
}

async function load(): Promise<void> {
  if (!store) return
  let value: string | null = null
  try {
    value = await store.get()
  } catch {
    value = null
  }
  if (value === 'starting') {
    // The last start never confirmed: the app died while faces were starting.
    tripped = true
    await store.set('off').catch(() => {})
    setPhase('off')
  } else if (value === 'off') {
    setPhase('off')
  } else {
    setPhase('idle')
  }
}

let loaded: Promise<void> | null = null
function ensureLoaded(): void {
  loaded ??= load()
}

/** Whether the face renderer may be made now. The first ask on a phone arms the guard and says no until it is armed. */
export function faceRendererAllowed(): boolean {
  if (phase === 'armed') return true
  ensureLoaded()
  if (phase === 'idle') void arm()
  return false
}

async function arm(): Promise<void> {
  if (phase !== 'idle' || !store) return
  setPhase('arming')
  try {
    await store.set('starting')
  } catch {
    // Without a mark the guard can't protect the next launch; still faces are the safe choice.
    setPhase('off')
    return
  }
  setTimeout(() => setPhase('armed'), SETTLE_MS)
}

/** The face renderer reached ready and drew; after `CONFIRM_MS` more of life, this phone runs 3D faces. */
export function faceRendererReady(): void {
  if (!store || confirmed || phase !== 'armed') return
  confirmed = true
  setTimeout(() => {
    if (phase === 'armed') void store?.set('ok').catch(() => {})
  }, CONFIRM_MS)
}

export function subscribeFaceGuard(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The Settings choice: 3D faces (`live`) or still ones. */
export function faceMode(): FaceMode {
  ensureLoaded()
  return phase === 'off' ? 'still' : 'live'
}

/** True when 3D faces were turned off because they stopped the app last time. */
export function faceGuardTripped(): boolean {
  return tripped
}

export async function setFaceMode(mode: FaceMode): Promise<void> {
  tripped = false
  emit()
  if (!store) {
    setPhase(mode === 'still' ? 'off' : 'armed')
    return
  }
  if (mode === 'still') {
    await store.set('off').catch(() => {})
    setPhase('off')
    return
  }
  // Back on: the next start is guarded again, as on a new install.
  await store.set('ok').catch(() => {})
  confirmed = false
  setPhase('idle')
}

/** For tests: a guard over `next` (null = a browser, no guard). */
export function resetFaceGuard(next: GuardStore | null): void {
  store = next
  phase = next ? 'loading' : 'armed'
  tripped = false
  confirmed = false
  loaded = null
  emit()
}
