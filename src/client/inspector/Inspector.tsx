import { useOcc } from '../state/store'
import { selectSelectedSession } from '../state/selectors'
import { EmptyState } from '../ui/EmptyState'

/** PLACEHOLDER — Task-11 replaces this with the Inspector. Fills the dock (the dock provides the panel chrome). */
export function Inspector() {
  const session = useOcc(selectSelectedSession)
  const taskId = useOcc((s) => s.ui.selectedTaskId)
  return (
    <EmptyState title="Inspector — Task-11" hint={taskId ? `Task ${taskId}` : session ? `${session.title} (${session.id})` : undefined} />
  )
}
