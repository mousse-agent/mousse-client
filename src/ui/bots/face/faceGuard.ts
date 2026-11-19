import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

/**
 * Keeps the 3D bot faces from taking the app down twice on a phone whose GPU can't run their shader.
 *
 * The faces now compile and draw in a Worker (`faceWorker.ts`), so a slow compile no longer freezes
 * the page. But a GPU driver that crashes or hangs runs in the app's own process, and then no
 * JavaScript error handler ever runs. The guard leaves a mark on disk before the face renderer
 * starts and clears it once faces have drawn for a while. A launch that finds the mark still there
 * knows the last start never finished, and keeps to the saved pictures.
 *
 * That holds only for the renderer revision that tripped (`FACE_RENDERER_REVISION`). A build with a
 * newer revision tries 3D faces again, still guarded, without the person having to find the setting:
 * the shader or the way it starts may have changed what stopped the app. Turning 3D faces off in
 * Settings is the person's choice and stays.
 *
 * Stored values: `ok` (3D faces ran here), `starting:<rev>` (a start in progress, or one that died),
 * `tripped:<rev>` (a start of that revision died: no 3D faces for it), `user-off` (turned off in
 * Settings). Builds before revision 2 stored `starting` and `off`, and used `off` for both a trip and
 * the setting; both read as a trip of revision 1, so the new build tries again once.
 * Nothing stored means 3D faces have never started on this phone.
 * In a browser (the demo, tests) there is no guard: faces start at once.
 */
export type FaceMode = 'live' | 'still'

/**
 * Bump when a change to the face renderer or shader may let a phone whose last start died run the
 * faces: it then tries once more. 2: the shader a sixth of its size, compiled and drawn in a Worker.
 */
export const FACE_RENDERER_REVISION = 2

const KEY = 'mousse.botFaces.v1'
/** Faces that have drawn this long after the shader was ready count as safe on this phone. */
export const CONFIRM_MS = 2_500
/** A gap between writing the mark and starting the GPU, so the mark is on disk before any stall. */
const SETTLE_MS = 250
/** Max time to wait on native storage before keeping the GPU off. */
export const GUARD_STORAGE_TIMEOUT_MS = 3_000

type Phase = 'loading' | 'idle' | 'arming' | 'armed' | 'off'
export type FaceGuardOffReason = 'tripped' | 'setting' | 'storage'

interface GuardStore {
  get(): Promise<string | null>
  set(value: string): Promise<void>
}

const preferencesStore: GuardStore = {
  get: async () => (await Preferences.get({ key: KEY })).value ?? null,
  set: (value) => Preferences.set({ key: KEY, value })
}

