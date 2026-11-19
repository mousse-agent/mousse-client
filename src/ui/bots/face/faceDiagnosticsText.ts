import { faceGuardState, FACE_RENDERER_REVISION } from './faceGuard'
import { currentFaceRendererStatus, faceDiagnostics, faceRendererStats, type FaceDiagnostics } from './faceRenderer'

export interface FaceDiagnosticsInput {
  diagnostics: FaceDiagnostics
  status: ReturnType<typeof currentFaceRendererStatus>
  guard: ReturnType<typeof faceGuardState>
  /** Ms from the renderer's start to the shader found ready, as the renderer saw it. */
  readyMs: number | null
  /** The WebView's Chrome version, from its user agent. */
  webView: string | null
}

/**
 * The Bot faces row in Settings → Advanced, in plain words: whether 3D faces are on, waiting or off
 * and why, then the GPU, where the faces draw and how long the shader took. A screenshot of it should
 * be enough to tell why faces don't draw on a phone.
 */
export function faceDiagnosticsLines(input: FaceDiagnosticsInput): string[] {
  const { diagnostics: d, status, guard, readyMs } = input
  let headline: string
  if (guard.offBecause === 'setting') headline = 'Off: turned off above, in Bots'
  else if (guard.offBecause === 'tripped') headline = `Off: a start of the 3D faces stopped the app here (renderer ${FACE_RENDERER_REVISION}); the next update with a new renderer tries again`
  else if (guard.offBecause === 'storage') headline = 'Off: could not confirm the safety mark in phone storage'
  else if (status === 'ready') headline = d.drawn ? 'On' : 'Waiting: shader ready, waiting for the first frame'
  else if (status === 'pending') headline = 'Waiting: the shader is compiling'
  else if (status === 'failed' || status === 'unavailable') headline = `Off: ${d.problem ?? 'the 3D faces failed to start'}`
  else if (guard.phase === 'loading' || guard.phase === 'idle' || guard.phase === 'arming') headline = 'Waiting: starting safely'
  else if (d.problem) headline = `Off: ${d.problem}`
  else if (d.path && d.drawn) headline = 'On, resting: no bot face is on screen'
  else if (d.path) headline = 'Waiting: no frame drawn yet'
  else headline = 'Not started yet: the first bot face on screen starts them'
  const lines = [headline]
  if (d.renderer) lines.push(`GPU: ${d.renderer}`)
  const where = d.path === 'worker' ? 'in the background (Worker)' : d.path === 'page' ? 'on the page' : null
  if (where) lines.push(`Drawn ${where}${d.parallelCompile === null ? '' : d.parallelCompile ? ', parallel compile' : ', no parallel compile'}${d.highp === false ? ', no high precision' : ''}`)
  if (d.compileMs !== null || readyMs !== null) {
    lines.push(`Shader: ${d.compileMs !== null ? `compiled in ${formatMs(d.compileMs)}` : ''}${d.compileMs !== null && readyMs !== null ? ', ' : ''}${readyMs !== null ? `ready ${formatMs(readyMs)} after start` : ''}`)
  }
  if (guard.retrying && guard.offBecause === null) lines.push('Trying again after an older version stopped')
  if (input.webView) lines.push(`WebView ${input.webView}`)
  return lines
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** The lines as they are now. */
export function currentFaceDiagnosticsLines(): string[] {
  const webView = typeof navigator === 'undefined' ? null : navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? null
  return faceDiagnosticsLines({
    diagnostics: faceDiagnostics(),
    status: currentFaceRendererStatus(),
    guard: faceGuardState(),
    readyMs: faceRendererStats()?.compileMs ?? null,
    webView
  })
}
