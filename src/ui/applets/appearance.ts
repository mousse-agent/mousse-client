// The phone's look for applets, read like the desktop's renderer/components/applets/appearance.ts:
// only the allowed tokens, resolved to plain values, with solid surfaces for the backgrounds.
import { APPLET_APPEARANCE_TOKENS, validateAppletAppearance, type AppletAppearance } from './appletAppearance'
import { DEFAULT_APPLET_APPEARANCE } from './appletAppearanceStyles'

export function readAppletAppearance(): AppletAppearance {
  try {
    const root = document.documentElement
    const style = getComputedStyle(root)
    const body = getComputedStyle(document.body ?? root)
    const resolve = (name: string): string => {
      let value = style.getPropertyValue(name).trim()
      for (let pass = 0; pass < 8 && value.includes('var('); pass++) {
        const next = value.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_match, key: string, fallback?: string) => style.getPropertyValue(key).trim() || fallback?.trim() || '')
        if (next === value) break
        value = next
      }
      return value
    }
    const tokens: AppletAppearance['tokens'] = {}
    for (const name of APPLET_APPEARANCE_TOKENS) {
      const value = resolve(name)
      if (value && !value.includes('var(')) tokens[name] = value
    }
    const solid = { '--bg-primary': '--surface-base', '--bg-secondary': '--surface-strong', '--bg-tertiary': '--surface-soft' } as const
    for (const [background, surface] of Object.entries(solid)) {
      const value = tokens[surface as keyof typeof tokens]
      if (value) tokens[background as keyof typeof tokens] = value
      else delete tokens[background as keyof typeof tokens]
    }
    const theme = root.dataset.theme ?? 'dark'
    const safe = (value: string) => (value && !/[<>;{}@]/.test(value) ? value : '')
    return validateAppletAppearance({
      theme: /^[a-z0-9-]{1,40}$/.test(theme) ? theme : 'dark',
      colorScheme: theme === 'light' ? 'light' : 'dark',
      fontFamily: safe(body.fontFamily) || 'system-ui, sans-serif',
      fontSize: safe(body.fontSize) || '14px',
      reducedMotion: !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
      // A value the applet would refuse drops out rather than failing the whole appearance.
      tokens: Object.fromEntries(Object.entries(tokens).filter(([, value]) => value.length <= 512 && !/[<>;{}@\u0000-\u001f]|url\s*\(|expression\s*\(/i.test(value))),
    })
  } catch {
    return DEFAULT_APPLET_APPEARANCE
  }
}
