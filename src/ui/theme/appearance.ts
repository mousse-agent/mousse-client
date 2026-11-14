// Applies a theme and accent to <html>, mirroring mousse/src/renderer/hooks/useTheme.ts:
// accent variables from buildAccentCssVars() go inline first, then the fixed
// mousse dark surfaces (mousse/src/shared/themeSurfaces.ts) or the light
// surface slots override them. The phone has no acrylic, so glass variables
// stay owned by the theme CSS in tokens.css.
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { buildAccentCssVars, parseHex } from './accentPalette'

export type ThemePreference = 'mousse-dark' | 'light' | 'system'
/** The value written to html[data-theme]; names match the desktop theme ids. */
export type ThemeId = 'blacksphere-plus' | 'light'

export interface Appearance {
  theme: ThemePreference
  accentColor: string
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'mousse-dark', accentColor: '#a785c7' }

/** Same list as ACCENT_COLORS in mousse/src/shared/settings.ts. */
export const ACCENT_COLORS = [
  { id: 'purple', label: 'Purple', value: '#a785c7' },
  { id: 'violet', label: 'Violet', value: '#8a66b6' },
  { id: 'indigo', label: 'Indigo', value: '#6b5b95' },
  { id: 'blue', label: 'Blue', value: '#5b8def' },
  { id: 'cyan', label: 'Cyan', value: '#4ecdc4' },
  { id: 'teal', label: 'Teal', value: '#3d9970' },
  { id: 'green', label: 'Green', value: '#7ec99a' },
  { id: 'amber', label: 'Amber', value: '#d4b06a' },
  { id: 'rose', label: 'Rose', value: '#e07a8a' },
  { id: 'coral', label: 'Coral', value: '#e8927c' },
  { id: 'pink', label: 'Pink', value: '#d486b8' },
  { id: 'slate', label: 'Slate', value: '#8892a6' }
] as const

/** FIXED_SURFACE_THEMES['blacksphere-plus'] from mousse/src/shared/themeSurfaces.ts. */
export const MOUSSE_DARK_SURFACES: Record<string, string> = {
  '--surface-base': '#000000',
  '--surface-strong': '#000000',
  '--surface-soft': '#121212',
  '--surface-muted': '#050505',
  '--surface-elevated': '#1a1a1a',
  '--surface-base-rgb': '0, 0, 0',
  '--surface-strong-rgb': '0, 0, 0',
  '--surface-soft-rgb': '18, 18, 18',
  '--surface-muted-rgb': '5, 5, 5',
  '--surface-elevated-rgb': '26, 26, 26',
  '--floating-surface': '#121212',
  '--text-primary': '#e6e6e6',
  '--text-secondary': 'rgba(230, 230, 230, 0.68)',
  '--border': 'rgba(255, 255, 255, 0.14)'
}

/** LIGHT_SURFACE_VARS from mousse/src/renderer/hooks/useTheme.ts. */
const LIGHT_SURFACE_VARS: Record<string, string> = {
  '--surface-base': 'var(--surface-light-base)',
  '--surface-strong': 'var(--surface-light-strong)',
  '--surface-soft': 'var(--surface-light-soft)',
  '--surface-muted': 'var(--surface-light-soft)',
  '--surface-elevated': '#ffffff',
  '--surface-base-rgb': 'var(--surface-light-base-rgb)',
  '--surface-strong-rgb': 'var(--surface-light-strong-rgb)',
  '--surface-soft-rgb': 'var(--surface-light-soft-rgb)',
  '--surface-muted-rgb': 'var(--surface-light-soft-rgb)',
  '--surface-elevated-rgb': '255, 255, 255'
}

const THEME_OWNED_VARS = [
  '--glass-bg', '--glass-bg-strong', '--glass-bg-soft', '--terminal-bg',
  '--gradient-surface', '--gradient-glow', '--text-primary', '--text-secondary',
  '--floating-surface', '--border'
]

const STORAGE_KEY = 'mousse.appearance'

/** The dark and light inks an icon on a solid accent fill can take. */
export const ACCENT_INKS = { dark: '#15121b', light: '#ffffff' } as const

function luminance(hex: string): number {
  const rgb = parseHex(hex)
  if (!rgb) return 0
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/** WCAG contrast ratio of two colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The ink for an icon drawn on the accent itself (the home dock's create button): whichever of the
 * dark and light inks stands out more. The fill is the accent in every theme, so the theme does not change it.
 */
export function accentInk(accent: string): string {
  return contrastRatio(accent, ACCENT_INKS.dark) >= contrastRatio(accent, ACCENT_INKS.light) ? ACCENT_INKS.dark : ACCENT_INKS.light
}

export function loadAppearance(): Appearance {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_APPEARANCE
    const parsed = JSON.parse(raw) as Partial<Appearance>
    const theme = parsed.theme === 'light' || parsed.theme === 'system' ? parsed.theme : 'mousse-dark'
    const accentColor = typeof parsed.accentColor === 'string' && /^#[\da-f]{6}$/i.test(parsed.accentColor)
      ? parsed.accentColor : DEFAULT_APPEARANCE.accentColor
    return { theme, accentColor }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

export function saveAppearance(appearance: Appearance): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(appearance)) } catch { /* private mode */ }
}

export function resolveTheme(preference: ThemePreference): ThemeId {
  if (preference === 'light') return 'light'
  if (preference === 'system' && typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light'
  return 'blacksphere-plus'
}

export function applyAppearance(appearance: Appearance, root: HTMLElement = document.documentElement): ThemeId {
  const theme = resolveTheme(appearance.theme)
  root.setAttribute('data-theme', theme)
  for (const [name, value] of Object.entries(buildAccentCssVars(appearance.accentColor))) {
    root.style.setProperty(name, value)
  }
  root.style.setProperty('--accent-ink', accentInk(appearance.accentColor))
  for (const name of THEME_OWNED_VARS) root.style.removeProperty(name)
  const surfaces = theme === 'light' ? LIGHT_SURFACE_VARS : MOUSSE_DARK_SURFACES
  for (const [name, value] of Object.entries(surfaces)) root.style.setProperty(name, value)
  void syncNativeChrome(theme)
  return theme
}

/** Status bar and browser chrome follow the canvas colour. */
async function syncNativeChrome(theme: ThemeId): Promise<void> {
  const color = theme === 'light' ? '#f4eef8' : '#000000'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
  if (!Capacitor.isNativePlatform()) return
  try {
    await StatusBar.setStyle({ style: theme === 'light' ? Style.Light : Style.Dark })
    if (Capacitor.getPlatform() === 'android') await StatusBar.setBackgroundColor({ color })
  } catch {
    /* The status bar plugin is optional on some devices. */
  }
}
