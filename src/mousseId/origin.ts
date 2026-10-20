// The one place the Mousse ID API origin enters the app. Builds set VITE_MOUSSE_ID_ORIGIN; there is
// deliberately no default, so a build without it shows "no Mousse ID server configured".
import { checkedOrigin } from './http'

export const MOUSSE_ID_ORIGIN: string | undefined = import.meta.env?.VITE_MOUSSE_ID_ORIGIN || undefined

/** The configured origin, validated. Throws `not_configured` when the build has none. */
export function mousseIdOrigin(): string {
  return checkedOrigin(MOUSSE_ID_ORIGIN)
}
