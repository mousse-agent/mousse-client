/**
 * Pictures of 3D faces the phone has drawn, so a face shows at once on the next visit, as the 3D
 * face looked, while the live one starts (or in its place when 3D faces can't run).
 *
 * A picture is keyed by everything that changes the drawing: look, pose, view and size in device
 * pixels. Pictures are small (a 48 px face at 3x is about 10 KB), the newest `LIMIT` are kept, and
 * they live in the WebView's local storage.
 */
import type { KnownBotLook } from '../look'

const STORAGE_KEY = 'mousse.botFaceShots.v1'
const LIMIT = 48

let shots: Map<string, string> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function load(): Map<string, string> {
  if (shots) return shots
  shots = new Map()
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    const entries = raw ? (JSON.parse(raw) as unknown) : null
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].startsWith('data:image/')) shots.set(entry[0], entry[1])
      }
    }
  } catch {
    // A broken store starts empty.
  }
  return shots
}

function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const store = storage()
    if (!store || !shots) return
    try {
      store.setItem(STORAGE_KEY, JSON.stringify([...shots]))
    } catch {
      // Full: keep the newest half and try once more.
      const kept = [...shots].slice(-Math.floor(LIMIT / 2))
      shots = new Map(kept)
      try {
        store.setItem(STORAGE_KEY, JSON.stringify(kept))
      } catch {
        // Pictures are only a speed-up; without room the faces load as before.
      }
    }
  }, 400)
}

export function faceShotKey(look: KnownBotLook, state: string, view: string, px: number): string {
  return `${look.kind ?? 'mouse'}|${look.colour}|${look.accessory}|${look.eyes ?? 'pill'}|${state}|${view}|${px}`
}

/** The saved picture for this face, if any. */
export function faceShot(key: string): string | undefined {
  return load().get(key)
}

/** Saves the canvas's picture under `key`, unless one is already saved. */
export function saveFaceShot(key: string, canvas: HTMLCanvasElement): void {
  const map = load()
  if (map.has(key)) return
  let url: unknown
  try {
    url = canvas.toDataURL('image/webp', 0.92)
  } catch {
    return
  }
  // A canvas that can't give a picture (or gives an empty one) saves nothing.
  if (typeof url !== 'string' || !url.startsWith('data:image/') || url.length < 200) return
  map.set(key, url)
  while (map.size > LIMIT) map.delete(map.keys().next().value!)
  save()
}

/** For tests. */
export function resetFaceShots(): void {
  shots = null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
}
