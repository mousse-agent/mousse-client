// A bot's checklist button and bottom sheet, adapted from mousse/src/renderer/components/bots/BotTasksButton.tsx.
import type { BotTaskItem, BotTaskStatus } from '../../connection/bots'
import { Circle, CircleCheck, CircleDotDashed, CircleMinus, CircleX, RowTodo } from '../components/icons'
import { Sheet } from '../components/Sheet'
import { useBotChecklistHidden } from './botChecklistSetting'

const TASK_ICON: Record<BotTaskStatus, typeof Circle> = {
  pending: Circle,
  in_progress: CircleDotDashed,
  completed: CircleCheck,
  failed: CircleX,
  blocked: CircleMinus,
  skipped: CircleMinus,
  cancelled: CircleX,
}

const TASK_LABEL: Record<BotTaskStatus, string> = {
  pending: 'To do',
  in_progress: 'In progress',
  completed: 'Done',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
}

export function BotTasksButton({ botId, tasks, onOpen }: {
  botId: string
  tasks: readonly BotTaskItem[] | undefined
  onOpen(): void
}) {
  const hidden = useBotChecklistHidden(botId)
  if (!tasks?.length || hidden) return null
  const done = tasks.filter((task) => task.status === 'completed').length
  const progress = `${done} of ${tasks.length} done`
  return (
    <button
      type="button"
      className="bot-header-tasks"
      aria-label={`Checklist, ${progress}`}
      title={`Checklist · ${progress}`}
      onClick={onOpen}
    >
      <RowTodo size={15} aria-hidden />
      <span className="bot-header-tasks-count">{done}/{tasks.length}</span>
    </button>
  )
}

export function BotTasksSheet({ open, botName, tasks, onClose }: {
  open: boolean
  botName: string
  tasks: readonly BotTaskItem[] | undefined
  onClose(): void
}) {
  const list = tasks ?? []
  const done = list.filter((task) => task.status === 'completed').length
  return (
    <Sheet open={open} title={`${botName}’s checklist`} onClose={onClose}>
      <div className="bot-tasks-sheet">
        {list.length > 0 ? (
          <>
            <p className="bot-tasks-progress">{done} of {list.length} done</p>
            <ul className="bot-tasks-list">
              {list.map((task) => {
                const Icon = TASK_ICON[task.status] ?? Circle
                return (
                  <li key={task.id} className={`bot-tasks-item is-${task.status}`}>
                    <Icon size={16} aria-hidden />
                    <span className="bot-tasks-item__body">
                      <span className="m-sr-only">{TASK_LABEL[task.status]}: </span>
                      <span className="bot-tasks-item__text">{task.text}</span>
                      {task.note && <small className="bot-tasks-item__note">{task.note}</small>}
                    </span>
                  </li>
                )
              })}
            </ul>
          </>
        ) : (
          <p className="bot-about__empty">No tasks right now.</p>
        )}
      </div>
    </Sheet>
  )
}
