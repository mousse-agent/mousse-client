// Expandable steps behind "Worked for …" / "Steps" under a bot reply, ported from
// mousse/src/renderer/components/bots/BotSteps.tsx.
import type { BotChip } from '../../connection/bots'
import { stepText } from './botChatShape'

export function BotSteps({ chips, onOpenThread }: {
  chips: readonly BotChip[]
  onOpenThread?(threadId: string): void
}) {
  if (!chips.length) return null
  return (
    <ul className="bot-steps">
      {chips.map((chip, index) => {
        const tip = chip.said ? `Sent: ${chip.said}` : chip.title
        return (
          <li key={`${index}:${chip.icon}:${chip.text}`} {...(tip ? { title: tip } : {})}>
            <span>{stepText(chip)}</span>
            {chip.thread && onOpenThread && (
              <button type="button" className="bot-step-open" onClick={() => onOpenThread(chip.thread!)}>
                Open
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
