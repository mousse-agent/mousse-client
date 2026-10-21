import { useEffect, useState } from 'react'

type Highlighter = typeof import('./highlight')
let loaded: Highlighter | undefined
let loading: Promise<Highlighter> | undefined

function load(): Promise<Highlighter> {
  loading ??= import('./highlight').then((module) => (loaded = module))
  return loading
}

/** Highlighted HTML for the code once the highlighter has loaded; undefined means plain text. */
export function useHighlight(code: string, language: string | undefined): string | undefined {
  const [html, setHtml] = useState(() => (language ? loaded?.highlightCode(code, language) : undefined))
  useEffect(() => {
    if (!language) {
      setHtml(undefined)
      return
    }
    if (loaded) {
      setHtml(loaded.highlightCode(code, language))
      return
    }
    let live = true
    void load().then((module) => {
      if (live) setHtml(module.highlightCode(code, language))
    }, () => undefined)
    return () => {
      live = false
    }
  }, [code, language])
  return html
}

/** The file extension as a language hint for diffs; the highlighter ignores ones it does not know. */
export function languageForPath(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined
}
