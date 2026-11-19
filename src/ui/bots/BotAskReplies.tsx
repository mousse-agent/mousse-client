// An open permission ask as quick replies under the bot's bubble, ported from
// mousse/src/renderer/components/bots/BotAskReplies.tsx.
import { useState } from 'react'
import type { BotAskCard } from '../../connection/bots'

export function BotAskReplies({ botName, ask, onAnswer }: {
  botName: string
  ask: BotAskCard
  /** Returns a refusal reason string if Allow was refused by the computer (e.g. "Allow this on the computer."). */
  onAnswer(answer: 'allow' | 'not_now'): Promise<string | undefined | void> | void
}) {
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState(false)
  const [refused, setRefused] = useState<string | undefined>()
  const answer = async (choice: 'allow' | 'not_now') => {
    setBusy(true)
    try {
      const why = await onAnswer(choice)
      if (choice === 'allow' && typeof why === 'string') setRefused(why)
    } finally {
      setBusy(false)
    }
  }
  const allowOff = ask.kind === 'export_memory'
    ? 'Answer this on the computer: it needs a folder there.'
    : ask.loading
      ? 'Its tools are still loading'
      : refused
  const more = Boolean(ask.note || ask.tip || ask.details?.items.length)
  return (
    <div className="bot-ask-replies" role="group" aria-label={`${botName} wants to ${ask.title}`}>
      <div className="bot-ask-buttons">
        <button type="button" className="is-primary" disabled={busy || allowOff !== undefined} title={allowOff} onClick={() => void answer('allow')}>Allow</button>
        <button type="button" disabled={busy} onClick={() => void answer('not_now')}>Not now</button>
        {more && <button type="button" aria-expanded={details} onClick={() => setDetails((open) => !open)}>Details</button>}
      </div>
      {allowOff && <p className="bot-ask-refusal" role="note">{allowOff}</p>}
      {details && (
        <div className="bot-ask-details">
          {ask.note && <p title={ask.tip}>{ask.note}</p>}
          {!ask.note && ask.tip && <p>{ask.tip}</p>}
          {ask.details && ask.details.items.length > 0 && <p>{ask.details.summary}: {ask.details.items.join(', ')}</p>}
          {ask.details?.more && <p>{ask.details.more}</p>}
        </div>
      )}
    </div>
  )
}
