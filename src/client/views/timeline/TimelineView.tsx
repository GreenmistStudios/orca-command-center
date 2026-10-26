import { useEffect, useMemo } from 'react'
import { SquareChartGantt } from 'lucide-react'
import type { ActivityEvent, ActivityKind, OrchDispatch, OrchTask, SessionSummary } from '../../../shared/contract'
import { useClock } from './useClock'
import { formatClock, formatDuration } from '../../lib/format'
import { selectActivityForScope } from '../../state/selectors'
import { useOcc } from '../../state/store'
import { EmptyState } from '../../ui/EmptyState'
import { AgentMonogram } from '../../ui/Monogram'
import { kindColorVar, orchStatusTone, stateTone } from '../../ui/tones'
import { blockEnd, isInstant, orderLanes, sessionSpanEnd } from './geometry'
import { TimelineChart, type BlockItem, type Connector, type LaneModel } from './TimelineChart'

const KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>(['thinking', 'tool', 'mcp', 'file-change', 'subagent', 'prompt', 'error', 'state', 'permission'])
const MAX_EVENTS = 5000

export function TimelineView() {
  const runId = useOcc((s) => s.ui.selectedRunId)
  const rootId = useOcc((s) => s.ui.selectedRootId)
  if (runId) return <RunTimeline key={`run:${runId}`} runId={runId} />
  if (!rootId) return <EmptyState icon={<SquareChartGantt size={20} />} title="Select a session to see its timeline" hint="Pick a root session in the rail." />
  return <SessionTimeline key={rootId} rootId={rootId} />
}

/* ─────────────────────────── session tree mode ─────────────────────────── */

function SessionTimeline({ rootId }: { rootId: string }) {
  const now = useClock(1000)
  const sessions = useOcc((s) => s.sessions)
  const tree = useOcc((s) => s.trees[rootId])
  const scoped = useOcc((s) => s.scopedActivity[`root:${rootId}`])
  const ringIds = useOcc((s) => selectActivityForScope(s, { rootId }))
  const ringVersion = useOcc((s) => s.activity.version)
  const selectedActivityId = useOcc((s) => s.ui.selectedActivityId)
  const selectedSessionId = useOcc((s) => s.ui.selectedSessionId)
  const selectActivity = useOcc((s) => s.selectActivity)
  const selectSession = useOcc((s) => s.selectSession)

  useEffect(() => {
    let cancel = false
    void (async () => {
      const st = useOcc.getState()
      await Promise.all([st.fetchTree(rootId), st.fetchScopedActivity({ rootId })])
      // Page back until ≤ MAX_EVENTS or the root's createdAt is covered. (No `kinds`: the Stream view shares this cache.)
      while (!cancel) {
        const s = useOcc.getState()
        const d = s.scopedActivity[`root:${rootId}`]?.data
        if (!d || !d.hasMore || !d.before || d.events.length >= MAX_EVENTS) break
        if (d.events.length && d.events[0].ts <= (s.sessions[rootId]?.createdAt ?? 0)) break
        const before = d.before
        await s.fetchScopedActivity({ rootId }, { older: true })
        if (useOcc.getState().scopedActivity[`root:${rootId}`]?.data?.before === before) break
      }
    })()
    return () => { cancel = true }
  }, [rootId])

  const laneSessions = useMemo(() => {
    const all = Object.values(sessions).filter((s) => s.rootId === rootId)
    if (all.length) return all
    return tree?.data?.nodes ?? []
  }, [sessions, rootId, tree?.data])

  const events = useMemo(() => {
    const m = new Map<string, ActivityEvent>()
    const put = (e: ActivityEvent) => { const p = m.get(e.id); if (!p || p.rev <= e.rev) m.set(e.id, e) }
    for (const e of scoped?.data?.events ?? []) put(e)
    const { byId } = useOcc.getState().activity
    for (const id of ringIds) { const e = byId[id]; if (e) put(e) }
    return [...m.values()].filter((e) => KINDS.has(e.kind) && e.sessionId).sort((a, b) => a.ts - b.ts).slice(-MAX_EVENTS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped?.data, ringIds, ringVersion])

  const model = useMemo(() => {
    const ordered = orderLanes(laneSessions, rootId)
    const bySession = new Map<string, ActivityEvent[]>()
    for (const e of events) { const a = bySession.get(e.sessionId!); if (a) a.push(e); else bySession.set(e.sessionId!, [e]) }
    const laneIdx = new Map(ordered.map((l, i) => [l.session.id, i]))
    const lanes: LaneModel[] = ordered.map(({ session, depth }) => ({
      id: session.id,
      labelText: `${session.agent ?? 'agent'} ${session.title}`,
      label: <SessionLabel session={session} depth={depth} />,
      selected: session.id === selectedSessionId,
      span: { start: session.createdAt, end: sessionSpanEnd(session, now), tone: stateTone(session.state), live: session.live },
      onSelectLane: () => selectSession(session.id),
      blocks: (bySession.get(session.id) ?? []).map((e): BlockItem => ({
        id: e.id, start: e.ts, end: blockEnd(e, now), instant: isInstant(e), color: kindColorVar(e.kind),
        error: e.status === 'error' || e.kind === 'error', running: e.status === 'running',
        tip: { heading: e.title, lines: [`${e.kind}${e.status ? ` · ${e.status}` : ''}`, `${formatClock(e.ts)}${e.endTs != null || e.status === 'running' ? ` · ${formatDuration(blockEnd(e, now) - e.ts)}` : ''}`, `${session.agent ?? 'agent'} · ${session.title}`] },
        onSelect: () => { selectActivity(e.id); selectSession(e.sessionId!, { activityId: e.id }) },
      })),
    }))
    const connectors: Connector[] = []
    for (const e of events) {
      if (e.kind !== 'subagent' || !e.childSessionId) continue
      const from = laneIdx.get(e.sessionId!)
      const to = laneIdx.get(e.childSessionId)
      const child = to != null ? ordered[to].session : null
      if (from != null && to != null && child) connectors.push({ fromLane: from, toLane: to, from: e.ts, to: child.createdAt })
    }
    let min = Infinity
    let max = -Infinity
    for (const { session } of ordered) { min = Math.min(min, session.createdAt); max = Math.max(max, sessionSpanEnd(session, now)) }
    for (const e of events) { min = Math.min(min, e.ts); max = Math.max(max, blockEnd(e, now)) }
    if (!Number.isFinite(min)) { min = now - 60_000; max = now }
    return { lanes, connectors, bounds: { min, max }, anyLive: ordered.some((l) => l.session.live) }
  }, [laneSessions, events, rootId, now, selectedSessionId, selectActivity, selectSession])

  const loading = !model.lanes.length && (!tree || tree.status === 'loading' || tree.status === 'idle')
  if (loading) return <EmptyState icon={<SquareChartGantt size={20} />} title="Loading timeline…" />
  if (!model.lanes.length) return <EmptyState icon={<SquareChartGantt size={20} />} title="No activity yet" hint="This session has no recorded agents or activity." />
  const noEvents = !events.length && scoped?.status !== 'loading' && scoped?.status !== 'idle'
  return (
    <TimelineChart
      lanes={model.lanes} connectors={model.connectors} bounds={model.bounds} anyLive={model.anyLive} now={now} selectedItemId={selectedActivityId}
      empty={noEvents ? <div className="text-muted-foreground pointer-events-none absolute right-3 bottom-3 text-[11px]">No activity recorded yet.</div> : null}
    />
  )
}

function SessionLabel({ session, depth }: { session: SessionSummary; depth: number }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: 6 + Math.min(depth, 4) * 10 }}>
      <AgentMonogram agent={session.agent} size={17} />
      <span className="min-w-0">
        <span className="block truncate text-[11px] leading-tight font-medium">{session.agent ?? 'agent'}</span>
        <span className="text-muted-foreground block truncate text-[10px] leading-tight">{session.title}</span>
      </span>
    </span>
  )
}

