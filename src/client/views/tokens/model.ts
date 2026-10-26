/** Pure helpers for the Tokens view (scope resolution, rates, leaderboard rows, calls merge, CSV). */
import { type OrchRun, type SessionSummary, type UsageReport, type UsageSample, type UsageScope, type UsageScopeKind, type UsageSankey } from '../../../shared/contract'
import { breakdown, inflowOf, outflowOf, percentile, sampleKeyOf, throughputTps, ttftStats } from '../../../shared/usage-math'
import { EWMA_TAU_S } from '../../ui/flow'
import { stableUsageScope } from '../../state/selectors'

export const DAY_MS = 86_400_000
export const LIVE_FRESH_MS = 60_000
export const CSV_MAX_CALLS = 10_000

/* ───────────────────────────── scope ───────────────────────────── */

export interface ScopeOption { enabled: boolean; scope: UsageScope; title: string | null }
export interface ResolvedScope {
  kind: UsageScopeKind
  scope: UsageScope
  options: Record<UsageScopeKind, ScopeOption>
  /** Title of the current scope (null for fleet). */
  title: string | null
}
export interface ScopeSelection { selectedRootId: string | null; selectedSessionId: string | null; selectedRunId: string | null }

export function resolveTokensScope(
  pref: 'auto' | UsageScopeKind, auto: UsageScope, sel: ScopeSelection,
  sessions: Record<string, SessionSummary>, runs: OrchRun[] | undefined,
): ResolvedScope {
  const rootId = sel.selectedRootId ?? (sel.selectedSessionId ? sessions[sel.selectedSessionId]?.rootId ?? sel.selectedSessionId : null)
  const run = sel.selectedRunId ? runs?.find((r) => r.id === sel.selectedRunId) : undefined
  const options: Record<UsageScopeKind, ScopeOption> = {
    fleet: { enabled: true, scope: stableUsageScope('fleet', null), title: null },
    workflow: { enabled: !!rootId, scope: stableUsageScope('workflow', rootId), title: rootId ? sessions[rootId]?.title ?? rootId : null },
    session: { enabled: !!sel.selectedSessionId, scope: stableUsageScope('session', sel.selectedSessionId), title: sel.selectedSessionId ? sessions[sel.selectedSessionId]?.title ?? sel.selectedSessionId : null },
    run: { enabled: !!sel.selectedRunId, scope: stableUsageScope('run', sel.selectedRunId), title: sel.selectedRunId ? run?.objective ?? sel.selectedRunId : null },
  }
  let kind: UsageScopeKind = pref === 'auto' ? auto.kind : pref
  if (!options[kind].enabled) kind = 'fleet'
  // For auto, the selectors' own (stable) scope wins so ids always agree with the rest of the app.
  const scope = pref === 'auto' && kind === auto.kind ? auto : options[kind].scope
  const title = options[kind].title
  return { kind, scope, options, title }
}

/** Fleet shows 24 h when no window is chosen; other scopes show all time. */
export const effectiveWindow = (windowMs: number | null, kind: UsageScopeKind): number | null => windowMs ?? (kind === 'fleet' ? DAY_MS : null)

export const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

/* ───────────────────────────── rates & bursts ───────────────────────────── */

/** Sankey link ids a sample feeds (`mid:<key>` or `mid:other` when the key is not a node). */
export function linkIdsFor(s: UsageSample, sankey: UsageSankey): Array<[string, number]> {
  const key = sampleKeyOf(s, sankey.middle)
  const nodes = new Set(sankey.nodes.map((n) => n.id))
  const mid = nodes.has(`mid:${key}`) ? `mid:${key}` : 'mid:other'
  const t = s.tokens
  const out: Array<[string, number]> = []
  if (t.input > 0) out.push([`src:input→${mid}`, t.input])
  if (t.cacheRead > 0) out.push([`src:cacheRead→${mid}`, t.cacheRead])
  if (t.cacheWrite > 0) out.push([`src:cacheWrite→${mid}`, t.cacheWrite])
  if (t.output > 0) out.push([`${mid}→sink:output`, t.output])
  if (t.reasoning > 0) out.push([`${mid}→sink:reasoning`, t.reasoning])
  return out.filter(([id]) => sankey.links.some((l) => l.id === id))
}

/** EWMA (τ = 8 s) of tokens/s per link; each sample is an impulse of x/τ decaying as e^(−t/τ). */
export class RateTracker {
  private rates = new Map<string, number>()
  private last: number | null = null
  constructor(private tau = EWMA_TAU_S) {}

