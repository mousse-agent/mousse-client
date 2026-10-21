import { createContext, useContext } from 'react'

export interface TimelineActions {
  /** Sends the plan approval, like the desktop plan card's Approve. Missing when sending is not possible. */
  approvePlan?: (markdown: string) => Promise<void>
  /** Whether a turn is running, which hides Approve. */
  busy: boolean
  /** Plan item ids already approved by a later message. */
  approvedPlans: ReadonlySet<string>
}

export const TimelineActionsContext = createContext<TimelineActions>({ busy: false, approvedPlans: new Set() })

export const useTimelineActions = (): TimelineActions => useContext(TimelineActionsContext)

/** The desktop plan card's approval message. */
export function planApprovalText(markdown: string): string {
  const trimmed = markdown.trim()
  return trimmed
    ? `The implementation plan is approved. Implement it now, following the plan:\n\n${markdown}`
    : 'The implementation plan is approved. Implement it now.'
}

export const PLAN_APPROVAL_PREFIX = 'The implementation plan is approved.'
