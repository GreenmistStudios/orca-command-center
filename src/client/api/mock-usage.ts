/**
 * Mock token usage (`?mock=1`): a per-call ledger for the mock fleet, per-session rollups and
 * `UsageReport`s built with the SAME shared math the server uses — so every report equals the sum
 * of the mock's own samples. Pure data builders (no timers); `mock.ts` drives the live loop.
 */
import {
  LIMITS, type FleetStats, type SessionSummary, type SessionUsage, type TokenUsage, type UsageCallsPage, type UsageOutput,
  type UsageReport, type UsageSample, type UsageScope,
} from '../../shared/contract'
import {
  addSample, breakdown, bucketize, buildSankey, chooseBucketMs, compareSamples, emptyTotals, inflowOf, outflowOf, ratesOf, totalsOf,
} from '../../shared/usage-math'
import type { MockWorld } from './mock-data'

const MIN = 60_000

/** USD per million tokens (public list prices). */
export interface PriceSheet { input: number; output: number; cacheRead: number; cacheWrite: number }

export function priceFor(modelId: string | null): PriceSheet {
  const m = (modelId ?? '').toLowerCase()
  if (m.includes('opus')) return { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }
  if (m.includes('sonnet')) return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
  if (m.includes('haiku')) return { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
  return { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }
}

export function costOf(t: TokenUsage, p: PriceSheet): number {
  return (t.input * p.input + (t.output + t.reasoning) * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6
}

type Rnd = () => number
const between = (r: Rnd, lo: number, hi: number) => lo + r() * (hi - lo)

export interface CallShape {
  tokens: TokenUsage
  cost: number | null
  aiu: number | null
  ttftMs: number
  durationMs: number
}

/**
 * One realistic call: cache read dominates the prompt (`context` tokens), fresh input is tiny, output
 * 1–6k, reasoning 0–4k, cache write now and then. Live calls pass `live` for smaller outputs.
 */
export function genCall(r: Rnd, s: SessionSummary, context: number, live = false): CallShape {
  const fresh = Math.round(between(r, 20, 900))
  const cacheWrite = r() < 0.3 ? Math.round(between(r, 500, 8000)) : 0
  const cacheRead = Math.max(0, Math.round(context) - fresh - cacheWrite)
  const output = Math.round(live ? between(r, 200, 2500) : between(r, 1000, 6000))
  const reasoning = r() < 0.5 ? 0 : Math.round(live ? between(r, 100, 1200) : between(r, 200, 4000))
  const tokens: TokenUsage = { input: fresh, output, reasoning, cacheRead, cacheWrite }
  const copilot = s.harness === 'copilot'
  const durationMs = Math.round(live ? between(r, 1500, 4000) : between(r, 3000, 40_000))
  const ttftMs = Math.round(Math.min(between(r, 400, 2000), durationMs * 0.6))
  return {
    tokens,
    cost: copilot ? null : costOf(tokens, priceFor(s.model?.modelId ?? null)),
    aiu: copilot ? Math.round((0.05 + (inflowOf(tokens) * 3e-7 + outflowOf(tokens) * 4e-6) * 10) * 1e4) / 1e4 : null,
    ttftMs,
    durationMs,
  }
}

export function makeSample(world: MockWorld, s: SessionSummary, n: number, ts: number, c: CallShape, finish: string): UsageSample {
  const copilot = s.harness === 'copilot'
  return {
    id: copilot ? `copilot:${s.id}:call:${n}` : `opencode:prt_mock_${s.id}_${n}`,
    harness: s.harness, sessionId: s.id, rootId: s.rootId, ledgerSeq: 0, ts, startTs: ts - c.durationMs, model: s.model, agent: s.agent,
    tokens: c.tokens, cost: c.cost, aiu: c.aiu, ttftMs: c.ttftMs, durationMs: c.durationMs, finish,
    source: copilot ? 'copilot.model_call_success' : 'opencode.step-finish',
  }
}

/** Ledger append: assigns the next ledgerSeq and indexes by session. */
export function appendSample(world: MockWorld, x: UsageSample): UsageSample {
  x.ledgerSeq = ++world.ledgerSeq
  world.usage.push(x)
  const list = world.usageBySession.get(x.sessionId) ?? []
  list.push(x)
  world.usageBySession.set(x.sessionId, list)
  return x
}

/** Seed metered calls over every session's lifetime. Uses its own rng so existing mock data is unchanged. */
export function seedUsage(world: MockWorld, r: Rnd): void {
  const now = world.now
  const all: Array<{ s: SessionSummary; n: number; ts: number; c: CallShape; finish: string }> = []
  for (const s of world.sessions.values()) {
    const start = s.createdAt + 5_000
    const end = Math.min(now - 2_000, Math.max(start + 30_000, s.lastActivityAt ?? s.updatedAt))
    const span = end - start
    const n = Math.max(3, Math.min(120, Math.round(span / 40_000)))
    const growth = between(r, 60_000, 140_000)
    const compactAt = n > 60 ? Math.floor(n * between(r, 0.5, 0.7)) : -1
    for (let i = 0; i < n; i++) {
      const ts = Math.round(start + ((i + r() * 0.9) / n) * span)
      const frac = (i - (compactAt >= 0 && i >= compactAt ? compactAt * 0.8 : 0)) / n
      const c = genCall(r, s, 8_000 + frac * growth)
      all.push({ s, n: i + 1, ts, c, finish: i === n - 1 ? 'stop' : 'tool-calls' })
    }
  }
  all.sort((a, b) => a.ts - b.ts)
  for (const a of all) appendSample(world, makeSample(world, a.s, a.n, a.ts, a.c, a.finish))
}

/* ───────────────────────── rollups ───────────────────────── */

export function sessionTotals(world: MockWorld, id: string) {
  return totalsOf(world.usageBySession.get(id) ?? [])
}

/** tokens/cost on a session summary equal Σ of its samples. */
export function sessionTokensCost(world: MockWorld, id: string): { tokens: TokenUsage; cost: number } {
  const t = sessionTotals(world, id)
  return { tokens: { ...t.tokens }, cost: t.cost }
}

export function sessionUsageOf(world: MockWorld, s: SessionSummary, now: number): SessionUsage {
  const own = world.usageBySession.get(s.id) ?? []
  const t = totalsOf(own)
  let tree: SessionUsage['tree'] = null
  if (s.parentId == null) {
    const members = [...world.sessions.values()].filter((x) => x.rootId === s.id)
    const tt = emptyTotals()
    for (const m of members) for (const x of world.usageBySession.get(m.id) ?? []) addSample(tt, x)
    tree = {
      sessions: members.length, calls: tt.calls, tokens: { ...tt.tokens }, inflow: tt.inflow, outflow: tt.outflow, cost: tt.cost,
      costedCalls: tt.costedCalls, aiu: tt.aiu,
    }
  }
  return {
    calls: t.calls, inflow: t.inflow, outflow: t.outflow, aiu: t.aiu, cacheHitRate: t.cacheHitRate, tree,
    rates: s.live ? ratesOf(own, now, 5 * MIN) : null,
    inFlight: world.estimates.get(s.id) ?? null,
  }
}

export function fleetUsage(world: MockWorld, now: number): NonNullable<FleetStats['usage']> {
  const sorted = [...world.usage].sort(compareSamples)
  return { totals: totalsOf(sorted.filter((x) => x.ts >= now - 24 * 60 * MIN)), rates: ratesOf(sorted, now, 5 * MIN) }
}

/* ───────────────────────── scope & reports ───────────────────────── */

export function sessionsInScope(world: MockWorld, scope: UsageScope): SessionSummary[] | null {
  const all = [...world.sessions.values()]
  switch (scope.kind) {
    case 'fleet': return all
    case 'session': return world.sessions.has(scope.id ?? '') ? all.filter((s) => s.id === scope.id) : null
    case 'workflow': return world.sessions.has(scope.id ?? '') ? all.filter((s) => s.rootId === scope.id) : null
    case 'run': {
      const run = world.runs.find((x) => x.run.id === scope.id)
      if (!run) return null
      const coord = run.run.coordinatorSessionId
      return all.filter((s) => {
        const root = world.sessions.get(s.rootId)
        return s.orca?.runId === scope.id || root?.orca?.runId === scope.id || (!!coord && s.rootId === coord)
      })
    }
  }
}

export interface ReportOpts { windowHours?: number; bucketMs?: number; middle?: 'agent' | 'session' | 'model'; output?: UsageOutput | null }

export function buildUsageReport(world: MockWorld, scope: UsageScope, o: ReportOpts, now: number): UsageReport | null {
  const members = sessionsInScope(world, scope)
  if (!members) return null
  const ids = new Set(members.map((m) => m.id))
  const windowMs = o.windowHours != null ? o.windowHours * 60 * MIN : null
  const from = windowMs != null ? now - windowMs : null
  const samples = world.usage
    .filter((x) => ids.has(x.sessionId) && (from == null || x.ts >= from))
    .sort(compareSamples)
  const fromTs = from ?? samples[0]?.ts ?? now
  const bucketMs = o.bucketMs ?? chooseBucketMs(now - fromTs)
  const middle = o.middle ?? (scope.kind === 'workflow' ? 'session' : 'agent')
  const title = (id: string) => world.sessions.get(id)?.title ?? id
  const labels = { session: title }
  const totals = totalsOf(samples)
  const inFlight = [...world.estimates.values()].filter((e) => ids.has(e.sessionId))
  const withUsage = new Set(samples.map((x) => x.sessionId))
  return {
    scope, windowMs, generatedAt: now, ledgerSeq: world.ledgerSeq, totals, rates: ratesOf(samples, now, 5 * MIN),
    series: { bucketMs, buckets: bucketize(samples, fromTs, now, bucketMs) },
    byModel: breakdown(samples, 'model'), byAgent: breakdown(samples, 'agent'), bySession: breakdown(samples, 'session', labels), byHarness: breakdown(samples, 'harness'),
    sankey: buildSankey(samples, middle, middle === 'session' ? { label: title } : undefined),
    recentCalls: samples.slice(-LIMITS.usageReportCalls), inFlight,
    output: scope.kind === 'workflow' || scope.kind === 'session' ? (o.output ?? null) : null,
    coverage: { sessions: members.length, sessionsWithUsage: withUsage.size, notes: [] },
  }
}

export function buildUsageCalls(world: MockWorld, scope: UsageScope, before: string | undefined, limit: number): UsageCallsPage | null {
  const members = sessionsInScope(world, scope)
  if (!members) return null
  const ids = new Set(members.map((m) => m.id))
  const all = world.usage.filter((x) => ids.has(x.sessionId)).sort(compareSamples)
  const end = before != null && before !== '' ? Math.max(0, Math.min(all.length, Number(before))) : all.length
  const start = Math.max(0, end - limit)
  return { calls: all.slice(start, end), before: start > 0 ? String(start) : null, hasMore: start > 0 }
}

