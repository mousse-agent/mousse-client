// Questions and approvals the computer is waiting on, answered like the desktop's
// ComposerQuestionModal: one question at a time, options as A/B/C choices, a typed answer,
// Back / Next / Submit, and dismiss. Answers use option ids, or the typed text.
import { useEffect, useState } from 'react'
import type { PendingQuestion, PendingQuestions, QuestionAnswers } from '../../connection/types'
import { Check, MessageQuestion, X } from './icons'
import { Spinner } from './ToolCards'

function initial(questions: PendingQuestion[]): QuestionAnswers {
  const answers: QuestionAnswers = {}
  for (const question of questions) answers[question.id] = question.allowMultiple ? [] : ''
  return answers
}

function answered(question: PendingQuestion, answer: string | string[] | undefined, custom: string | undefined): boolean {
  if (custom?.trim()) return true
  return question.allowMultiple ? Array.isArray(answer) && answer.length > 0 : typeof answer === 'string' && !!answer.trim()
}

/** Merges chosen options with typed answers, exactly like the desktop's resolveQuestionAnswers. */
export function resolveAnswers(questions: PendingQuestion[], answers: QuestionAnswers, customs: Record<string, string>): QuestionAnswers {
  const out: QuestionAnswers = {}
  for (const question of questions) {
    const custom = (customs[question.id] ?? '').trim()
    if (question.allowMultiple) {
      const chosen = Array.isArray(answers[question.id]) ? [...(answers[question.id] as string[])] : []
      if (custom) chosen.push(custom)
      out[question.id] = chosen
    } else out[question.id] = custom || (typeof answers[question.id] === 'string' ? (answers[question.id] as string) : '')
  }
  return out
}

const letter = (index: number) => String.fromCharCode(65 + (index % 26))

export interface QuestionPromptProps {
  pending: PendingQuestions
  onAnswer?: (requestId: string, answers: QuestionAnswers) => Promise<void>
  onDismiss?: (requestId: string) => Promise<void>
}

export function QuestionPrompt({ pending, onAnswer, onDismiss }: QuestionPromptProps) {
  const total = pending.questions.length
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<QuestionAnswers>(() => initial(pending.questions))
  const [customs, setCustoms] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setStep(0)
    setAnswers(initial(pending.questions))
    setCustoms({})
  }, [pending.requestId]) // eslint-disable-line react-hooks/exhaustive-deps

  const index = Math.min(step, Math.max(total - 1, 0))
  const question = pending.questions[index]
  if (!question) return null
  const isApproval = total === 1 && question.id === 'approval'
  const last = index >= total - 1
  const canAnswer = !!onAnswer

  const submit = async (values: QuestionAnswers) => {
    if (!onAnswer) return
    setBusy(true)
    try {
      await onAnswer(pending.requestId, values)
    } finally {
      setBusy(false)
    }
  }

  const choose = (optionId: string) => {
    if (question.allowMultiple) {
      setAnswers((current) => {
        const list = Array.isArray(current[question.id]) ? [...(current[question.id] as string[])] : []
        const at = list.indexOf(optionId)
        if (at >= 0) list.splice(at, 1)
        else list.push(optionId)
        return { ...current, [question.id]: list }
      })
    } else {
      setAnswers((current) => ({ ...current, [question.id]: current[question.id] === optionId ? '' : optionId }))
    }
  }

  const selected = (optionId: string) => {
    const value = answers[question.id]
    return Array.isArray(value) ? value.includes(optionId) : value === optionId
  }

  return (
    <section className="m-tl-question" data-testid="question-prompt" aria-label={isApproval ? 'Approval needed' : 'Questions from the computer'}>
      <header className="m-tl-question__header">
        <MessageQuestion size={16} />
        <span className="m-tl-question__title">{isApproval ? 'Approval needed' : 'Question'}</span>
        {total > 1 && (
          <span className="m-tl-question__steps" aria-label={`Question ${index + 1} of ${total}`}>
            {pending.questions.map((entry, at) => (
              <button
                key={entry.id}
                type="button"
                className={`m-tl-question__dot${at === index ? ' m-tl-question__dot--active' : ''}${answered(entry, answers[entry.id], customs[entry.id]) ? ' m-tl-question__dot--done' : ''}`}
                aria-label={`Question ${at + 1}`}
                onClick={() => setStep(at)}
              />
            ))}
            <span className="m-tl-question__count">{index + 1} of {total}</span>
          </span>
        )}
        {onDismiss && (
          <button type="button" className="m-tl-question__close" aria-label="Dismiss" disabled={busy} onClick={() => void onDismiss(pending.requestId)}>
            <X size={16} />
          </button>
        )}
      </header>
      <p className="m-tl-question__prompt">{question.prompt}</p>
      {isApproval ? (
        <div className="m-tl-question__approval">
          {question.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`m-tl-question__decide${/approve|allow|yes|accept/i.test(option.id + option.label) ? ' m-tl-question__decide--primary' : ''}`}
              disabled={!canAnswer || busy}
              onClick={() => void submit({ [question.id]: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <>
          {question.options.length > 0 && (
            <div className="m-tl-question__options" role={question.allowMultiple ? 'group' : 'radiogroup'}>
              {question.options.map((option, at) => (
                <button
                  key={option.id}
                  type="button"
                  role={question.allowMultiple ? 'checkbox' : 'radio'}
                  aria-checked={selected(option.id)}
                  className={`m-tl-question__option${selected(option.id) ? ' m-tl-question__option--on' : ''}`}
                  disabled={!canAnswer || busy}
                  onClick={() => choose(option.id)}
                >
                  <span className="m-tl-question__badge">{selected(option.id) ? <Check size={12} /> : letter(at)}</span>
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          )}
          <input
            className="m-tl-question__custom"
            type="text"
            placeholder={question.options.length ? 'Or type your own answer' : 'Type your answer'}
            value={customs[question.id] ?? ''}
            disabled={!canAnswer || busy}
            onChange={(event) => setCustoms((current) => ({ ...current, [question.id]: event.target.value }))}
          />
          <div className="m-tl-question__nav">
            {index > 0 && (
              <button type="button" className="m-tl-question__back" disabled={busy} onClick={() => setStep(index - 1)}>
                Back
              </button>
            )}
            {last ? (
              <button
                type="button"
                className="m-tl-question__submit"
                disabled={!canAnswer || busy || !pending.questions.every((entry) => answered(entry, answers[entry.id], customs[entry.id]))}
                onClick={() => void submit(resolveAnswers(pending.questions, answers, customs))}
              >
                {busy && <Spinner />}
                Send
              </button>
            ) : (
              <button type="button" className="m-tl-question__submit" disabled={busy} onClick={() => setStep(index + 1)}>
                Next
              </button>
            )}
          </div>
        </>
      )}
      {!canAnswer && <p className="m-tl-question__note">Answer this on the computer.</p>}
    </section>
  )
}
