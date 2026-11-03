/** The name this phone gives itself when it joins the user's computers: the model, or the kind of device. */
export function defaultDeviceName(agent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/iPhone/.test(agent)) return 'iPhone'
  if (/iPad/.test(agent)) return 'iPad'
  const android = /Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(agent)
  // Android WebViews with a reduced user agent report the model as "K".
  if (android?.[1] && android[1].trim() !== 'K') return android[1].trim()
  if (/Android/.test(agent)) return 'Android phone'
  return 'Phone'
}
