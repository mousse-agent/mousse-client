// A bot's question as quick replies under its bubble, ported from
// mousse/src/renderer/components/bots/BotQuestionReplies.tsx.
import { useState } from 'react'
import type { BotChatQuestion } from '../../connection/bots'
import { botGroupTime } from './messageGroups'

export function BotQuestionReplies({ question, onAnswer, onOther }: {
  question: BotChatQuestion
  /** Sends the tap; true once it went through. */
  onAnswer(choice: string): Promise<boolean>
  onOther(): void
}) {
  const [sending, setSending] = useState<string | undefined>()
  const waiting = question.status === 'open' || question.status === 'moved_on'
  if (question.nudge && !waiting) return null
  if (question.nudged && waiting) return null
  if (question.status === 'answered' && question.by === 'chat') {
    return <p className="bot-question-settled">{question.answer ? `Answered in chat: ${question.answer}` : 'Answered in chat'}</p>
  }
  if (question.status === 'withdrawn') return <p className="bot-question-settled">No longer needed</p>
  const defaulted = question.status === 'defaulted'
  const went = defaulted ? (question.answer ? `went with ${question.answer}` : 'went ahead') : ''
  if (defaulted && question.late) {
    return <p className="bot-question-settled">{`${went.charAt(0).toUpperCase()}${went.slice(1)} · you said ${question.late}`}</p>
  }
  if (!waiting && !defaulted) return null
  const tap = async (choice: string) => {
    if (sending !== undefined) return
    setSending(choice)
    try {
      if (!(await onAnswer(choice))) setSending(undefined)
    } catch {
      setSending(undefined)
    }
  }
  const detailed = question.choices.some((choice) => choice.detail)
  const goesAt = question.status === 'open' && question.default && question.defaultAt ? botGroupTime(question.defaultAt) : ''
  return (
    <div className={`bot-ask-replies bot-question-replies${detailed ? ' has-details' : ''}`} data-status={question.status}>
      {defaulted && <p className="bot-question-settled">{`No answer · ${went}`}</p>}
      <div className="bot-ask-buttons" role="group" aria-label="Answers">
        {question.choices.map((choice) => (
          <button
            key={choice.label}
            type="button"
            disabled={sending !== undefined}
            aria-pressed={sending === choice.label || undefined}
            title={choice.detail}
            onClick={() => void tap(choice.label)}
          >
            <span className="bot-question-label">{choice.label}</span>
            {choice.detail && <span className="bot-question-detail">{choice.detail}</span>}
          </button>
        ))}
        {question.other && (
          <button type="button" className="bot-question-other" disabled={sending !== undefined} onClick={onOther}>
            Other…
          </button>
        )}
      </div>
      {goesAt && <p className="bot-question-settled">{`Goes with ${question.default} at ${goesAt} if you don't answer`}</p>}
    </div>
  )
}