/* ─────────────────────────── orchestration run mode ─────────────────────────── */

function RunTimeline({ runId }: { runId: string }) {
  const now = useClock(1000)
  const run = useOcc((s) => s.runs[runId])
  const selectTask = useOcc((s) => s.selectTask)
  useEffect(() => { void useOcc.getState().fetchRun(runId) }, [runId])

  const model = useMemo(() => {
    const d = run?.data
    if (!d) return null
    const titles = new Map<string, OrchTask>(d.tasks.map((t) => [t.id, t]))
    const attempt = new Map<string, number>()
    const ds = d.dispatches.filter((x): x is OrchDispatch & { dispatchedAt: number } => x.dispatchedAt != null).sort((a, b) => a.dispatchedAt - b.dispatchedAt)
    let min = Infinity
    let max = -Infinity
    let anyLive = false
    const lanes: LaneModel[] = ds.map((x) => {
      const n = (attempt.get(x.taskId) ?? 0) + 1
      attempt.set(x.taskId, n)
      const task = titles.get(x.taskId)
      const live = x.completedAt == null && (x.status === 'dispatched' || x.status === 'pending')
      const end = x.completedAt ?? (live ? now : (x.lastHeartbeatAt ?? x.dispatchedAt))
      anyLive ||= live
      min = Math.min(min, x.dispatchedAt); max = Math.max(max, end)
      return {
        id: x.id, labelText: `${task?.title ?? x.taskId} attempt ${n}`, selected: false,
        label: (
          <span className="flex min-w-0 items-center gap-1.5 pl-1.5">
            <AgentMonogram agent={x.assigneeHandle} size={17} />
            <span className="min-w-0">
              <span className="block truncate text-[11px] leading-tight font-medium">{task?.title ?? x.taskId}</span>
              <span className="text-muted-foreground block truncate text-[10px] leading-tight">attempt {n} · {x.assigneeHandle ?? 'unassigned'}</span>
            </span>
          </span>
        ),
        span: { start: x.dispatchedAt, end, tone: orchStatusTone(x.status), live, text: `${x.status} · ${formatDuration(end - x.dispatchedAt)}` },
        blocks: [], onSelectLane: () => selectTask(x.taskId),
      }
    })
    if (!Number.isFinite(min)) { min = now - 60_000; max = now }
    return { lanes, bounds: { min, max }, anyLive }
  }, [run?.data, now, selectTask])

  if (!model) return <EmptyState icon={<SquareChartGantt size={20} />} title={run?.status === 'error' ? 'Could not load this run' : 'Loading timeline…'} hint={run?.error ?? undefined} />
  if (!model.lanes.length) return <EmptyState icon={<SquareChartGantt size={20} />} title="No dispatches yet" hint="Task attempts appear here once Orca dispatches them." />
  return <TimelineChart lanes={model.lanes} connectors={[]} bounds={model.bounds} anyLive={model.anyLive} now={now} selectedItemId={null} />
}
