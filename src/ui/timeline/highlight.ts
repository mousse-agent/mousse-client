// Syntax highlighting for code blocks. highlight.js escapes the code it returns, so its HTML is
// safe to insert. Only common languages are bundled to keep the app small.
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGUAGES = { bash, c, cpp, css, diff, go, java, javascript, json, kotlin, markdown, python, rust, sql, swift, typescript, xml, yaml }
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language)
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx', 'mts'], { languageName: 'typescript' })
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['md'], { languageName: 'markdown' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['rs'], { languageName: 'rust' })
hljs.registerAliases(['kt'], { languageName: 'kotlin' })
hljs.registerAliases(['patch'], { languageName: 'diff' })

/** Highlighting above this size costs more than it helps on a phone. */
const MAX_HIGHLIGHT = 40_000

/** Highlighted HTML for known languages; undefined means "show plain text". */
export function highlightCode(code: string, language: string | undefined): string | undefined {
  const name = language?.trim().toLowerCase().split(/\s+/)[0]
  if (!name || code.length > MAX_HIGHLIGHT || !hljs.getLanguage(name)) return undefined
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
  } catch {
    return undefined
  }
}

/** Guesses a language from a file name, for diffs and file previews. */
export function languageForPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  if (!ext || ext === path.toLowerCase()) return undefined
  return hljs.getLanguage(ext) ? ext : undefined
}
