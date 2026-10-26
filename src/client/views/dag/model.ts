import type { AgentState, OrchDispatch, OrchGate, OrchRunDetail, OrchTask, SessionEdge, SessionSummary, SessionTree } from '../../../shared/contract'
import { orchStatusTone, stateTone, type Tone } from '../../ui/tones'

export const SESSION_SIZE = { w: 264, h: 96 } as const
export const TASK_SIZE = { w: 240, h: 84 } as const
export type Direction = 'RIGHT' | 'DOWN'

export interface GraphNode { id: string; type: string; w: number; h: number; isolated?: boolean }
export interface GraphEdge { id: string; source: string; target: string; label: string | null }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }
export type Positions = Record<string, { x: number; y: number }>
export type LayoutFn = (graph: Graph, direction: Direction) => Promise<Positions>

/** Layout is re-run only when this changes (ids + edges + direction). */
export function structureKey(g: Graph, direction: Direction): string {
  const n = g.nodes.map((x) => x.id).sort().join(',')
  const e = g.edges.map((x) => `${x.source}>${x.target}`).sort().join(',')
  return `${direction}|${n}|${e}`
}

/** Tree graph: node data comes from the (fresher) live session map merged over the tree's copy. */
export function mergeTreeNodes(tree: SessionTree, sessions: Record<string, SessionSummary>): SessionSummary[] {
  return tree.nodes.map((n) => sessions[n.id] ?? n)
}

export function buildTreeGraph(tree: SessionTree): Graph {
  const ids = new Set(tree.nodes.map((n) => n.id))
  return {
    nodes: tree.nodes.map((n) => ({ id: n.id, type: 'session', ...SESSION_SIZE })),
    edges: tree.edges.filter((e: SessionEdge) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ id: e.id, source: e.from, target: e.to, label: e.label })),
  }
}

export function buildRunGraph(detail: OrchRunDetail): Graph {
  const ids = new Set(detail.tasks.map((t) => t.id))
  const edges: GraphEdge[] = []
  for (const t of detail.tasks) {
    for (const d of t.deps) if (ids.has(d)) edges.push({ id: `${d}>${t.id}`, source: d, target: t.id, label: `${d} → ${t.id}` })
  }
  const connected = new Set(edges.flatMap((e) => [e.source, e.target]))
  return {
    nodes: detail.tasks.map((t) => ({ id: t.id, type: 'task', ...TASK_SIZE, isolated: !connected.has(t.id) })),
    edges,
  }
}

/** orca-viz geometry: isolated tasks gridded below the DAG. */
export function isolatedGrid(count: number, dagBottom: number, size = TASK_SIZE): { x: number; y: number }[] {
  const gap = 24
  const cols = Math.max(4, Math.ceil(Math.sqrt(2 * count)))
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < count; i++) {
    out.push({ x: (i % cols) * (size.w + gap), y: dagBottom + 120 + Math.floor(i / cols) * (size.h + gap) })
  }
  return out
}

/** Assignee monograms: dispatches ordered by dispatch time → A1, A2…; linked session agent wins when known. */
export function assigneeLabels(
  tasks: OrchTask[], dispatches: OrchDispatch[], sessions: Record<string, SessionSummary>,
): Record<string, { label: string; agent: string | null; key: string | null }> {
  const sorted = [...dispatches].sort((a, b) => (a.dispatchedAt ?? 0) - (b.dispatchedAt ?? 0))
  const cast = new Map<string, number>()
  for (const d of sorted) {
    const k = d.assigneeHandle ?? d.assigneeSessionId
    if (k && !cast.has(k)) cast.set(k, cast.size + 1)
  }
  const out: Record<string, { label: string; agent: string | null; key: string | null }> = {}
  for (const t of tasks) {
    const ds = sorted.filter((d) => d.taskId === t.id)
    const d = ds.find((x) => x.id === t.latestDispatchId) ?? ds[ds.length - 1]
    if (!d) continue
    const k = d.assigneeHandle ?? d.assigneeSessionId
    const s = d.assigneeSessionId ? sessions[d.assigneeSessionId] : undefined
    out[t.id] = { label: s ? '' : `A${k ? cast.get(k) : '?'}`, agent: s?.agent ?? null, key: k }
  }
  return out
}

/** Detect whether the dependency graph contains a cycle (Kahn). */
export function hasCycle(tasks: OrchTask[]): boolean {
  const ids = new Set(tasks.map((t) => t.id))
  const indeg = new Map(tasks.map((t) => [t.id, 0]))
  const out = new Map<string, string[]>()
  for (const t of tasks) for (const d of t.deps) if (ids.has(d)) {
    indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1)
    out.set(d, [...(out.get(d) ?? []), t.id])
  }
  const q = [...indeg].filter(([, v]) => v === 0).map(([k]) => k)
  let seen = 0
  while (q.length) {
    const id = q.pop()!
    seen++
    for (const n of out.get(id) ?? []) { indeg.set(n, indeg.get(n)! - 1); if (indeg.get(n) === 0) q.push(n) }
  }
  return seen < tasks.length
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export function treeCaption(rootTitle: string, nodes: SessionSummary[]): string {
  const agents = nodes.length - 1
  if (agents <= 0) return 'No subagents yet.'
  const working = nodes.filter((n) => n.state === 'working').length
  return `${rootTitle} · ${plural(agents, 'agent')} · ${working} working`
}

export function runCaption(tasks: OrchTask[], edgeCount: number): string {
  if (tasks.length === 0) return 'No tasks in this run.'
  if (edgeCount === 0) return `No dependencies in this run — ${plural(tasks.length, 'task')} dispatched independently.`
  const base = `${plural(tasks.length, 'task')} · ${plural(edgeCount, 'dependency').replace('dependencys', 'dependencies')}`
  return hasCycle(tasks) ? `${base} · dependency cycle detected` : base
}

/** Edge styling by target state (design-system §10.2). */
export function edgeStyle(targetState: AgentState | string | null, dimmed = false) {
  const working = targetState === 'working' || targetState === 'dispatched'
  const failed = targetState === 'error' || targetState === 'failed'
  return {
    stroke: working ? '#f59e0b' : failed ? 'var(--status-failed)' : 'color-mix(in oklch, var(--muted-foreground) 50%, transparent)',
    strokeWidth: working ? 2 : 1.5,
    strokeDasharray: working ? '6 4' : undefined,
    animated: working,
    opacity: dimmed ? 0.15 : 1,
  }
}

export function sessionTone(s: SessionSummary): Tone { return stateTone(s.state) }

export interface TaskInfo { tone: Tone; status: string; gate: OrchGate | null; attempts: number; failures: number; lastSeen: number | null }
export function taskInfo(t: OrchTask, detail: OrchRunDetail): TaskInfo {
  const ds = detail.dispatches.filter((d) => d.taskId === t.id)
  const gate = detail.gates.find((g) => g.taskId === t.id && g.blocking && g.status !== 'resolved') ?? null
  const lastSeen = ds.reduce<number | null>((m, d) => {
    const v = Math.max(d.lastHeartbeatAt ?? 0, d.completedAt ?? 0, d.dispatchedAt ?? 0) || null
    return v && (m === null || v > m) ? v : m
  }, null)
  const latest = ds.find((d) => d.id === t.latestDispatchId)
  const status = latest?.status === 'circuit_broken' ? 'circuit_broken' : t.status
  return {
    tone: gate ? 'gate' : orchStatusTone(status), status, gate,
    attempts: Math.max(t.attemptCount, ds.length),
    failures: ds.reduce((n, d) => n + d.failureCount, 0),
    lastSeen,
  }
}