let store: GuardStore | null = Capacitor.isNativePlatform() ? preferencesStore : null
let phase: Phase = store ? 'loading' : 'armed'
/** Why faces are off: a start that died (of this revision), the setting, or storage that could not confirm the mark. */
let offBecause: FaceGuardOffReason | null = null
/** A start of an older revision died, and this launch tries again. */
let retrying = false
let confirmed = false
let generation = 0
let settleTimer: ReturnType<typeof setTimeout> | null = null
let confirmTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('guard storage timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function clearTimers(): void {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = null
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = null
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function setPhase(next: Phase): void {
  if (phase === next) return
  phase = next
  emit()
}

/** The revision in a stored `starting:<rev>` or `tripped:<rev>`; builds before revision 2 wrote none. */
function revisionOf(value: string): number {
  const rev = Number(value.split(':')[1])
  return Number.isInteger(rev) && rev > 0 ? rev : 1
}

async function load(): Promise<void> {
  if (!store) return
  const gen = generation
  let value: string | null = null
  try {
    value = await withTimeout(store.get(), GUARD_STORAGE_TIMEOUT_MS)
  } catch {
    if (gen !== generation) return
    // Storage threw or stalled: without reading the mark we can't start the GPU safely.
    offBecause = 'storage'
    setPhase('off')
    return
  }
  if (gen !== generation) return
  if (value === 'user-off') {
    offBecause = 'setting'
    setPhase('off')
    return
  }
  const died = value !== null && (value === 'off' || value.startsWith('starting') || value.startsWith('tripped'))
  if (died && revisionOf(value!) === FACE_RENDERER_REVISION) {
    // A start of this revision never confirmed: the app died while faces were starting.
    offBecause = 'tripped'
    if (!value!.startsWith('tripped')) await withTimeout(store.set(`tripped:${FACE_RENDERER_REVISION}`), GUARD_STORAGE_TIMEOUT_MS).catch(() => {})
    if (gen !== generation) return
    setPhase('off')
    return
  }
  // Nothing stored, `ok`, or a start of an older revision that died: start, guarded.
  retrying = died
  setPhase('idle')
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
  const gen = generation
  setPhase('arming')
  try {
    await withTimeout(store.set(`starting:${FACE_RENDERER_REVISION}`), GUARD_STORAGE_TIMEOUT_MS)
  } catch {
    if (gen !== generation) return
    // Without a confirmed start mark the guard can't protect the next launch; keep the GPU off.
    offBecause = 'storage'
    setPhase('off')
    return
  }
  if (gen !== generation) return
  settleTimer = setTimeout(() => {
    settleTimer = null
    if (gen !== generation || phase !== 'arming') return
    setPhase('armed')
  }, SETTLE_MS)
}

/** The face renderer reached ready and drew; after `CONFIRM_MS` more of life, this phone runs 3D faces. */
export function faceRendererReady(): void {
  if (!store || confirmed || phase !== 'armed') return
  confirmed = true
  const gen = generation
  confirmTimer = setTimeout(() => {
    confirmTimer = null
    if (gen === generation && phase === 'armed') void withTimeout(store!.set('ok'), GUARD_STORAGE_TIMEOUT_MS).catch(() => {})
  }, CONFIRM_MS)
}

export function subscribeFaceGuard(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The Settings choice: 3D faces (`live`) or the saved pictures only. */
export function faceMode(): FaceMode {
  ensureLoaded()
  return phase === 'off' ? 'still' : 'live'
}

/** The guard has not decided yet (reading the phone's storage, or saving its mark): faces wait. */
export function faceGuardWaiting(): boolean {
  ensureLoaded()
  return phase === 'loading' || phase === 'idle' || phase === 'arming'
}

/** True when 3D faces are off because a start of this renderer revision stopped the app. */
export function faceGuardTripped(): boolean {
  return phase === 'off' && offBecause === 'tripped'
}

/** Where the guard is, for Settings → Advanced. */
export function faceGuardState(): { guarded: boolean; phase: Phase; offBecause: FaceGuardOffReason | null; retrying: boolean; confirmed: boolean } {
  return { guarded: !!store, phase, offBecause: phase === 'off' ? offBecause : null, retrying, confirmed }
}

export async function setFaceMode(mode: FaceMode): Promise<void> {
  generation++
  clearTimers()
  if (!store) {
    offBecause = mode === 'still' ? 'setting' : null
    setPhase(mode === 'still' ? 'off' : 'armed')
    emit()
    return
  }
  if (mode === 'still') {
    offBecause = 'setting'
    await withTimeout(store.set('user-off'), GUARD_STORAGE_TIMEOUT_MS).catch(() => {})
    setPhase('off')
    emit()
    return
  }
  // Back on: the next start is guarded again, as on a new install.
  offBecause = null
  retrying = false
  await withTimeout(store.set('ok'), GUARD_STORAGE_TIMEOUT_MS).catch(() => {})
  confirmed = false
  setPhase('idle')
  emit()
}

/** For tests: a guard over `next` (null = a browser, no guard). */
export function resetFaceGuard(next: GuardStore | null): void {
  generation++
  clearTimers()
  store = next
  phase = next ? 'loading' : 'armed'
  offBecause = null
  retrying = false
  confirmed = false
  loaded = null
  emit()
}
