/**
 * The bot face shader, compiled and drawn off the page (see `faceRenderer.ts`, "Never in the way").
 *
 * Android's WebView has no `KHR_parallel_shader_compile`, so asking whether the shader linked waits
 * for the whole compile, which a slow driver can stretch to many seconds. Here only this Worker
 * waits; the page keeps drawing and answering touches. Each frame message carries a tick's batches of
 * faces; each batch is drawn into this Worker's `OffscreenCanvas` and handed back as an `ImageBitmap`.
 *
 * The context has the same settings as the page's (`createWebGlGpu`): no software WebGL, which can't
 * ray-march faces at any useful speed.
 */
import { MICE_FRAGMENT_SHADER, MICE_UNIFORMS, MICE_VERTEX_SHADER, type MiceUniform } from './miceShader'
import type { FaceUniforms } from './facePoses'

export type FaceWorkerRequest =
  | { type: 'start' }
  | { type: 'frame'; id: number; batches: { width: number; height: number; draws: { x: number; y: number; side: number; uniforms: FaceUniforms }[] }[] }
  | { type: 'shrink' }

export type FaceWorkerReply =
  /** What the GPU is, sent once the context exists (before the compile). */
  | { type: 'info'; renderer: string | null; parallel: boolean; highp: boolean }
  /** The shader linked; `compileMs` is the time the compile and link took, in this Worker. */
  | { type: 'ready'; compileMs: number }
  /** No faces from this Worker; `problem` says why, in plain words. */
  | { type: 'failed'; problem: string }
  | { type: 'lost' }
  | { type: 'restored' }
  /** The pictures of a frame message's batches, in order; null when they could not be drawn. */
  | { type: 'frame'; id: number; pictures: ImageBitmap[] | null }

interface WorkerScope {
  postMessage(message: FaceWorkerReply, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<FaceWorkerRequest>) => void) | null
}

const scope = self as unknown as WorkerScope
const post = (message: FaceWorkerReply, transfer: Transferable[] = []) => scope.postMessage(message, transfer)

let canvas: OffscreenCanvas | null = null
let gl: WebGLRenderingContext | null = null
let program: WebGLProgram | null = null
let uniforms = {} as Record<MiceUniform, WebGLUniformLocation | null>
let state: 'off' | 'compiling' | 'ready' | 'lost' | 'failed' = 'off'

function fail(problem: string): void {
  state = 'failed'
  post({ type: 'failed', problem })
}

function rendererName(context: WebGLRenderingContext): string | null {
  const info = context.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null
  const name = info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER)
  return typeof name === 'string' ? name : null
}

function start(): void {
  if (state !== 'off') return
  if (typeof OffscreenCanvas === 'undefined') return fail('this WebView has no OffscreenCanvas for a background renderer')
  try {
    canvas = new OffscreenCanvas(1, 1)
    gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: true
    }) as WebGLRenderingContext | null
  } catch {
    gl = null
  }
  if (!canvas || !gl) {
    // Without the caveat, a context would mean the GPU was refused as too slow (or software).
    let refused: string | null = null
    try {
      const plain = new OffscreenCanvas(1, 1).getContext('webgl') as WebGLRenderingContext | null
      if (plain) refused = rendererName(plain) ?? 'unknown GPU'
    } catch {
      refused = null
    }
    return fail(refused ? `WebGL refused as slow or software (${refused})` : 'no WebGL in a background renderer on this WebView')
  }
  const name = rendererName(gl)
  if (name && /swiftshader|llvmpipe|softpipe|software/i.test(name)) return fail(`software WebGL only (${name})`)
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    state = 'lost'
    post({ type: 'lost' })
  })
  canvas.addEventListener('webglcontextrestored', () => {
    post({ type: 'restored' })
    compile()
  })
  const highp = (gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ?? 0) > 0
  post({ type: 'info', renderer: name, parallel: !!gl.getExtension('KHR_parallel_shader_compile'), highp })
  compile()
}

