import {
  BOT_ACCESSORIES,
  BOT_COLOUR_HEX,
  BOT_COLOURS,
  BOT_EYES,
  BOT_KINDS,
  botEyesOf,
  botKindOf,
  type BotAccessory,
  type BotColour,
  type BotEyes,
  type BotKind,
  type KnownBotLook
} from '../look'
import type { BotFaceState } from './BotFace'
import { mousseEyesWhite, WHISKER_MIN_SIZE } from './facePoses'

/**
 * Bot faces as pictures baked from the face shader (`scripts/bake-bot-faces.mjs`), so the phone shows
 * every face at once and never runs the 3D renderer. A face is a stack of layers, each baked once:
 * - the body, in each colour, with no eyes or accessory;
 * - the eyes, in each shape (the Mousse's in white or near-black);
 * - the mouse's whiskers, shown from `WHISKER_MIN_SIZE` up as the live face does;
 * - the accessory, with the body hiding the parts of it behind the body.
 * One set per character, state and view, so 8 colours, 12 accessories and 8 eye shapes need about
 * 380 pictures per view instead of one per combination.
 *
 * The mouse stacks body, eyes, whiskers, accessory (glasses sit in front of the eyes); the Mousse
 * stacks body, accessory, eyes, because its eyes are painted on the front of its glass over
 * everything behind it.
 */

/** The states that have pictures, in `BOT_FACE_STATES` order (a test keeps the two equal). */
export const BAKED_FACE_STATES: readonly BotFaceState[] = ['idle', 'working', 'needs_you', 'stuck', 'paused', 'happy']

/** Each view's picture side in pixels: 3x the largest size the app shows it at (60 px heads, 112 px full). */
export const BAKED_FACE_PX = { head: 180, full: 336 } as const

export type BakedFaceView = keyof typeof BAKED_FACE_PX

export type BakedLayer =
  | { layer: 'body'; colour: BotColour }
  | { layer: 'eyes'; eyes: BotEyes; white: boolean }
  | { layer: 'whiskers' }
  | { layer: 'accessory'; accessory: Exclude<BotAccessory, 'none'> }

export interface BakedFace {
  kind: BotKind
  state: BotFaceState
  view: BakedFaceView
  layer: BakedLayer
}

/** Where the pictures live, under the app's public folder. */
export const BAKED_FACE_DIR = 'bot-faces'

/** A layer's file, relative to `BAKED_FACE_DIR`. */
export function bakedFaceFile(face: BakedFace): string {
  const base = `${face.view}/${face.kind}-${face.state}`
  switch (face.layer.layer) {
    case 'body':
      return `${base}-body-${face.layer.colour}.webp`
    case 'eyes':
      return `${base}-eyes-${face.layer.eyes}${face.layer.white ? '-white' : ''}.webp`
    case 'whiskers':
      return `${base}-whiskers.webp`
    case 'accessory':
      return `${base}-acc-${face.layer.accessory}.webp`
  }
}

/** A layer's address in the app (Vite serves `public` at the app's base). */
export function bakedFaceUrl(face: BakedFace): string {
  return `${import.meta.env.BASE_URL}${BAKED_FACE_DIR}/${bakedFaceFile(face)}`
}

/** The layers of one face, bottom first. `size` is in CSS pixels; it decides the whiskers. */
export function bakedFaceLayers(look: KnownBotLook, state: BotFaceState, view: BakedFaceView, size: number): BakedFace[] {
  const kind = botKindOf(look)
  const at = (layer: BakedLayer): BakedFace => ({ kind, state, view, layer })
  const body = at({ layer: 'body', colour: look.colour })
  const accessory = look.accessory === 'none' ? [] : [at({ layer: 'accessory', accessory: look.accessory })]
  if (kind === 'mousse') {
    return [body, ...accessory, at({ layer: 'eyes', eyes: botEyesOf(look), white: mousseEyesWhite(BOT_COLOUR_HEX[look.colour]) })]
  }
  const whiskers = size >= WHISKER_MIN_SIZE ? [at({ layer: 'whiskers' })] : []
  return [body, at({ layer: 'eyes', eyes: botEyesOf(look), white: false }), ...whiskers, ...accessory]
}

/** Every picture the app can ask for: what the bake draws and what a test checks is present. */
export function allBakedFaces(): BakedFace[] {
  const faces: BakedFace[] = []
  const inks = [...new Set(BOT_COLOURS.map((colour) => mousseEyesWhite(BOT_COLOUR_HEX[colour])))]
  for (const view of Object.keys(BAKED_FACE_PX) as BakedFaceView[]) {
    for (const kind of BOT_KINDS) {
      for (const state of BAKED_FACE_STATES) {
        const add = (layer: BakedLayer) => faces.push({ kind, state, view, layer })
        for (const colour of BOT_COLOURS) add({ layer: 'body', colour })
        for (const eyes of BOT_EYES) {
          for (const white of kind === 'mousse' ? inks : [false]) add({ layer: 'eyes', eyes, white })
        }
        if (kind === 'mouse') add({ layer: 'whiskers' })
        for (const accessory of BOT_ACCESSORIES) if (accessory !== 'none') add({ layer: 'accessory', accessory })
      }
    }
  }
  return faces
}
