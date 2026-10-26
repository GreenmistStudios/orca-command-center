import { describe, expect, it } from 'vitest'
import type { UsageEstimate, UsageSample } from '../../shared/contract.js'
import { pageCalls, buildUsageReport } from './usage-report.js'
import { ESTIMATE_TTL_MS, UsageLedger } from './usage-ledger.js'

let t = 1_000_000
const sample = (id: string, sessionId: string, ts: number, over: Partial<UsageSample> = {}): UsageSample => ({
  id,
  harness: 'opencode',
  sessionId,
  rootId: null,
  ledgerSeq: 0,
  ts,
  startTs: null,
  model: { providerId: 'p', modelId: 'm' },
  agent: 'build',
  tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 10, cacheWrite: 0 },
  cost: 0.5,
  aiu: null,
  ttftMs: null,
  durationMs: null,
  finish: null,
  source: 'opencode.step-finish',
  ...over,
})
const parents = new Map<string, string | null>()
const make = (max?: number) =>
  new UsageLedger({ now: () => t, rootOf: (id) => { let c = id; for (let i = 0; i < 10 && parents.get(c); i++) c = parents.get(c)!; return c }, maxSamples: max, evictIdleMs: 1000 })
const est = (sessionId: string, updatedAt: number, inFlight = true): UsageEstimate => ({ sessionId, rootId: null, harness: 'opencode', startedAt: updatedAt, updatedAt, estOutputTokens: 5, inFlight })

describe('UsageLedger', () => {
  it('assigns monotonic seq, resolves roots and keeps per-session order', () => {
    parents.clear()
    parents.set('c', 'r')
    const l = make()
    const acc = l.ingest([sample('b', 'c', 20), sample('a', 'c', 10), sample('z', 'r', 5)])
    expect(acc.map((s) => s.ledgerSeq)).toEqual([1, 2, 3])
    expect(acc.map((s) => s.rootId)).toEqual(['r', 'r', 'r'])
    expect(l.samplesOf('c').map((s) => s.id)).toEqual(['a', 'b'])
    expect(l.ledgerSeq).toBe(3)
  })

  it('upserts: identical re-ingest is a no-op, changes replace with a new seq', () => {
    const l = make()
    l.ingest([sample('a', 's', 10)])
    expect(l.ingest([sample('a', 's', 10)])).toEqual([])
    expect(l.ledgerSeq).toBe(1)
    const acc = l.ingest([sample('a', 's', 12, { cost: 9 })])
    expect(acc[0]!.ledgerSeq).toBe(2)
    expect(l.samplesOf('s')).toHaveLength(1)
    expect(l.totalsOf('s').cost).toBe(9)
  })

  it('non-billable drift updates in place, keeps seq, is not published', () => {
    const l = make()
    l.ingest([sample('a', 's', 10)])
    const acc = l.ingest([sample('a', 's', 12, { ttftMs: 5, durationMs: 9, startTs: 3, agent: 'plan' })])
    expect(acc).toEqual([])
    expect(l.ledgerSeq).toBe(1)
    const [s] = l.samplesOf('s')
    expect(s).toMatchObject({ ts: 12, ttftMs: 5, agent: 'plan', ledgerSeq: 1 })
    expect(l.samplesOf('s')).toHaveLength(1)
    expect(l.ingest([sample('a', 's', 12, { ttftMs: 5, durationMs: 9, startTs: 3, agent: 'plan', aiu: 2 })])[0]!.ledgerSeq).toBe(2)
  })

  it('re-resolves roots when parents are discovered later', () => {
    parents.clear()
    const l = make()
    l.ingest([sample('a', 'c', 10)])
    expect(l.get('a')!.rootId).toBe('c')
    parents.set('c', 'r')
    expect(l.rerootAll()).toEqual(['c'])
    expect(l.get('a')!.rootId).toBe('r')
    expect(l.samplesOf('c')[0]!.rootId).toBe('r')
    expect(l.get('a')!.ledgerSeq).toBe(1)
  })

  it('evicts idle fully-loaded sessions only above the cap, never protected ones', () => {
    parents.clear()
    const l = make(3)
    l.ingest([sample('a1', 'old', 1), sample('a2', 'old', 2), sample('b1', 'win', 3), sample('c1', 'idle2', 4)])
    l.markLoaded(['old', 'win', 'idle2'])
    l.touch(['old'])
    t += 5000
    l.touch(['idle2'])
    expect(l.evict((id) => id === 'win')).toEqual(['old'])
    expect(l.size).toBe(2)
    expect(l.isLoaded('old')).toBe(false)
    expect(l.stats()).toMatchObject({ evictedSessions: 1, evictedSamples: 2 })
    // under the cap: nothing more
    expect(l.evict(() => false)).toEqual([])
  })

  it('does not evict when everything is protected', () => {
    const l = make(1)
    l.ingest([sample('a', 's1', 1), sample('b', 's2', 2)])
    l.markLoaded(['s1', 's2'])
    t += 5000
    expect(l.evict(() => true)).toEqual([])
    expect(l.size).toBe(2)
  })

  it('expires estimates after 2 minutes and reports the end', () => {
    const l = make()
    l.setEstimate(est('s', t))
    expect(l.estimateOf('s')).not.toBeNull()
    t += ESTIMATE_TTL_MS + 1
    expect(l.estimateOf('s')).toBeNull()
    expect(l.estimates()).toEqual([])
    const ended = l.expireEstimates()
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ sessionId: 's', inFlight: false })
    l.setEstimate(est('s', t))
    l.setEstimate(est('s', t, false))
    expect(l.estimateOf('s')).toBeNull()
  })
})

describe('usage report builder', () => {
  const samples = [sample('a', 's1', 60_000), sample('b', 's2', 120_000, { agent: 'plan', model: { providerId: 'q', modelId: 'n' } }), sample('c', 's1', 180_000)]
  const base = {
    scope: { kind: 'workflow' as const, id: 's1' },
    windowMs: null,
    now: 200_000,
    ledgerSeq: 7,
    samples,
    allSamples: samples,
    estimates: [],
    output: null,
    coverage: { sessions: 2, sessionsWithUsage: 2, notes: [] },
    sessionLabel: (id: string) => `T-${id}`,
  }

  it('totals, breakdowns, sankey and series agree', () => {
    const r = buildUsageReport(base)
    expect(r.totals.calls).toBe(3)
    expect(r.totals.inflow).toBe(33)
    expect(r.totals.outflow).toBe(6)
    expect(r.byAgent.map((x) => x.key).sort()).toEqual(['build', 'plan'])
    expect(r.bySession.find((x) => x.key === 's1')!.label).toBe('T-s1')
    expect(r.byModel.find((x) => x.key === 'q/n')!.label).toBe('n')
    expect(r.sankey.middle).toBe('session')
    expect(r.series.buckets.reduce((n, b) => n + b.calls, 0)).toBe(3)
    expect(r.ledgerSeq).toBe(7)
    expect(r.recentCalls).toHaveLength(3)
  })

  it('pages newest-first with a ts:id cursor', () => {
    const p1 = pageCalls(samples, undefined, 2)
    expect(p1.calls.map((s) => s.id)).toEqual(['b', 'c'])
    expect(p1).toMatchObject({ hasMore: true, before: '120000:b' })
    const p2 = pageCalls(samples, p1.before!, 2)
    expect(p2.calls.map((s) => s.id)).toEqual(['a'])
    expect(p2).toMatchObject({ hasMore: false, before: null })
  })
})