function compile(): void {
  const context = gl
  if (!context) return
  state = 'compiling'
  const started = performance.now()
  try {
    const highp = (context.getShaderPrecisionFormat(context.FRAGMENT_SHADER, context.HIGH_FLOAT)?.precision ?? 0) > 0
    // A GPU without high precision in fragment shaders still gets a face, if a coarser one.
    const fragment = highp ? MICE_FRAGMENT_SHADER : MICE_FRAGMENT_SHADER.replace('precision highp float;', 'precision mediump float;')
    const shader = (type: number, source: string) => {
      const s = context.createShader(type)
      if (!s) throw new Error('no shader')
      context.shaderSource(s, source)
      context.compileShader(s)
      return s
    }
    const vs = shader(context.VERTEX_SHADER, MICE_VERTEX_SHADER)
    const fs = shader(context.FRAGMENT_SHADER, fragment)
    const linked = context.createProgram()
    if (!linked) throw new Error('no program')
    context.attachShader(linked, vs)
    context.attachShader(linked, fs)
    context.bindAttribLocation(linked, 0, 'a')
    context.linkProgram(linked)
    // This waits for the whole compile, here in the Worker only.
    if (!context.getProgramParameter(linked, context.LINK_STATUS)) {
      if (context.isContextLost()) return
      const log = (context.getShaderInfoLog(fs) || context.getProgramInfoLog(linked) || '').trim().split('\n')[0]?.slice(0, 160)
      return fail(`the face shader did not compile${log ? `: ${log}` : ''}`)
    }
    program = linked
    context.useProgram(program)
    uniforms = Object.fromEntries(MICE_UNIFORMS.map((name) => [name, context.getUniformLocation(linked, name)])) as typeof uniforms
    const buffer = context.createBuffer()
    context.bindBuffer(context.ARRAY_BUFFER, buffer)
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), context.STATIC_DRAW)
    context.enableVertexAttribArray(0)
    context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0)
    context.disable(context.BLEND)
  } catch (error) {
    if (context.isContextLost()) return
    return fail(`the face shader could not be set up (${error instanceof Error ? error.message : 'error'})`)
  }
  state = 'ready'
  post({ type: 'ready', compileMs: Math.round(performance.now() - started) })
}

/** Sets a face's uniforms: every one the shader has, by the length of its value. */
function setUniforms(context: WebGLRenderingContext, u: FaceUniforms): void {
  for (const name of MICE_UNIFORMS) {
    if (name === 'uRes' || name === 'uOrg') continue
    const value = u[name as keyof FaceUniforms] as number | readonly number[]
    const location = uniforms[name]
    if (typeof value === 'number') context.uniform1f(location, value)
    else if (value.length === 3) context.uniform3fv(location, value as number[])
    else if (value.length === 4) context.uniform4fv(location, value as number[])
  }
}

function frame(id: number, batches: Extract<FaceWorkerRequest, { type: 'frame' }>['batches']): void {
  const context = gl
  if (state !== 'ready' || !context || !canvas || context.isContextLost()) return post({ type: 'frame', id, pictures: null })
  const pictures: ImageBitmap[] = []
  try {
    for (const batch of batches) {
      // Sized for each batch, in steps, so the buffer isn't reallocated every tick.
      const w = Math.max(canvas.width, Math.ceil(batch.width / 128) * 128)
      const h = Math.max(canvas.height, Math.ceil(batch.height / 128) * 128)
      if (w !== canvas.width) canvas.width = w
      if (h !== canvas.height) canvas.height = h
      for (const { x, y, side, uniforms: u } of batch.draws) {
        const glY = canvas.height - y - side
        context.viewport(x, glY, side, side)
        context.uniform2f(uniforms.uRes, side, side)
        context.uniform2f(uniforms.uOrg, x, glY)
        setUniforms(context, u)
        context.drawArrays(context.TRIANGLES, 0, 3)
      }
      pictures.push(canvas.transferToImageBitmap())
    }
  } catch {
    for (const picture of pictures) picture.close()
    return post({ type: 'frame', id, pictures: null })
  }
  post({ type: 'frame', id, pictures }, pictures)
}

scope.onmessage = (event) => {
  const message = event.data
  if (message.type === 'start') start()
  else if (message.type === 'frame') frame(message.id, message.batches)
  else if (message.type === 'shrink' && canvas && (canvas.width !== 1 || canvas.height !== 1)) canvas.width = canvas.height = 1
}
