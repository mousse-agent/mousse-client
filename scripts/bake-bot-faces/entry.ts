// Runs in the bake's browser page: draws one layer of a face with the face shader and returns it as
// a WebP data URL (Chromium's encoder: lossy colour, lossless alpha). Bundled by `scripts/bake-bot-faces.mjs`.
import { BOT_COLOUR_HEX, BOT_COLOURS, type KnownBotLook } from '../../src/ui/bots/look'
import { allBakedFaces, BAKED_FACE_PX, bakedFaceFile, type BakedFace } from '../../src/ui/bots/face/bakedFaces'
import { faceUniforms, mousseEyesWhite, stillPose } from '../../src/ui/bots/face/facePoses'
import { MICE_FRAGMENT_SHADER, MICE_UNIFORMS, MICE_VERTEX_SHADER } from '../../src/ui/bots/face/miceShader'
// @ts-expect-error A plain ES module without types.
import { layerShader } from './layerShader.mjs'

const LAYER = { body: 0, eyes: 1, accessory: 2, whiskers: 3 } as const

/** The look that draws a layer; parts other than the layer's own do not show in it. */
function layerLook(face: BakedFace): KnownBotLook {
  const kind = face.kind === 'mousse' ? { kind: 'mousse' as const } : {}
  const layer = face.layer
  switch (layer.layer) {
    case 'body':
      return { colour: layer.colour, accessory: 'none', ...kind }
    case 'eyes': {
      // The Mousse's eye ink follows its colour: pick a colour with the wanted ink.
      const colour = BOT_COLOURS.find((c) => mousseEyesWhite(BOT_COLOUR_HEX[c]) === layer.white) ?? 'coral'
      return { colour, accessory: 'none', ...kind, ...(layer.eyes !== 'pill' ? { eyes: layer.eyes } : {}) }
    }
    case 'whiskers':
      return { colour: 'coral', accessory: 'none', ...kind }
    case 'accessory':
      return { colour: 'coral', accessory: layer.accessory, ...kind }
  }
}

const canvas = document.createElement('canvas')
const gl = canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false })
if (!gl) throw new Error('no WebGL')

function compile(type: number, source: string): WebGLShader {
  const shader = gl!.createShader(type)!
  gl!.shaderSource(shader, source)
  gl!.compileShader(shader)
  if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(shader) ?? 'compile failed')
  return shader
}

const program = gl.createProgram()!
gl.attachShader(program, compile(gl.VERTEX_SHADER, MICE_VERTEX_SHADER))
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, layerShader(MICE_FRAGMENT_SHADER)))
gl.linkProgram(program)
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
gl.useProgram(program)
const buffer = gl.createBuffer()
gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
const attribute = gl.getAttribLocation(program, 'a')
gl.enableVertexAttribArray(attribute)
gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0)
const at = Object.fromEntries([...MICE_UNIFORMS, 'uL'].map((name) => [name, gl.getUniformLocation(program, name)]))

function draw(face: BakedFace, quality: number): string {
  const px = BAKED_FACE_PX[face.view]
  canvas.width = px
  canvas.height = px
  gl!.viewport(0, 0, px, px)
  gl!.clearColor(0, 0, 0, 0)
  gl!.clear(gl!.COLOR_BUFFER_BIT)
  // Size 100 keeps the whiskers in the scene; the layer decides whether they show.
  const u = faceUniforms(layerLook(face), stillPose(face.state), { view: face.view, size: 100, samples: 2 })
  gl!.uniform2f(at.uRes!, px, px)
  gl!.uniform2f(at.uOrg!, 0, 0)
  gl!.uniform3fv(at.uCol!, u.uCol)
  gl!.uniform4fv(at.uAC!, u.uAC)
  gl!.uniform1f(at.uAcc!, u.uAcc)
  gl!.uniform4fv(at.uB!, u.uB)
  gl!.uniform4fv(at.uH!, u.uH)
  gl!.uniform4fv(at.uH2!, u.uH2)
  gl!.uniform4fv(at.uE!, u.uE)
  gl!.uniform4fv(at.uE2!, u.uE2)
  gl!.uniform4fv(at.uV!, u.uV)
  gl!.uniform3fv(at.uK!, u.uK)
  gl!.uniform1f(at.uL!, LAYER[face.layer.layer])
  gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4)
  return canvas.toDataURL('image/webp', quality)
}

declare global {
  interface Window {
    bake: { faces(): { file: string; face: BakedFace }[]; draw(face: BakedFace, quality: number): string }
  }
}

window.bake = {
  faces: () => allBakedFaces().map((face) => ({ file: bakedFaceFile(face), face })),
  draw
}
