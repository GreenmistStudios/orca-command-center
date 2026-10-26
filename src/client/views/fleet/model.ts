import type { AgentState, AttentionItem, OrchRun, SessionSummary, WorktreeInfo } from '../../../shared/contract'
import { AGENT_STATE_PRIORITY } from '../../../shared/contract'
import type { Graph, GraphEdge, GraphNode } from '../dag/model'

export type FleetNodeKind = 'project' | 'worktree' | 'session' | 'run' | 'overflow'
export interface FleetCounts { live: number; working: number; needsYou: number; idle: number; error: number }
export type FleetNodeData =
  | { kind: 'project'; id: string; name: string; worktreeCount: number; counts: FleetCounts; state: AgentState; collapsed: boolean }
  | { kind: 'worktree'; id: string; projectId: string; name: string; branch: string | null; path: string | null; terminals: number; lastActivityAt: number | null; counts: FleetCounts; state: AgentState; collapsed: boolean }
  | { kind: 'session'; id: string; session: SessionSummary; workingDescendants: number; needsYou: boolean }
  | { kind: 'run'; id: string; run: OrchRun; needsYou: boolean }
  | { kind: 'overflow'; id: string; worktreeId: string; hidden: number }
export interface FleetGraph extends Graph { data: Record<string, FleetNodeData> }
export interface FleetInput { sessions: Record<string, SessionSummary>; worktrees: WorktreeInfo[]; runs: OrchRun[]; attention: AttentionItem[]; now: number; windowMs: number }
export interface FleetOptions { scope: 'active' | 'all'; harness: string | null; collapsed: ReadonlySet<string>; maxNodes?: number }

export const FLEET_SIZES = {
  project: { w: 240, h: 84 },
  worktree: { w: 240, h: 84 },
  session: { w: 264, h: 96 },
  run: { w: 264, h: 96 },
  overflow: { w: 160, h: 48 },
} as const

const UNATTACHED = 'Unattached'
const TERMINAL_TASK = new Set(['done', 'completed', 'failed', 'cancelled'])

export function rollupState(states: AgentState[]): AgentState {
  let best: AgentState = 'idle'
  let found = false
  for (const s of states) {
    if (!found || AGENT_STATE_PRIORITY[s] < AGENT_STATE_PRIORITY[best]) { best = s; found = true }
  }
  return best
}

const emptyCounts = (): FleetCounts => ({ live: 0, working: 0, needsYou: 0, idle: 0, error: 0 })
const addCounts = (a: FleetCounts, b: FleetCounts): FleetCounts => ({
  live: a.live + b.live, working: a.working + b.working, needsYou: a.needsYou + b.needsYou, idle: a.idle + b.idle, error: a.error + b.error,
})
const recency = (s: SessionSummary): number => s.lastActivityAt ?? s.updatedAt ?? 0
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const normPath = (p: string): string => p.replace(/[\\/]+$/, '')

interface WtBucket {
  key: string
  projectKey: string | null
  name: string
  branch: string | null
  path: string | null
  terminals: number
  lastActivityAt: number | null
  sessions: SessionSummary[]
  runs: OrchRun[]
}

