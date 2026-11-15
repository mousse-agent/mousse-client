/**
 * Pictures of 3D faces the phone has drawn, so a face shows at once on the next visit, as the 3D
 * face looked, while the live one starts (or in its place when 3D faces can't run).
 *
 * The phone's version of the desktop's saved face frames (`faceFrameStore.ts` there). The renderer
 * saves every clean still frame it draws, and the still pose of each moving face, under its exact
 * spec (`stillFrameKey`: look, pose, view, size and canvas side in device pixels). Unlike the
 * desktop's IndexedDB store, the pictures live in the WebView's local storage as data URLs, so a
 * face reads its picture in its very first render, before any renderer exists (lists hold the live
 * face back until it is near the screen; see `LazyBotFace`).
 *
 * The store carries the art version the pictures were drawn with (`faceArtVersion`); pictures of any
 * other version are dropped when it loads, so a picture never outlives a change to the shader or the
 * poses. Pictures are small (a 48 px face at 3x is about 10 KB) and the newest `LIMIT` are kept.
 */

const STORAGE_KEY = 'mousse.botFaceShots.v2'
/** Older builds' pictures, drawn with an older shader and keyed differently: removed on load. */
const OLD_STORAGE_KEY = 'mousse.botFaceShots.v1'
const LIMIT = 48

/** A decoded picture, drawn with `drawImage`. */
export type SavedFrameImage = CanvasImageSource & { readonly width: number; readonly height: number }

/** The renderer's view of the saved pictures (the same shape as the desktop's). */
export interface FaceFrameStore {
  /** Whether the saved pictures have been read. Local storage reads at once, so always true here. */
  settled(): boolean
  /** Calls `listener` once settled (at once when it already is); returns a function that stops it. */
  onSettled(listener: () => void): () => void
  has(key: string): boolean
  /** The picture decoded as the store opened, handed over once; null when it wasn't. */
  take(key: string): SavedFrameImage | null
  /** The decoded picture, or null when there is none or it can't be decoded (then it is forgotten). */
  image(key: string): Promise<SavedFrameImage | null>
  /** Saves the picture in `canvas` under `key`, unless one is saved already. */
  save(key: string, canvas: HTMLCanvasElement): void
  /** Drops a record, for example one decoded at the wrong size. */
  forget(key: string): void
}

let shots: Map<string, string> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let versionOf: () => string = () => ''
let version: string | null = null

/** Sets how the art version is found (`faceArtVersion`, which is only worked out when a picture is first read). */
export function setFaceShotVersion(get: () => string): void {
  versionOf = get
  version = null
  shots = null
}

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
  version ??= versionOf()
  const store = storage()
  try {
    store?.removeItem(OLD_STORAGE_KEY)
    const raw = store?.getItem(STORAGE_KEY)
    const saved = raw ? (JSON.parse(raw) as { version?: unknown; shots?: unknown }) : null
    if (saved && saved.version === version && Array.isArray(saved.shots)) {
      for (const entry of saved.shots) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].startsWith('data:image/')) shots.set(entry[0], entry[1])
      }
    }
  } catch {
    // A broken store starts empty.
  }
  return shots
}

function write(store: Storage, entries: [string, string][]): void {
  store.setItem(STORAGE_KEY, JSON.stringify({ version, shots: entries }))
}

function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const store = storage()
    if (!store || !shots) return
    try {
      write(store, [...shots])
    } catch {
      // Full: keep the newest half and try once more.
      const kept = [...shots].slice(-Math.floor(LIMIT / 2))
      shots = new Map(kept)
      try {
        write(store, kept)
      } catch {
        // Pictures are only a speed-up; without room the faces load as before.
      }
    }
  }, 400)
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

async function decode(url: string): Promise<SavedFrameImage | null> {
  if (typeof Image === 'undefined') return null
  const image = new Image()
  image.src = url
  try {
    await image.decode()
  } catch {
    return null
  }
  return image.naturalWidth > 0 ? image : null
}

/** The saved pictures as the renderer's frame store. */
export const faceShotFrames: FaceFrameStore = {
  settled: () => true,
  onSettled(listener) {
    listener()
    return () => undefined
  },
  has: (key) => load().has(key),
  take: () => null,
  async image(key) {
    const url = load().get(key)
    if (!url) return null
    const image = await decode(url)
    if (!image) faceShotFrames.forget(key)
    return image
  },
  save: saveFaceShot,
  forget(key) {
    if (load().delete(key)) save()
  }
}

/** A short, stable hash of `text` (FNV-1a, 32 bits), for the art version. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(36)}.${text.length.toString(36)}`
}

/** For tests. */
export function resetFaceShots(): void {
  shots = null
  version = null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
}
