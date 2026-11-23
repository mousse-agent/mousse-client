/**
 * Whether bot faces are drawn live in 3D (WebGL) or shown as baked pictures (`bakedFaces.ts`).
 *
 * The pictures are the default: every face shows at once, nothing loads or compiles, and the phone's
 * GPU stays free. The live renderer (`faceRenderer.ts`, its Worker, the guard and the Settings rows)
 * is kept whole. To bring it back, set this to `true`: faces then draw live, show their pictures
 * until the first frame, and Settings gets the Bot faces switch and diagnostics again.
 */
export const LIVE_FACES: boolean = false
