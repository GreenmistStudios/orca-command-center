import { useOcc } from '../state/store'
import { EmptyState } from '../ui'
import { SessionInspector } from './SessionInspector'
import { TaskInspector } from './TaskInspector'

/** Right-dock inspector: a session (transcript/files/todos/info) or an orchestration task. Fills the dock. */
export function Inspector() {
  const taskId = useOcc((s) => s.ui.selectedTaskId)
  const sessionId = useOcc((s) => s.ui.selectedSessionId)
  if (taskId) return <TaskInspector key={taskId} taskId={taskId} />
  if (sessionId) return <SessionInspector key={sessionId} id={sessionId} />
  return <EmptyState title="Nothing selected" hint="Select a session or task to inspect it." />
}
