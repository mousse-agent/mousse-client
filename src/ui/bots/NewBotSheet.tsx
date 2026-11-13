// New bot on the phone, after the desktop's NewBotDialog: a look already picked (one the owner's other
// bots don't wear), an optional name and one sentence. Create bot opens its chat at once.
import { useEffect, useState } from 'react'
import type { ComputerBots, ListBot } from '../../connection/bots'
import { Sheet } from '../components/Sheet'
import { Button, Notice, Spinner } from '../components/primitives'
import { BotLookPicker } from './face/BotLookPicker'
import { pickDistinctLook, type KnownBotLook } from './look'
import './bots.css'

export interface NewBotSheetProps {
  open: boolean
  /** The computer the bot is made on, named when the phone has more than one. */
  computerName?: string
  bots: ComputerBots | undefined
  existing: readonly ListBot[]
  onClose(): void
  onCreated(bot: ListBot): void
}

export function NewBotSheet({ open, computerName, bots, existing, onClose, onCreated }: NewBotSheetProps) {
  const [look, setLook] = useState<KnownBotLook>(() => pickDistinctLook(existing.map((bot) => bot.look)))
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (open) setError(undefined)
  }, [open])
  const ready = !!bots && description.trim().length > 0 && !busy
  const submit = async () => {
    if (!ready || !bots) return
    setBusy(true)
    setError(undefined)
    try {
      const trimmed = name.trim()
      const bot = await bots.create({ look, description: description.trim(), ...(trimmed ? { name: trimmed } : {}) })
      setName('')
      setDescription('')
      setLook(pickDistinctLook([...existing.map((entry) => entry.look), bot.look]))
      onCreated(bot)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not make the bot.')
    } finally {
      setBusy(false)
    }
  }
  const touched = !!(name.trim() || description.trim())
  return (
    <Sheet
      open={open}
      title={computerName ? `New bot on ${computerName}` : 'New bot'}
      onClose={onClose}
      dismissible={!busy && !touched}
      footer={
        <Button disabled={!ready} onClick={() => void submit()}>
          {busy ? <><Spinner size={14} /> Creating…</> : 'Create bot'}
        </Button>
      }
    >
      <form className="bot-new" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <BotLookPicker look={look} onChange={setLook} existingLooks={existing.map((bot) => bot.look)} />
        <label htmlFor="bot-new-name">Name</label>
        <input id="bot-new-name" maxLength={60} value={name} placeholder="Optional. Leave it empty and it names itself." onChange={(event) => setName(event.target.value)} />
        <label htmlFor="bot-new-text">What should it do?</label>
        <textarea id="bot-new-text" maxLength={500} value={description} placeholder="For example: every morning, tell me which emails need a reply." onChange={(event) => setDescription(event.target.value)} />
        <p className="bot-new__hint">Change anything later by asking it.</p>
        {!bots && <Notice tone="info">This computer is offline or its Mousse is too old for bots.</Notice>}
        {error && <Notice>{error}</Notice>}
      </form>
    </Sheet>
  )
}
