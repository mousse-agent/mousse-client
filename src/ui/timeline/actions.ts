// Side effects the timeline needs: copying text and opening links outside the app.
import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the textarea copy.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

/** Links the phone may open: web pages and mail. Anything else stays text. */
export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  try {
    const url = new URL(href)
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export function openLink(href: string): void {
  if (href.startsWith('mailto:')) {
    window.location.href = href
    return
  }
  if (Capacitor.isNativePlatform()) void Browser.open({ url: href }).catch(() => undefined)
  else window.open(href, '_blank', 'noopener,noreferrer')
}
