// Markdown for replies, thoughts and plans, styled like the desktop's `an-md-*` rules
// (agent-elements/markdown.tsx). marked only tokenizes; every token renders as a React element,
// so raw HTML in a reply shows as text and never runs.
import { createContext, memo, useContext, useMemo, useState, type ReactNode } from 'react'
import { marked, type Token, type Tokens } from 'marked'
import { copyText, openLink, safeHref } from './actions'
import { useHighlight } from './useHighlight'
import { Check, Copy, TextWrap } from './icons'
import { MessageImage } from './ImageLightbox'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/** marked keeps entities as written; show them as the characters they name. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match
    }
    return ENTITIES[name.toLowerCase()] ?? match
  })
}

/** Characters that mean nothing to Markdown, so a backslash before one is part of the text. */
const LITERAL_AFTER_BACKSLASH = new Set(['/', '"', "'", '\\'])
/** ASCII punctuation: what Markdown lets a backslash escape. */
const ESCAPABLE = /[!-/:-@[-`{-~]/
/** The text before a backslash ends inside a drive path (`C:\…`) or a network path (`\\host\…`). */
const IN_PATH = /(?:^|[^\w\\])(?:[A-Za-z]:[\\/]?|\\\\[\w.$-])\S*$/
/** Math, where a backslash belongs to TeX: `\(`, `\[`, `\begin{` or a pair of `$`. Such a line is left as written. */
const MATH = /\\[([]|\\begin\{|\$[^$]*\$/

/**
 * Markdown drops the backslash of an escape in prose, so `/^a\/b$/` showed as `/^a/b$/`, `\\server` as `\server` and
 * `C:\me\.cache` as `C:\me.cache` (desktop markdown.tsx keepLiteralBackslashes). The backslash is kept before `/`,
 * `"`, `'` and `\`, and before any punctuation inside a drive or network path; `\*` and `\_` still escape. Code
 * spans, math and indented lines are left as written; fences never reach here.
 */
export function keepLiteralBackslashes(prose: string): string {
  if (!prose.includes('\\')) return prose
  let span = 0
  let math = false
  return prose
    .split('\n')
    .map((line) => {
      if (math || /^\s*\$\$/.test(line)) {
        if ((line.match(/\$\$/g)?.length ?? 0) % 2 === 1) math = !math
        return line
      }
      if (!line.trim()) span = 0
      if ((/^(?: {4}|\t)/.test(line) && !span) || MATH.test(line)) return line
      let out = ''
      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (char === '`') {
          let run = 1
          while (line[i + run] === '`') run++
          if (!span) span = run
          else if (run === span) span = 0
          out += line.slice(i, i + run)
          i += run - 1
          continue
        }
        if (char !== '\\' || span) {
          out += char
          continue
        }
        const next = line[i + 1]
        if (next === undefined) {
          out += char
          continue
        }
        const literal = LITERAL_AFTER_BACKSLASH.has(next) || (ESCAPABLE.test(next) && IN_PATH.test(line.slice(0, i)))
        if (!literal) out += char + next
        else if (next === '\\') out += '\\\\\\\\'
        else out += '\\\\' + next
        i++
      }
      return out
    })
    .join('\n')
}

/** The desktop's list clean-ups: "1." lines split by blank lines stay one list; 3+ newlines collapse. */
function prepare(source: string): string {
  const parts = source.split(/(^(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^(?:`{3,}|~{3,})[ \t]*$)/m)
  return parts
    .map((part, index) =>
      index % 2 ? part : keepLiteralBackslashes(part.replace(/\n{3,}/g, '\n\n').replace(/^(\s*\d+\.\s[^\n]*)\n\n(?=\s*\d+\.\s)/gm, '$1\n')),
    )
    .join('')
}

/**
 * A reply's code block (agent-ui.css): no frame, a light tint, the language in small mono at the top left, Wrap and
 * Copy at the top right. Long lines wrap; Wrap switches a block to one line per line with a horizontal scroll.
 */
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(true)
  const html = useHighlight(code, language)
  return (
    <div className="m-code" data-wrap={wrap ? undefined : 'off'}>
      <div className="m-code__header">
        <span className="m-code__lang">{language || 'text'}</span>
        <button type="button" className="m-code__copy" aria-label={wrap ? "Don't wrap lines" : 'Wrap lines'} aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>
          <TextWrap size={14} />
        </button>
        <button
          type="button"
          className="m-code__copy"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={() => {
            void copyText(code).then((ok) => {
              if (!ok) return
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {html !== undefined ? (
        <pre className="m-code__body hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
      ) : (
        <pre className="m-code__body"><code>{code}</code></pre>
      )}
    </div>
  )
}

/**
 * How a view draws the images in its Markdown, instead of loading them: the bot chat shows `data:` pictures and
 * leaves web images as links (bots/BotImages.tsx). Without one, an image opens large on a tap.
 */
export const MarkdownImageRenderer = createContext<((image: { src: string; alt?: string }) => ReactNode) | undefined>(undefined)

function ImageToken({ href, alt, title }: { href: string; alt: string; title?: string }) {
  const render = useContext(MarkdownImageRenderer)
  if (render) return <>{render({ src: href, alt })}</>
  const src = safeHref(href)
  // Images open large on a tap, as the desktop's MessageImage.
  return src && !src.startsWith('mailto:') ? <MessageImage src={src} alt={alt} title={title} /> : <>{alt}</>
}

function inline(tokens: Token[] | undefined, key = ''): ReactNode[] {
  return (tokens ?? []).map((token, index) => inlineToken(token, `${key}${index}`))
}

function inlineToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case 'text': {
      const text = token as Tokens.Text
      return text.tokens?.length ? <span key={key}>{inline(text.tokens, key)}</span> : decode(text.text)
    }
    case 'escape':
      return (token as Tokens.Escape).text
    case 'strong':
      return <strong key={key} className="m-md-strong">{inline((token as Tokens.Strong).tokens, key)}</strong>
    case 'em':
      return <em key={key}>{inline((token as Tokens.Em).tokens, key)}</em>
    case 'del':
      return <del key={key}>{inline((token as Tokens.Del).tokens, key)}</del>
    case 'codespan':
      return <code key={key} className="m-md-code">{decode((token as Tokens.Codespan).text)}</code>
    case 'br':
      return <br key={key} />
    case 'link': {
      const link = token as Tokens.Link
      if (link.href.toLowerCase().startsWith('mousse-file://')) {
        let path = link.text
        try {
          path = new URL(link.href).searchParams.get('path') ?? link.text
        } catch {
          // Keep the link text.
        }
        return <code key={key} className="m-md-code m-md-file" title={path}>{inline(link.tokens, key)}</code>
      }
      const href = safeHref(link.href)
      if (!href) return <span key={key}>{inline(link.tokens, key)}</span>
      return (
        <a
          key={key}
          className="m-md-link"
          href={href}
          title={link.title ?? undefined}
          onClick={(event) => {
            event.preventDefault()
            openLink(href)
          }}
        >
          {inline(link.tokens, key)}
        </a>
      )
    }
    case 'image': {
      const image = token as Tokens.Image
      return <ImageToken key={key} href={image.href} alt={image.text} title={image.title ?? undefined} />
    }
    case 'html': {
      const text = (token as Tokens.HTML).text
      return /^<br\s*\/?>$/i.test(text.trim()) ? <br key={key} /> : text
    }
    default:
      return 'text' in token && typeof token.text === 'string' ? decode(token.text) : null
  }
}

function block(token: Token, key: string): ReactNode {
  switch (token.type) {
    case 'space':
      return null
    case 'heading': {
      const heading = token as Tokens.Heading
      const level = Math.min(Math.max(heading.depth, 1), 4)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4'
      return <Tag key={key} className={`m-md-h m-md-h${level}`}>{inline(heading.tokens, key)}</Tag>
    }
    case 'paragraph':
      return <p key={key} className="m-md-p">{inline((token as Tokens.Paragraph).tokens, key)}</p>
    case 'text': {
      const text = token as Tokens.Text
      return <p key={key} className="m-md-p">{text.tokens ? inline(text.tokens, key) : decode(text.text)}</p>
    }
    case 'code': {
      const code = token as Tokens.Code
      return <CodeBlock key={key} code={code.text} language={code.lang || undefined} />
    }
    case 'blockquote':
      return <blockquote key={key} className="m-md-quote">{blocks((token as Tokens.Blockquote).tokens, key)}</blockquote>
    case 'hr':
      return <hr key={key} className="m-md-hr" />
    case 'list': {
      const list = token as Tokens.List
      const items = list.items.map((item, index) => (
        <li key={`${key}-${index}`} className={`m-md-li${item.task ? ' m-md-li--task' : ''}`}>
          {item.task && <input type="checkbox" checked={!!item.checked} readOnly disabled className="m-md-check" />}
          {item.loose ? blocks(item.tokens, `${key}-${index}`) : item.tokens.map((child, childIndex) => listChild(child, `${key}-${index}-${childIndex}`))}
        </li>
      ))
      return list.ordered ? (
        <ol key={key} className="m-md-ol" start={typeof list.start === 'number' && list.start !== 1 ? list.start : undefined}>{items}</ol>
      ) : (
        <ul key={key} className="m-md-ul">{items}</ul>
      )
    }
    case 'table': {
      const table = token as Tokens.Table
      const align = (index: number) => table.align[index] ?? undefined
      return (
        <div key={key} className="m-md-table-wrap">
          <table className="m-md-table">
            <thead>
              <tr>{table.header.map((cell, index) => <th key={index} style={{ textAlign: align(index) }}>{inline(cell.tokens, `${key}h${index}`)}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, index) => <td key={index} style={{ textAlign: align(index) }}>{inline(cell.tokens, `${key}r${rowIndex}c${index}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'html':
      return <p key={key} className="m-md-p m-md-raw">{(token as Tokens.HTML).text}</p>
    default:
      return 'text' in token && typeof token.text === 'string' ? <p key={key} className="m-md-p">{decode(token.text)}</p> : null
  }
}

/** Tight list items hold `text` tokens with inline children; render them without paragraph spacing. */
function listChild(token: Token, key: string): ReactNode {
  if (token.type === 'text') {
    const text = token as Tokens.Text
    return <span key={key}>{text.tokens ? inline(text.tokens, key) : decode(text.text)}</span>
  }
  return block(token, key)
}

function blocks(tokens: Token[], key = 'b'): ReactNode[] {
  return tokens.map((token, index) => block(token, `${key}.${index}`))
}

export interface MarkdownProps {
  text: string
  className?: string
  /** The live reply: blocks that appear in it fade in (timeline.css). */
  streaming?: boolean
}

export const Markdown = memo(function Markdown({ text, className = '', streaming }: MarkdownProps) {
  const tokens = useMemo(() => marked.lexer(prepare(text), { gfm: true, breaks: false }), [text])
  return <div className={`m-md ${className}`.trim()} data-streaming={streaming || undefined}>{blocks(tokens)}</div>
})
