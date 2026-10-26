import { CircleX, Hourglass, MessageCircleQuestion, OctagonAlert, ShieldAlert, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { AttentionItem, AttentionKind, Severity } from '../../shared/contract'
import { useOcc } from '../state/store'

export const ATTENTION_ICON: Record<AttentionKind, LucideIcon> = {
  permission: ShieldAlert,
  question: MessageCircleQuestion,
  gate: OctagonAlert,
  error: CircleX,
  stalled: Hourglass,
  'failed-task': TriangleAlert,
}

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** High severity first, then oldest (longest waiting) first. */
export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.since - b.since || a.id.localeCompare(b.id))
}

/** Open the target of an attention item: the session, or run + task for orchestration items. */
export function openAttention(item: AttentionItem) {
  const st = useOcc.getState()
  if (item.sessionId && !item.taskId) { st.selectSession(item.sessionId); return }
  if (item.runId || item.taskId) {
    if (st.ui.selectedSessionId) st.selectSession(null)
    if (item.runId) st.selectRun(item.runId)
    if (item.taskId) st.selectTask(item.taskId)
    if (st.ui.view !== 'dag') st.setView('dag')
    return
  }
  if (item.sessionId) st.selectSession(item.sessionId)
}

/** Clear any selection so the dock shows the Attention panel. */
export function openAttentionPanel() {
  const st = useOcc.getState()
  st.selectSession(null)
  st.selectRun(null)
  st.selectTask(null)
}
