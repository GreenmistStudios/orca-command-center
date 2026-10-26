import {
  AGENT_STATE_PRIORITY, type ActivityEvent, type ActivityKind, type SessionSummary, type SessionUsage, type UsageEstimate, type UsageScope,
  type WorkspaceRef,
} from '../../shared/contract'
import { inflowOf, outflowOf } from '../../shared/usage-math'
import type { OccState } from './store'
import { estimateInScope } from './usage-scope'

/** Selectors are pure and return referentially stable results for unchanged inputs (safe for `useOcc(sel)`). */

function memo1<A extends unknown[], R>(fn: (...a: A) => R, same: (prev: A, next: A) => boolean): (...a: A) => R {
  let last: { args: A; result: R } | null = null
  return (...a: A) => {
    if (last && same(last.args, a)) return last.result
    const result = fn(...a)
    last = { args: a, result }
    return result
  }
}

const rootsMemo = memo1(
  (sessions: OccState['sessions'], liveOnly: boolean, harness: string, query: string): SessionSummary[] => {
    const q = query.trim().toLowerCase()
    const out = Object.values(sessions).filter((s) => {
      if (s.parentId != null) return false
      if (liveOnly && !s.live) return false
      if (harness !== 'all' && s.harness !== harness) return false
      if (q) {
        const hay = `${s.title} ${s.agent ?? ''} ${s.workspace?.name ?? ''} ${s.model?.modelId ?? ''} ${s.id}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    return out.sort((a, b) =>
      AGENT_STATE_PRIORITY[a.state] - AGENT_STATE_PRIORITY[b.state] ||
      (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt) || a.id.localeCompare(b.id))
  },
  (p, n) => p[0] === n[0] && p[1] === n[1] && p[2] === n[2] && p[3] === n[3],
)

/** Root sessions after liveOnly / harnessFilter / railQuery; sorted by state priority, then recency. */
export function selectRootSessions(s: OccState): SessionSummary[] {
  return rootsMemo(s.sessions, s.ui.liveOnly, s.ui.harnessFilter, s.ui.railQuery)
}

export interface WorkspaceGroup { workspace: WorkspaceRef; roots: SessionSummary[]; liveCount: number; needsYou: number }

const OTHER: WorkspaceRef = { key: '__other__', name: 'Other', path: null, repo: null, branch: null }

const groupsMemo = memo1(
  (roots: SessionSummary[]): WorkspaceGroup[] => {
    const m = new Map<string, WorkspaceGroup>()
    for (const r of roots) {
      const ws = r.workspace ?? OTHER
      let g = m.get(ws.key)
      if (!g) { g = { workspace: ws, roots: [], liveCount: 0, needsYou: 0 }; m.set(ws.key, g) }
      g.roots.push(r)
      if (r.live) g.liveCount++
      if (r.state === 'blocked' || r.state === 'waiting') g.needsYou++
    }
    return [...m.values()]
  },
  (p, n) => p[0] === n[0],
)

/** Rail groups (ordered by their most urgent root). */
export function selectWorkspaceGroups(s: OccState): WorkspaceGroup[] {
  return groupsMemo(selectRootSessions(s))
}

const descCache = new Map<string, { sessions: OccState['sessions']; result: SessionSummary[] }>()

/** Descendants of `rootId` (excluding the root) in DFS pre-order. */
export function selectDescendants(s: OccState, rootId: string | null): SessionSummary[] {
  if (!rootId) return EMPTY
  const hit = descCache.get(rootId)
  if (hit && hit.sessions === s.sessions) return hit.result
  const out: SessionSummary[] = []
  const walk = (id: string) => {
    const n = s.sessions[id]
    if (!n) return
    for (const c of n.childIds) {
      const cs = s.sessions[c]
      if (cs) { out.push(cs); walk(c) }
    }
  }
  walk(rootId)
  if (descCache.size > 200) descCache.clear()
  descCache.set(rootId, { sessions: s.sessions, result: out })
  return out
}
const EMPTY: SessionSummary[] = []

export function selectSelectedSession(s: OccState): SessionSummary | null {
  return s.ui.selectedSessionId ? (s.sessions[s.ui.selectedSessionId] ?? null) : null
}

export interface FleetPulse { working: number; needsYou: number; idle: number; live: number; total: number }

const pulseMemo = memo1(
  (sessions: OccState['sessions']): FleetPulse => {
    const p: FleetPulse = { working: 0, needsYou: 0, idle: 0, live: 0, total: 0 }
    for (const x of Object.values(sessions)) {
      p.total++
      if (x.live) p.live++
      if (x.state === 'working') p.working++
      else if (x.state === 'blocked' || x.state === 'waiting') p.needsYou++
      else if (x.state === 'idle' || x.state === 'done') p.idle++
    }
    return p
  },
  (p, n) => p[0] === n[0],
)

/** Counts over every session (roots and subagents): working / needs you (blocked+waiting) / idle (idle+done). */
export function selectFleetPulse(s: OccState): FleetPulse {
  return pulseMemo(s.sessions)
}

export interface ActivityScope { rootId?: string | null; sessionId?: string | null; kinds?: readonly ActivityKind[] }

const SCOPE_CACHE_MAX = 8
let scopeCacheVersion = -1
let scopeCacheById: OccState['activity']['byId'] | null = null
const scopeCache = new Map<string, string[]>()

/** Ids (oldest → newest) of ring events matching the scope. Stable per scope while the ring version is unchanged. */
export function selectActivityForScope(s: OccState, scope: ActivityScope): string[] {
  const key = `${scope.rootId ?? ''}|${scope.sessionId ?? ''}|${(scope.kinds ?? []).join(',')}`
  const { byId, order, version } = s.activity
  if (scopeCacheVersion !== version || scopeCacheById !== byId) { scopeCache.clear(); scopeCacheVersion = version; scopeCacheById = byId }
  const hit = scopeCache.get(key)
  if (hit) return hit
  const kinds = scope.kinds?.length ? new Set<ActivityKind>(scope.kinds) : null
  const result = order.filter((id) => {
    const e: ActivityEvent | undefined = byId[id]
    if (!e) return false
    if (scope.sessionId && e.sessionId !== scope.sessionId) return false
    if (scope.rootId && e.rootId !== scope.rootId) return false
    if (kinds && !kinds.has(e.kind)) return false
    return true
  })
  if (scopeCache.size >= SCOPE_CACHE_MAX) scopeCache.delete(scopeCache.keys().next().value as string)
  scopeCache.set(key, result)
  return result
}

const ancCache = new Map<string, { sessions: OccState['sessions']; result: SessionSummary[] }>()

/** Ancestors of `id`, root first (excluding `id`). */
export function selectSessionAncestors(s: OccState, id: string | null): SessionSummary[] {
  if (!id) return EMPTY
  const hit = ancCache.get(id)
  if (hit && hit.sessions === s.sessions) return hit.result
  const out: SessionSummary[] = []
  for (let p = s.sessions[id]?.parentId; p; p = s.sessions[p]?.parentId) {
    const ps = s.sessions[p]
    if (!ps) break
    out.unshift(ps)
  }
  if (ancCache.size > 200) ancCache.clear()
  ancCache.set(id, { sessions: s.sessions, result: out })
  return out
}

/* ───────────────────────────── token flow ───────────────────────────── */

const FLEET_SCOPE: UsageScope = { kind: 'fleet', id: null }
const usageScopeCache = new Map<string, UsageScope>()
/** Referentially stable scope object per (kind, id). */
export function stableUsageScope(kind: UsageScope['kind'], id: string | null): UsageScope {
  if (kind === 'fleet') return FLEET_SCOPE
  const k = `${kind}:${id}`
  let hit = usageScopeCache.get(k)
  if (!hit) {
    if (usageScopeCache.size > 200) usageScopeCache.clear()
    usageScopeCache.set(k, (hit = { kind, id }))
  }
  return hit
}

/** Selected run → run; selected session → workflow of its root; else fleet. */
export function selectAutoUsageScope(s: OccState): UsageScope {
  const { selectedRunId, selectedSessionId, selectedRootId } = s.ui
  if (selectedRunId) return stableUsageScope('run', selectedRunId)
  if (selectedSessionId) {
    const root = s.sessions[selectedSessionId]?.rootId ?? selectedRootId ?? selectedSessionId
    return stableUsageScope('workflow', root)
  }
  return FLEET_SCOPE
}

export function selectSessionUsage(s: OccState, id: string | null): SessionUsage | null {
  return (id ? s.sessions[id]?.usage : null) ?? null
}

export interface FleetBurn { costPerHour: number; tokensPerMin: number; inFlight: number }

const burnMemo = memo1(
  (stats: OccState['stats'], samples: OccState['usage']['samples'], version: number, inFlight: number): FleetBurn => {
    void version
    const base = stats?.usage?.rates ?? null
    if (base) {
      // Stats frames already count everything up to `asOf`; add live samples metered after it.
      let cost = 0
      let tokens = 0
      for (let i = samples.order.length - 1; i >= 0; i--) {
        const x = samples.byId[samples.order[i]]
        if (!x) continue
        if (x.ts <= base.asOf) break
        tokens += inflowOf(x.tokens) + outflowOf(x.tokens)
        if (typeof x.cost === 'number') cost += x.cost
      }
      const perMin = base.windowMs > 0 ? 60_000 / base.windowMs : 0
      const perHour = base.windowMs > 0 ? 3_600_000 / base.windowMs : 0
      return {
        costPerHour: base.costPerHour + cost * perHour,
        tokensPerMin: base.inflowPerMin + base.outflowPerMin + tokens * perMin,
        inFlight,
      }
    }
    // No stats yet: last 5 minutes of the ring, relative to the newest sample.
    const newest = samples.byId[samples.order[samples.order.length - 1] ?? '']
    if (!newest) return { costPerHour: 0, tokensPerMin: 0, inFlight }
    const W = 5 * 60_000
    let cost = 0
    let tokens = 0
    for (let i = samples.order.length - 1; i >= 0; i--) {
      const x = samples.byId[samples.order[i]]
      if (!x) continue
      if (x.ts <= newest.ts - W) break
      tokens += inflowOf(x.tokens) + outflowOf(x.tokens)
      if (typeof x.cost === 'number') cost += x.cost
    }
    return { costPerHour: (cost * 3_600_000) / W, tokensPerMin: (tokens * 60_000) / W, inFlight }
  },
  (p, n) => p[0] === n[0] && p[2] === n[2] && p[3] === n[3],
)

/** Fleet burn: `stats.usage.rates` refined with live samples newer than the stats frame; `inFlight` = streaming calls. */
export function selectFleetBurn(s: OccState): FleetBurn {
  return burnMemo(s.stats, s.usage.samples, s.usage.samples.version, Object.keys(s.usage.estimates).length)
}

const inFlightMemo = memo1(
  (estimates: OccState['usage']['estimates'], scope: UsageScope, sessions: OccState['sessions'], orch: OccState['orchestration']): UsageEstimate[] =>
    Object.values(estimates).filter((e) => estimateInScope(e, scope, { sessions, orchestration: orch })),
  (p, n) => p[0] === n[0] && p[1].kind === n[1].kind && p[1].id === n[1].id && p[2] === n[2] && p[3] === n[3],
)

/** In-flight estimates inside `scope` (stable while estimates/sessions are unchanged). */
export function selectInFlight(s: OccState, scope: UsageScope): UsageEstimate[] {
  return inFlightMemo(s.usage.estimates, scope, s.sessions, s.orchestration)
}
