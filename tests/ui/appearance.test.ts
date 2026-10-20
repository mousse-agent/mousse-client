import { describe, expect, it } from 'vitest'
import { buildAccentCssVars, mixHex, parseHex } from '../../src/ui/theme/accentPalette'
import { applyAppearance, MOUSSE_DARK_SURFACES } from '../../src/ui/theme/appearance'

describe('accent palette (ported from the desktop)', () => {
  it('parses and mixes hex colours', () => {
    expect(parseHex('#a785c7')).toEqual({ r: 167, g: 133, b: 199 })
    expect(parseHex('nope')).toBeNull()
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('derives the accent variables from the chosen colour', () => {
    const vars = buildAccentCssVars('#a785c7')
    expect(vars['--accent']).toBe('#a785c7')
    expect(vars['--accent-rgb']).toBe('167, 133, 199')
    expect(buildAccentCssVars('bad')).toEqual({})
  })
})

describe('applyAppearance', () => {
  it('applies mousse dark with the fixed surfaces over the accent pass', () => {
    const root = document.createElement('html')
    expect(applyAppearance({ theme: 'mousse-dark', accentColor: '#5b8def' }, root)).toBe('blacksphere-plus')
    expect(root.dataset.theme).toBe('blacksphere-plus')
    expect(root.style.getPropertyValue('--accent')).toBe('#5b8def')
    expect(root.style.getPropertyValue('--surface-base')).toBe(MOUSSE_DARK_SURFACES['--surface-base'])
  })
})
