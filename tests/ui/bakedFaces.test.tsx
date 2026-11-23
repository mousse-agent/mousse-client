import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOT_ACCESSORIES, BOT_COLOURS, BOT_EYES, BOT_KINDS, type KnownBotLook } from '../../src/ui/bots/look'
import { BOT_FACE_STATES, BotFace } from '../../src/ui/bots/face/BotFace'
import { LazyBotFace } from '../../src/ui/bots/face/LazyBotFace'
import { allBakedFaces, BAKED_FACE_STATES, bakedFaceFile, bakedFaceLayers } from '../../src/ui/bots/face/bakedFaces'
import { MICE_FRAGMENT_SHADER } from '../../src/ui/bots/face/miceShader'
import { LIVE_FACES } from '../../src/ui/bots/face/liveFaces'
// @ts-expect-error A plain ES module without types.
import { layerShader } from '../../scripts/bake-bot-faces/layerShader.mjs'

// Tests run from the repository root.
const publicFaces = join(process.cwd(), 'public', 'bot-faces') + '/'

afterEach(() => vi.restoreAllMocks())

const files = (look: KnownBotLook, state: (typeof BOT_FACE_STATES)[number], view: 'head' | 'full', size: number) =>
  bakedFaceLayers(look, state, view, size).map(bakedFaceFile)

describe('baked bot faces', () => {
  it('are what the app shows by default', () => {
    expect(LIVE_FACES).toBe(false)
  })

  it('show a face as its pictures at once, with no loader and no WebGL', () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    const view = render(createElement(BotFace, { look: { colour: 'blue', accessory: 'glasses' }, state: 'working', size: 40, view: 'head', label: 'Inbox helper' }))
    const face = view.container.querySelector('.bot-face')!
    expect(face.getAttribute('aria-label')).toBe('Inbox helper')
    expect([...view.container.querySelectorAll<HTMLImageElement>('img.bot-face-layer')].map((img) => new URL(img.src).pathname)).toEqual([
      '/bot-faces/head/mouse-working-body-blue.webp',
      '/bot-faces/head/mouse-working-eyes-pill.webp',
      '/bot-faces/head/mouse-working-acc-glasses.webp'
    ])
    expect(view.container.querySelector('canvas')).toBeNull()
    expect(getContext).not.toHaveBeenCalled()
  })

  it('show the same pictures in lists', () => {
    const view = render(createElement(LazyBotFace, { look: { colour: 'pink', accessory: 'none' }, state: 'paused', size: 40, view: 'head' }))
    expect(view.container.querySelectorAll('img.bot-face-layer')).toHaveLength(2)
    expect(view.container.querySelector('.bot-face-z')).not.toBeNull()
  })

  it('fall back to the flat face when a picture does not load', () => {
    const view = render(createElement(BotFace, { look: { colour: 'green', accessory: 'cap' }, state: 'idle', size: 40, view: 'head' }))
    fireEvent.error(view.container.querySelector('img.bot-face-layer')!)
    expect(view.container.querySelector('img.bot-face-layer')).toBeNull()
    expect(view.container.querySelector('svg.bot-face-still')).not.toBeNull()
  })

  it('stack the mouse as body, eyes, whiskers from 56 px, accessory', () => {
    const look: KnownBotLook = { colour: 'coral', accessory: 'crown', eyes: 'star' }
    expect(files(look, 'idle', 'head', 40)).toEqual(['head/mouse-idle-body-coral.webp', 'head/mouse-idle-eyes-star.webp', 'head/mouse-idle-acc-crown.webp'])
    expect(files(look, 'idle', 'head', 60)).toEqual([
      'head/mouse-idle-body-coral.webp',
      'head/mouse-idle-eyes-star.webp',
      'head/mouse-idle-whiskers.webp',
      'head/mouse-idle-acc-crown.webp'
    ])
  })

  it('stack the Mousse as body, accessory, eyes, with eyes that contrast with its colour', () => {
    expect(files({ colour: 'yellow', accessory: 'cap', kind: 'mousse' }, 'happy', 'full', 104)).toEqual([
      'full/mousse-happy-body-yellow.webp',
      'full/mousse-happy-acc-cap.webp',
      'full/mousse-happy-eyes-pill.webp'
    ])
    expect(files({ colour: 'blue', accessory: 'none', kind: 'mousse', eyes: 'dot' }, 'idle', 'head', 40)).toEqual([
      'head/mousse-idle-body-blue.webp',
      'head/mousse-idle-eyes-dot-white.webp'
    ])
  })

  it('have a picture for every layer of every look, state and view', () => {
    expect(BAKED_FACE_STATES).toEqual(BOT_FACE_STATES)
    const baked = new Set(allBakedFaces().map(bakedFaceFile))
    const missing = [...baked].filter((file) => !existsSync(publicFaces + file))
    expect(missing).toEqual([])
    const asked = new Set<string>()
    for (const kind of BOT_KINDS) for (const colour of BOT_COLOURS) for (const accessory of BOT_ACCESSORIES) for (const eyes of BOT_EYES) {
      const look: KnownBotLook = { colour, accessory, ...(kind !== 'mouse' ? { kind } : {}), ...(eyes !== 'pill' ? { eyes } : {}) }
      for (const state of BOT_FACE_STATES) for (const view of ['head', 'full'] as const) for (const size of [40, 60]) for (const file of files(look, state, view, size)) asked.add(file)
    }
    expect([...asked].filter((file) => !baked.has(file))).toEqual([])
  })

  it('can be baked again from the current face shader', () => {
    const shader = layerShader(MICE_FRAGMENT_SHADER)
    expect(shader).toContain('uniform float uAcc,uL;')
  })
})
