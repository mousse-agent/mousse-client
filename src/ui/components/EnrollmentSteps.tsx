import type { EnrollmentProgress, EnrollmentStage } from '../../connection/types'
import { Check, CircleAlert } from './icons'
import { Spinner } from './primitives'

const STEPS: { stage: EnrollmentStage; label: string }[] = [
  { stage: 'requesting', label: 'Asking the computer' },
  { stage: 'waiting-approval', label: 'Approve on the computer' },
  { stage: 'connecting', label: 'Connecting securely' },
  { stage: 'done', label: 'Added' }
]

const FAILURES: Partial<Record<EnrollmentStage, string>> = {
  denied: 'The request was declined on the computer.',
  expired: 'The request expired before it was approved.',
  error: 'This phone could not be added.'
}

export function isEnrollmentFinished(progress: EnrollmentProgress | undefined): boolean {
  return !!progress && (progress.stage === 'done' || progress.stage in FAILURES)
}

/** Formats 482913 as "482 913" so it is easy to compare at a glance. */
function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

export function EnrollmentSteps({ progress, computerName }: { progress: EnrollmentProgress; computerName?: string }) {
  const failure = FAILURES[progress.stage]
  const currentIndex = STEPS.findIndex((step) => step.stage === progress.stage)
  const where = computerName ?? 'the computer'

  return (
    <div className="m-enroll" data-stage={progress.stage}>
      {progress.matchCode && !failure && progress.stage !== 'done' && (
        <div className="m-enroll__code">
          <p>Check that {where} shows the same code, then approve it there.</p>
          <output aria-label="Match code" data-testid="match-code">{formatCode(progress.matchCode)}</output>
        </div>
      )}
      {failure ? (
        <div className="m-notice m-notice--error" role="alert">
          <CircleAlert size={18} />
          <span>{progress.message ?? failure}</span>
        </div>
      ) : (
        <ol className="m-steps" aria-label="Progress">
          {STEPS.map((step, index) => {
            const state = index < currentIndex || progress.stage === 'done' ? 'done' : index === currentIndex ? 'current' : 'todo'
            return (
              <li key={step.stage} className="m-steps__item" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="m-steps__mark">
                  {state === 'done' ? <Check size={14} /> : state === 'current' ? <Spinner size={14} /> : null}
                </span>
                <span>{step.label === 'Approve on the computer' && computerName ? `Approve on ${computerName}` : step.label}</span>
              </li>
            )
          })}
        </ol>
      )}
      {progress.message && !failure && <p className="m-enroll__message">{progress.message}</p>}
    </div>
  )
}
