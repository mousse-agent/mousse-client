// Full Memory sheet for a bot (lazy-loaded), ported from mousse/src/renderer/components/bots/BotMemoryDialog.tsx:
// search, split into "Your wishes" and "<Name>'s notes", dates, inline Edit (bots.memory.edit),
// Forget with inline confirm (bots.memory.forget), and "Ask <Name> about this".
import { useEffect, useMemo, useRef, useState } from 'react'
import { isBotsUnsupported, type BotMemoryItem, type ComputerBots, type ListBot } from '../../connection/bots'
import { SearchField } from '../components/primitives'
import { Sheet } from '../components/Sheet'

const NO_ENTRIES: BotMemoryItem[] = []

/** The owner's wishes (`owner`) and the bot's own notes (`note`, `run_note`). */
export function memorySplit(entries: readonly BotMemoryItem[]): { wishes: BotMemoryItem[]; notes: BotMemoryItem[] } {
  return { wishes: entries.filter((entry) => entry.kind === 'owner'), notes: entries.filter((entry) => entry.kind !== 'owner') }
}

/** "3 wishes · 5 notes", leaving out an empty side; "Nothing yet" for none. */
export function memorySplitText(entries: readonly BotMemoryItem[]): string {
  const { wishes, notes } = memorySplit(entries)
  const parts = [
    wishes.length ? `${wishes.length} ${wishes.length === 1 ? 'wish' : 'wishes'}` : '',
    notes.length ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing yet'
}

function shortDate(at: string | undefined, now = new Date()): string {
  if (!at) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

function matchesFocus(entry: BotMemoryItem, focus: string): boolean {
  const head = focus.replace(/…$/, '').trim().toLowerCase()
  return Boolean(head) && entry.text.replace(/\s+/g, ' ').toLowerCase().startsWith(head)
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

function MemoryEntryRow({ bot, entry, focused, canEdit, onEdit, onForget, onAsk }: {
  bot: ListBot
  entry: BotMemoryItem
  focused: boolean
  canEdit: boolean
  onEdit(entry: BotMemoryItem, text: string): Promise<string | undefined>
  onForget(entry: BotMemoryItem): Promise<string | undefined>
  onAsk?(text: string): void
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'forget'>('view')
  const [words, setWords] = useState(entry.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const row = useRef<HTMLLIElement>(null)

  useEffect(() => { if (focused) row.current?.scrollIntoView?.({ block: 'center' }) }, [focused])
  useEffect(() => { if (mode !== 'edit') setWords(entry.text) }, [entry.text, mode])

  const save = async () => {
    const text = words.trim()
    if (!text || text === entry.text) { setMode('view'); return }
    setBusy(true)
    setError(undefined)
    const failed = await onEdit(entry, text)
    setBusy(false)
    if (failed) setError(failed)
    else setMode('view')
  }

  const forget = async () => {
    setBusy(true)
    setError(undefined)
    const failed = await onForget(entry)
    if (failed) { setBusy(false); setError(failed) }
  }

  const date = shortDate(entry.learnedAt)
  return (
    <li ref={row} className={`bot-memory-entry${focused ? ' is-focused' : ''}${mode !== 'view' ? ' is-open' : ''}`} data-memory-id={entry.id}>
      {mode === 'edit' ? (
        <textarea
          className="bot-memory-edit"
          aria-label="Memory text"
          value={words}
          disabled={busy}
          autoFocus
          onChange={(event) => setWords(event.target.value)}
        />
      ) : (
        <p className="bot-memory-text">{entry.text}</p>
      )}
      <div className="bot-memory-foot">
        {date && <time className="bot-memory-date" dateTime={entry.learnedAt}>{date}</time>}
        {mode === 'view' && (
          <span className="bot-memory-actions">
            {canEdit && <button type="button" onClick={() => { setMode('edit'); setError(undefined) }}>Edit</button>}
            <button type="button" onClick={() => { setMode('forget'); setError(undefined) }}>Forget</button>
            {onAsk && (
              <button type="button" onClick={() => onAsk(entry.text)}>
                Ask {bot.name}
              </button>
            )}
          </span>
        )}
        {mode === 'edit' && (
          <span className="bot-memory-actions">
            <button type="button" disabled={busy} onClick={() => { setMode('view'); setError(undefined) }}>Cancel</button>
            <button type="button" className="is-strong" disabled={busy || !words.trim()} onClick={() => void save()}>Save</button>
          </span>
        )}
        {mode === 'forget' && (
          <span className="bot-memory-actions" role="group" aria-label="Forget this?">
            <span className="bot-memory-ask">Forget this?</span>
            <button type="button" disabled={busy} onClick={() => setMode('view')}>Cancel</button>
            <button type="button" className="is-danger" disabled={busy} onClick={() => void forget()}>Forget</button>
          </span>
        )}
      </div>
      {error && <p className="bot-memory-error" role="alert">{error}</p>}
    </li>
  )
}

function MemoryGroup({ bot, title, entries, focus, canEdit, onEdit, onForget, onAsk }: {
  bot: ListBot
  title: string
  entries: BotMemoryItem[]
  focus?: string
  canEdit: boolean
  onEdit(entry: BotMemoryItem, text: string): Promise<string | undefined>
  onForget(entry: BotMemoryItem): Promise<string | undefined>
  onAsk?(text: string): void
}) {
  if (!entries.length) return null
  return (
    <section className="bot-memory-group" aria-label={title}>
      <h3>{title} · {entries.length}</h3>
      <ul>
        {entries.map((entry) => (
          <MemoryEntryRow
            key={entry.id}
            bot={bot}
            entry={entry}
            canEdit={canEdit}
            focused={Boolean(focus) && matchesFocus(entry, focus!)}
            onEdit={onEdit}
            onForget={onForget}
            onAsk={onAsk}
          />
        ))}
      </ul>
    </section>
  )
}

export function BotMemorySheet({ open, bot, bots, focus, onClose, onAskAbout }: {
  open: boolean
  bot: ListBot
  bots: ComputerBots
  focus?: string
  onClose(): void
  onAskAbout?(text: string): void
}) {
  const [entries, setEntries] = useState<BotMemoryItem[]>()
  const [error, setError] = useState<string>()
  const [unsupported, setUnsupported] = useState(false)
  const [editUnsupported, setEditUnsupported] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) return
    setQuery('')
    let live = true
    bots.memory(bot.id).then(
      (value) => { if (live) { setEntries(value); setError(undefined); setUnsupported(false) } },
      (failure) => {
        if (!live) return
        if (isBotsUnsupported(failure)) setUnsupported(true)
        else setError(errorText(failure))
      },
    )
    return () => { live = false }
  }, [open, bot.id, bots])

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase()
    const all = [...(entries ?? NO_ENTRIES)].reverse()
    return memorySplit(words ? all.filter((entry) => entry.text.toLowerCase().includes(words)) : all)
  }, [entries, query])

  const handleEdit = async (entry: BotMemoryItem, text: string): Promise<string | undefined> => {
    if (!bots.editMemory) { setEditUnsupported(true); return 'Update Mousse on the computer to edit memory here.' }
    try {
      const updated = await bots.editMemory(bot.id, entry.ref ?? entry.id, text)
      setEntries((current) => current?.map((item) => (item.id === entry.id ? (updated ?? { ...item, text }) : item)))
      return undefined
    } catch (failure) {
      if (isBotsUnsupported(failure)) {
        setEditUnsupported(true)
        return 'Update Mousse on the computer to edit memory here.'
      }
      return errorText(failure)
    }
  }

  const handleForget = async (entry: BotMemoryItem): Promise<string | undefined> => {
    try {
      await bots.forgetMemory(bot.id, entry.id)
      setEntries((current) => current?.filter((item) => item.id !== entry.id))
      return undefined
    } catch (failure) {
      return errorText(failure)
    }
  }

  const target = query ? undefined : focus
  const canEdit = Boolean(bots.editMemory) && !editUnsupported
  const none = !shown.wishes.length && !shown.notes.length

  return (
    <Sheet open={open} title={`${bot.name}’s memory`} onClose={onClose}>
      <div className="bot-memory-sheet">
        {unsupported ? (
          <p className="bot-about__empty">Update Mousse on the computer to see what {bot.name} remembers here.</p>
        ) : (
          <>
            <SearchField value={query} onChange={setQuery} placeholder="Search memory" />
            <div className="bot-memory-list">
              <MemoryGroup
                bot={bot}
                title="Your wishes"
                entries={shown.wishes}
                focus={target}
                canEdit={canEdit}
                onEdit={handleEdit}
                onForget={handleForget}
                onAsk={onAskAbout ? (text) => { onClose(); onAskAbout(text) } : undefined}
              />
              <MemoryGroup
                bot={bot}
                title={`${bot.name}’s notes`}
                entries={shown.notes}
                focus={target}
                canEdit={canEdit}
                onEdit={handleEdit}
                onForget={handleForget}
                onAsk={onAskAbout ? (text) => { onClose(); onAskAbout(text) } : undefined}
              />
              {none && (
                <p className="bot-about__empty">
                  {!entries ? (error ?? 'Loading…') : query.trim() ? 'Nothing matches.' : 'Nothing yet. Tell it what to remember.'}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Sheet>
  )
}