export function buildFleetGraph(input: FleetInput, opts: FleetOptions): FleetGraph {
  const maxNodes = opts.maxNodes ?? 150
  const all = Object.values(input.sessions)
  const attnSessions = new Set<string>()
  const attnRuns = new Set<string>()
  for (const a of input.attention) {
    if (a.sessionId) attnSessions.add(a.sessionId)
    if (a.runId) attnRuns.add(a.runId)
  }

  const buckets = new Map<string, WtBucket>()
  const byPath = new Map<string, string>()
  for (const wt of input.worktrees) {
    buckets.set(wt.id, {
      key: wt.id, projectKey: wt.repo, name: wt.displayName ?? wt.branch ?? baseName(wt.path), branch: wt.branch,
      path: wt.path, terminals: wt.liveTerminalCount, lastActivityAt: wt.lastActivityAt, sessions: [], runs: [],
    })
    byPath.set(normPath(wt.path), wt.id)
  }
  const ensureSynthetic = (key: string, name: string, s: SessionSummary | null): WtBucket => {
    let b = buckets.get(key)
    if (!b) {
      b = { key, projectKey: null, name, branch: s?.workspace?.branch ?? null, path: s?.workspace?.path ?? null, terminals: 0, lastActivityAt: null, sessions: [], runs: [] }
      buckets.set(key, b)
    }
    return b
  }
  const sessionProject = (s: SessionSummary): string | null => s.workspace?.repo ?? s.workspace?.name ?? null
  const resolve = (s: SessionSummary): WtBucket => {
    const wid = s.orca?.worktreeId
    if (wid && buckets.has(wid)) return buckets.get(wid)!
    const p = s.workspace?.path
    if (p) {
      const id = byPath.get(normPath(p))
      if (id) return buckets.get(id)!
    }
    if (s.workspace) return ensureSynthetic(s.workspace.key, s.workspace.name, s)
    return ensureSynthetic('unattached', UNATTACHED, null)
  }

  // Resolve locations over ALL sessions so runs/projects stay stable under filters.
  const home = new Map<string, WtBucket>()
  for (const s of all) home.set(s.id, resolve(s))
  const sortedAll = [...all].sort((a, b) => cmpStr(a.id, b.id))

  const childrenOf = (s: SessionSummary): SessionSummary[] => s.childIds.map((c) => input.sessions[c]).filter((x): x is SessionSummary => !!x)
  const subtree = (root: SessionSummary): SessionSummary[] => {
    const out: SessionSummary[] = []
    const seen = new Set<string>([root.id])
    const stack = [root]
    while (stack.length) {
      const cur = stack.pop()!
      for (const c of childrenOf(cur)) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); stack.push(c) }
    }
    return out
  }

  // Runs
  const runWt = (run: OrchRun): WtBucket => {
    const coord = run.coordinatorSessionId ? input.sessions[run.coordinatorSessionId] : undefined
    if (coord) return home.get(coord.id)!
    const linked = sortedAll.find((s) => s.orca?.runId === run.id)
    if (linked) return home.get(linked.id)!
    return ensureSynthetic('unattached', UNATTACHED, null)
  }
  const runKeep = (r: OrchRun): boolean =>
    opts.scope === 'all' ||
    (r.lastActivityAt != null && input.now - r.lastActivityAt <= input.windowMs) ||
    r.hasBlockingGate ||
    Object.entries(r.statusCounts).some(([st, n]) => n > 0 && !TERMINAL_TASK.has(st.toLowerCase()))
  for (const r of input.runs) if (runKeep(r)) runWt(r).runs.push(r)

  // Sessions (roots only)
  const needsYouOf = new Map<string, boolean>()
  const workingDesc = new Map<string, number>()
  const sessionKeep = (s: SessionSummary, sub: SessionSummary[]): boolean => {
    if (opts.scope === 'all') return true
    const recent = (x: SessionSummary) => x.lastActivityAt != null && input.now - x.lastActivityAt <= input.windowMs
    return [s, ...sub].some((x) => x.live || recent(x) || attnSessions.has(x.id))
  }
  for (const s of all) {
    if (s.parentId != null) continue
    if (opts.harness && s.harness !== opts.harness) continue
    const sub = subtree(s)
    if (!sessionKeep(s, sub)) continue
    needsYouOf.set(s.id, s.state === 'blocked' || s.state === 'waiting' || [s, ...sub].some((x) => attnSessions.has(x.id)))
    workingDesc.set(s.id, sub.filter((x) => x.state === 'working').length)
    home.get(s.id)!.sessions.push(s)
  }
  const runNeeds = (r: OrchRun): boolean => r.hasBlockingGate || attnRuns.has(r.id)

  // Projects
  interface ProjBucket { key: string; wts: WtBucket[] }
  const projects = new Map<string, ProjBucket>()
  for (const b of buckets.values()) {
    if (opts.scope === 'active' && b.sessions.length === 0 && b.runs.length === 0) continue
    const first = b.sessions[0] ?? sortedAll.find((x) => home.get(x.id) === b)
    const pk = b.projectKey ?? (first ? sessionProject(first) : null) ?? UNATTACHED
    let p = projects.get(pk)
    if (!p) projects.set(pk, (p = { key: pk, wts: [] }))
    p.wts.push(b)
  }

  const sessionRank = (a: SessionSummary, b: SessionSummary) =>
    AGENT_STATE_PRIORITY[a.state] - AGENT_STATE_PRIORITY[b.state] || recency(b) - recency(a) || cmpStr(a.id, b.id)

  const wtCounts = (b: WtBucket): FleetCounts => {
    let c = emptyCounts()
    for (const s of b.sessions) {
      c = addCounts(c, { live: s.live ? 1 : 0, working: s.state === 'working' ? 1 : 0, needsYou: needsYouOf.get(s.id) ? 1 : 0, idle: s.live ? 0 : 1, error: s.state === 'error' ? 1 : 0 })
    }
    for (const r of b.runs) if (runNeeds(r)) c.needsYou++
    return c
  }
  const wtState = (b: WtBucket): AgentState =>
    rollupState([...b.sessions.map((s) => s.state), ...b.runs.filter((r) => r.hasBlockingGate).map((): AgentState => 'blocked')])

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const data: Record<string, FleetNodeData> = {}
  const addNode = (id: string, kind: FleetNodeKind, d: FleetNodeData) => {
    nodes.push({ id, type: kind, ...FLEET_SIZES[kind] })
    data[id] = d
  }
  const addEdge = (source: string, target: string, label: string | null = null) => edges.push({ id: `${source}>${target}`, source, target, label })

  // Overflow: decide which worktrees swap idle sessions for an overflow node.
  const wtList = [...projects.values()].flatMap((p) => p.wts)
  const idleOf = (b: WtBucket) => b.sessions.filter((s) => !s.live && !needsYouOf.get(s.id))
  const overflowed = new Set<string>()
  const projectKeys = [...projects.keys()]
  const visibleCount = (): number => {
    let n = 0
    for (const pk of projectKeys) {
      n++
      if (opts.collapsed.has(`p:${pk}`)) continue
      for (const b of projects.get(pk)!.wts) {
        n++
        if (opts.collapsed.has(`w:${b.key}`)) continue
        n += b.runs.length
        n += overflowed.has(b.key) ? b.sessions.length - idleOf(b).length + 1 : b.sessions.length
      }
    }
    return n
  }
  if (visibleCount() > maxNodes) {
    const order = wtList.filter((b) => idleOf(b).length > 0).sort((a, b) => idleOf(b).length - idleOf(a).length || cmpStr(a.key, b.key))
    for (const b of order) {
      overflowed.add(b.key)
      if (visibleCount() <= maxNodes) break
    }
  }

  const projList = [...projects.values()].sort((a, b) => cmpStr(a.key, b.key))
  for (const p of projList) {
    const pid = `p:${p.key}`
    const wts = [...p.wts].sort((a, b) => cmpStr(a.name, b.name) || cmpStr(a.key, b.key))
    const pCounts = wts.reduce((c, b) => addCounts(c, wtCounts(b)), emptyCounts())
    const pCollapsed = opts.collapsed.has(pid)
    addNode(pid, 'project', { kind: 'project', id: pid, name: p.key, worktreeCount: wts.length, counts: pCounts, state: rollupState(wts.map(wtState)), collapsed: pCollapsed })
    if (pCollapsed) continue
    for (const b of wts) {
      const wid = `w:${b.key}`
      const wCollapsed = opts.collapsed.has(wid)
      addNode(wid, 'worktree', {
        kind: 'worktree', id: wid, projectId: pid, name: b.name, branch: b.branch, path: b.path, terminals: b.terminals,
        lastActivityAt: b.lastActivityAt, counts: wtCounts(b), state: wtState(b), collapsed: wCollapsed,
      })
      addEdge(pid, wid)
      if (wCollapsed) continue
      const sessions = [...b.sessions].sort(sessionRank)
      const hide = overflowed.has(b.key)
      const idle = hide ? new Set(idleOf(b).map((s) => s.id)) : new Set<string>()
      for (const s of sessions) {
        if (idle.has(s.id)) continue
        const sid = `s:${s.id}`
        addNode(sid, 'session', { kind: 'session', id: sid, session: s, workingDescendants: workingDesc.get(s.id) ?? 0, needsYou: !!needsYouOf.get(s.id) })
        addEdge(wid, sid)
      }
      if (idle.size > 0) {
        const oid = `o:${b.key}`
        addNode(oid, 'overflow', { kind: 'overflow', id: oid, worktreeId: wid, hidden: idle.size })
        addEdge(wid, oid)
      }
      const runs = [...b.runs].sort((x, y) => (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0) || cmpStr(x.id, y.id))
      for (const r of runs) {
        const rid = `r:${r.id}`
        addNode(rid, 'run', { kind: 'run', id: rid, run: r, needsYou: runNeeds(r) })
        addEdge(wid, rid)
      }
    }
  }
  for (const id of Object.keys(data)) {
    const d = data[id]!
    if (d.kind !== 'run' || !d.run.coordinatorSessionId) continue
    const cs = `s:${d.run.coordinatorSessionId}`
    if (data[cs]) addEdge(id, cs, 'coordinates')
  }
  return { nodes, edges, data }
}