  /** Seed from the baseline sustained rates (tokens/min) split over links by value. */
  seed(sankey: UsageSankey, inflowPerMin: number, outflowPerMin: number): void {
    this.rates.clear()
    let inSum = 0
    let outSum = 0
    for (const l of sankey.links) { if (l.target.startsWith('mid:')) inSum += l.value; else outSum += l.value }
    for (const l of sankey.links) {
      const isIn = l.target.startsWith('mid:')
      const perSec = (isIn ? inflowPerMin : outflowPerMin) / 60
      const sum = isIn ? inSum : outSum
      if (sum > 0 && perSec > 0) this.rates.set(l.id, (l.value / sum) * perSec)
    }
  }

  add(linkId: string, tokens: number, now: number): void {
    this.decay(now)
    this.rates.set(linkId, (this.rates.get(linkId) ?? 0) + tokens / this.tau)
  }

  private decay(now: number): void {
    if (this.last !== null && now > this.last) {
      const k = Math.exp(-(now - this.last) / 1000 / this.tau)
      for (const [id, v] of this.rates) { const nv = v * k; if (nv < 0.01) this.rates.delete(id); else this.rates.set(id, nv) }
    }
    this.last = now
  }

  snapshot(now: number): Record<string, number> {
    this.decay(now)
    return Object.fromEntries(this.rates)
  }

  get active(): boolean { return this.rates.size > 0 }
}

/* ───────────────────────────── KPIs ───────────────────────────── */

export function callStats(calls: readonly UsageSample[]): { ttftP50: number | null; tps: number | null } {
  const tps: number[] = []
  for (const c of calls) { const v = throughputTps(c); if (v !== null && Number.isFinite(v)) tps.push(v) }
  return { ttftP50: ttftStats(calls).p50, tps: percentile(tps, 0.5) }
}

export const formatMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`)

/* ───────────────────────────── leaderboard ───────────────────────────── */

export type BoardTab = 'agent' | 'model' | 'session'
export interface BoardFilter { kind: 'agent' | 'model'; key: string; label: string }
export interface BoardRow {
  key: string; label: string; sessionId: string | null; agent: string | null
  tokens: number; inflow: number; outflow: number; cost: number; share: number
}

export function buildBoardRows(report: UsageReport, tab: BoardTab, filter: BoardFilter | null, sessions: Record<string, SessionSummary>): BoardRow[] {
  let rows = tab === 'agent' ? report.byAgent : tab === 'model' ? report.byModel : report.bySession
  if (filter) {
    const calls = report.recentCalls.filter((c) => (filter.kind === 'agent' ? (c.agent ?? 'unknown') : c.model ? (c.model.providerId ? `${c.model.providerId}/${c.model.modelId}` : c.model.modelId) : 'unknown') === filter.key)
    rows = breakdown(calls, tab, { session: (id) => sessions[id]?.title ?? id })
  }
  return rows.map((r) => ({
    key: r.key, label: r.label, sessionId: r.sessionId, agent: tab === 'agent' ? r.key : null,
    tokens: r.totals.inflow + r.totals.outflow, inflow: r.totals.inflow, outflow: r.totals.outflow, cost: r.totals.cost, share: r.share,
  }))
}

/* ───────────────────────────── calls ───────────────────────────── */

/** Union by id, newest first. */
export function mergeCalls(...lists: Array<readonly UsageSample[] | undefined>): UsageSample[] {
  const byId = new Map<string, UsageSample>()
  for (const l of lists) for (const c of l ?? []) { const p = byId.get(c.id); if (!p || c.ledgerSeq >= p.ledgerSeq) byId.set(c.id, c) }
  return [...byId.values()].sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1))
}

export const CSV_HEADERS = ['id', 'time', 'session', 'harness', 'agent', 'model', 'input', 'cache_read', 'cache_write', 'output', 'reasoning', 'cost_usd', 'aiu', 'ttft_ms', 'duration_ms', 'finish'] as const

/** RFC 4180 field quoting. */
export function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function callsToCsv(calls: readonly UsageSample[]): string {
  const rows = calls.map((c) => [
    c.id, new Date(c.ts).toISOString(), c.sessionId, c.harness, c.agent, c.model ? (c.model.providerId ? `${c.model.providerId}/${c.model.modelId}` : c.model.modelId) : '',
    c.tokens.input, c.tokens.cacheRead, c.tokens.cacheWrite, c.tokens.output, c.tokens.reasoning, c.cost, c.aiu, c.ttftMs, c.durationMs, c.finish,
  ].map(csvField).join(','))
  return [CSV_HEADERS.join(','), ...rows].join('\r\n') + '\r\n'
}

export function csvFilename(scope: UsageScope, now: number): string {
  const id = (scope.id ?? 'all').replace(/[^A-Za-z0-9._-]+/g, '_')
  return `occ-usage-${scope.kind}-${id}-${new Date(now).toISOString().slice(0, 10)}.csv`
}

/** Per-call helpers for the ledger. */
export const callInflow = (c: UsageSample): number => inflowOf(c.tokens)
export const callOutflow = (c: UsageSample): number => outflowOf(c.tokens)
