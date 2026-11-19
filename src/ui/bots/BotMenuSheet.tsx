// Bot menu, Rename and Change look sheets on the phone (adapted from mousse/src/renderer/components/bots/BotMenu.tsx
// and BotDialogs.tsx). Used from the bot chat header and by press-and-hold on a bot row in the Chats tab.
import { useEffect, useState } from 'react'
import { isBotsUnsupported, type BotLook, type ComputerBots, type ListBot } from '../../connection/bots'
import { Eye, EyeOff, Image as ImageIcon, Info, Pause, Pencil, Play, Search } from '../components/icons'
import { Button, Field, Notice, Spinner } from '../components/primitives'
import { Sheet } from '../components/Sheet'
import { setBotChecklistHidden, useBotChecklistHidden } from './botChecklistSetting'
import { BotLookPicker } from './face/BotLookPicker'

export type BotMenuView = 'menu' | 'rename' | 'look'

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

export function BotMenuSheet({ open, initialView = 'menu', bot, bots, existing = [], onClose, onAbout, onFind }: {
  open: boolean
  initialView?: BotMenuView
  bot: ListBot
  bots?: ComputerBots
  existing?: readonly ListBot[]
  onClose(): void
  onAbout?(): void
  onFind?(): void
}) {
  const [view, setView] = useState<BotMenuView>(initialView)
  const [name, setName] = useState(bot.name)
  const [look, setLook] = useState<BotLook>(bot.look)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const checklistHidden = useBotChecklistHidden(bot.id)

  useEffect(() => {
    if (!open) return
    setView(initialView)
    setName(bot.name)
    setLook(bot.look)
    setError(undefined)
    setBusy(false)
  }, [open, initialView, bot.id, bot.name, bot.look])

  const paused = bot.state === 'paused'
  const canUpdate = Boolean(bots?.update)
  const close = () => { if (!busy) onClose() }

  const togglePause = async () => {
    if (!bots || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await (paused ? bots.resume(bot.id) : bots.pause(bot.id))
      onClose()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const saveRename = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setError('Write a name first.'); return }
    if (trimmed === bot.name) { onClose(); return }
    if (!bots?.update) { setError('Update Mousse on the computer to rename bots from your phone.'); return }
    setBusy(true)
    setError(undefined)
    try {
      await bots.update(bot.id, { name: trimmed })
      onClose()
    } catch (failure) {
      setError(isBotsUnsupported(failure) ? 'Update Mousse on the computer to rename bots from your phone.' : errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const saveLook = async () => {
    if (!bots?.update) { setError('Update Mousse on the computer to change looks from your phone.'); return }
    setBusy(true)
    setError(undefined)
    try {
      await bots.update(bot.id, { look })
      onClose()
    } catch (failure) {
      setError(isBotsUnsupported(failure) ? 'Update Mousse on the computer to change looks from your phone.' : errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const title = view === 'rename' ? 'Rename' : view === 'look' ? 'Change look' : bot.name

  return (
    <Sheet open={open} title={title} onClose={close} dismissible={!busy}>
      {view === 'menu' && (
        <div className="m-options" role="menu" aria-label={`${bot.name} menu`}>
          {onAbout && (
            <button type="button" role="menuitem" className="m-option m-thread-option" onClick={() => { onClose(); onAbout() }}>
              <span className="m-option__leading"><Info size={16} /></span>
              <span className="m-option__body"><span className="m-option__title">About this bot</span></span>
            </button>
          )}
          {onFind && (
            <button type="button" role="menuitem" className="m-option m-thread-option" onClick={() => { onClose(); onFind() }}>
              <span className="m-option__leading"><Search size={16} /></span>
              <span className="m-option__body"><span className="m-option__title">Find in chat</span></span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="m-option m-thread-option"
            onClick={() => { setBotChecklistHidden(bot.id, !checklistHidden); onClose() }}
          >
            <span className="m-option__leading">{checklistHidden ? <Eye size={16} /> : <EyeOff size={16} />}</span>
            <span className="m-option__body"><span className="m-option__title">{checklistHidden ? 'Show checklist' : 'Hide checklist'}</span></span>
          </button>
          {canUpdate && (
            <>
              <button type="button" role="menuitem" className="m-option m-thread-option" onClick={() => { setError(undefined); setView('rename') }}>
                <span className="m-option__leading"><Pencil size={16} /></span>
                <span className="m-option__body"><span className="m-option__title">Rename</span></span>
              </button>
              <button type="button" role="menuitem" className="m-option m-thread-option" onClick={() => { setError(undefined); setView('look') }}>
                <span className="m-option__leading"><ImageIcon size={16} /></span>
                <span className="m-option__body"><span className="m-option__title">Change look</span></span>
              </button>
            </>
          )}
          {bots && (
            <button type="button" role="menuitem" className="m-option m-thread-option" disabled={busy} onClick={() => void togglePause()}>
              <span className="m-option__leading">{busy ? <Spinner size={16} /> : paused ? <Play size={16} /> : <Pause size={16} />}</span>
              <span className="m-option__body"><span className="m-option__title">{paused ? 'Resume' : 'Pause'}</span></span>
            </button>
          )}
          {error && <Notice>{error}</Notice>}
        </div>
      )}

      {view === 'rename' && (
        <form className="m-form" onSubmit={(event) => { event.preventDefault(); void saveRename() }}>
          <Field label="Name">
            <input
              className="m-input"
              aria-label="Bot name"
              autoFocus
              maxLength={60}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {error && <Notice>{error}</Notice>}
          <div className="m-sheet__actions">
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {busy ? <><Spinner size={14} /> Saving…</> : 'Save'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
          </div>
        </form>
      )}

      {view === 'look' && (
        <div className="m-form">
          <BotLookPicker
            look={look}
            onChange={setLook}
            existingLooks={existing.filter((entry) => entry.id !== bot.id).map((entry) => entry.look)}
          />
          {error && <Notice>{error}</Notice>}
          <div className="m-sheet__actions">
            <Button variant="primary" disabled={busy} onClick={() => void saveLook()}>
              {busy ? <><Spinner size={14} /> Saving…</> : 'Save'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
          </div>
        </div>
      )}
    </Sheet>
  )
}
