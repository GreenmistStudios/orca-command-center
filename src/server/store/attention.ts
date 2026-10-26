import type {
  ActivityEvent,
  AttentionItem,
  EpochMs,
  OrchRunDetail,
  SessionSummary,
  Severity,
} from '../../shared/contract.js'
import type { Thresholds } from './state.js'

export interface AttentionInput {
  sessions: readonly SessionSummary[]
  /** Session ids whose transcript is "working" but silent for stalledMs. */
  stalled: ReadonlySet<string>
  runs: readonly OrchRunDetail[]
  /** Recent tool-error events per session (already limited to the last 10 min by the caller). */
  toolErrors: ReadonlyMap<string, ActivityEvent[]>
  /** Latest permission activity per session (for Copilot's unresolved requests). */
  latestPermission: ReadonlyMap<string, ActivityEvent>
  now: EpochMs
  thresholds: Thresholds
}

const SEV: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
const DAY = 24 * 3600_000

const label = (s: SessionSummary): string => `${s.workspace?.name ?? s.title} · ${s.agent ?? s.harness}`

/** Plan §9.3. Pure; sorted by severity, then `since` descending. */
export function computeAttention(input: AttentionInput): AttentionItem[] {
  const { now, thresholds: t } = input
  const items: AttentionItem[] = []

  for (const s of input.sessions) {
    const last = s.lastActivityAt ?? s.updatedAt
    const perm = input.latestPermission.get(s.id)
    const copilotPending = s.harness === 'copilot' && s.state === 'waiting' && perm && (perm.status === 'pending' || perm.status === 'running')
    if (s.state === 'blocked' || copilotPending) {
      items.push({
        id: `permission:${s.id}`,
        kind: 'permission',
        severity: 'high',
        sessionId: s.id,
        runId: null,
        taskId: null,
        title: `${label(s)} needs permission`,
        detail: perm?.title ?? s.current?.label ?? null,
        since: s.stateSince ?? perm?.ts ?? last,
        source: copilotPending ? 'copilot.events' : 'orca.hooks',
      })
    } else if (s.state === 'waiting') {
      items.push({
        id: `question:${s.id}`,
        kind: 'question',
        severity: 'high',
        sessionId: s.id,
        runId: null,
        taskId: null,
        title: `${label(s)} asked a question`,
        detail: s.current?.detail ?? s.current?.label ?? s.lastMessage,
        since: s.stateSince ?? last,
        source: s.stateSource,
      })
    }
    if (s.state === 'error' && (s.live || now - last <= t.liveMs)) {
      items.push({
        id: `error:${s.id}`,
        kind: 'error',
        severity: 'high',
        sessionId: s.id,
        runId: null,
        taskId: null,
        title: `${label(s)} ended with an error`,
        detail: s.lastMessage,
        since: s.stateSince ?? last,
        source: s.stateSource,
      })
    }
    const errs = input.toolErrors.get(s.id)
    if (errs && errs.length > 0 && s.live) {
      items.push({
        id: `tool-errors:${s.id}`,
        kind: 'error',
        severity: 'medium',
        sessionId: s.id,
        runId: null,
        taskId: null,
        title: `${label(s)} · ${errs.length} tool error${errs.length === 1 ? '' : 's'} in the last 10 min`,
        detail: errs[errs.length - 1]!.tool?.error ?? errs[errs.length - 1]!.title,
        since: errs[0]!.ts,
        source: 'transcript',
      })
    }
    if (input.stalled.has(s.id)) {
      const mins = Math.max(1, Math.round((now - last) / 60_000))
      items.push({
        id: `stalled:${s.id}`,
        kind: 'stalled',
        severity: 'medium',
        sessionId: s.id,
        runId: null,
        taskId: null,
        title: `${label(s)} · no activity for ${mins} min while working`,
        detail: null,
        since: last,
        source: 'transcript',
      })
    }
  }

  for (const d of input.runs) {
    const runActive = (d.run.lastActivityAt ?? d.run.updatedAt ?? d.run.createdAt ?? 0) >= now - DAY
    for (const g of d.gates) {
      if (!g.blocking) continue
      items.push({
        id: `gate:${g.id}`,
        kind: 'gate',
        severity: 'high',
        sessionId: d.run.coordinatorSessionId,
        runId: d.run.id,
        taskId: g.taskId || null,
        title: `Run '${d.run.objective}' is blocked on a decision`,
        detail: g.question,
        since: g.createdAt ?? d.run.updatedAt ?? now,
        source: 'orchestration',
      })
    }
    if (!runActive) continue
    const failedTasks = new Map<string, number>()
    for (const task of d.tasks) if (task.status === 'failed') failedTasks.set(task.id, task.attemptCount)
    for (const disp of d.dispatches) if (disp.status === 'circuit_broken' && !failedTasks.has(disp.taskId)) failedTasks.set(disp.taskId, disp.failureCount)
    for (const [taskId, attempts] of failedTasks) {
      const task = d.tasks.find((x) => x.id === taskId)
      items.push({
        id: `failed-task:${taskId}`,
        kind: 'failed-task',
        severity: 'medium',
        sessionId: null,
        runId: d.run.id,
        taskId,
        title: `Task '${task?.title ?? taskId}' failed (${attempts} attempt${attempts === 1 ? '' : 's'})`,
        detail: d.dispatches.find((x) => x.taskId === taskId && x.lastFailure)?.lastFailure ?? null,
        since: task?.completedAt ?? d.run.updatedAt ?? now,
        source: 'orchestration',
      })
    }
  }

  items.sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.since - a.since || (a.id < b.id ? -1 : 1))
  return items
}
