import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageEstimate, UsageReport, UsageSample, UsageScope } from '../../shared/contract'
import { ratesOf, totalsOf } from '../../shared/usage-math'
import { MOCK_IDS } from '../api/mock-data'
import { createMockBackend, resetMockBackend } from '../api/mock'
import { mockBootstrap } from '../../../test/client/render'
import { selectAutoUsageScope, selectFleetBurn, selectInFlight, selectSessionUsage } from './selectors'
import { resetOccStore, USAGE_RING_MAX, usageReportKey, useOcc } from './store'
import { usageBus } from './usage-bus'
import { LiveUsageModel, METER_HOLD_MS, sampleInScope, useInFlightMeters, useLiveUsage, useUsageBurst, type UsageScopeCtx } from './usage-live'

const st = () => useOcc.getState()
const T0 = 1_800_000_000_000
let seqN = 100

function smp(id: string, over: Partial<UsageSample> = {}): UsageSample {
  return {
    id, harness: 'opencode', sessionId: MOCK_IDS.coderViewModel, rootId: MOCK_IDS.rootBuild, ledgerSeq: ++seqN, ts: T0 + seqN * 1000, startTs: null,
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-5.5' }, agent: 'sonnet-coder',
    tokens: { input: 100, output: 500, reasoning: 50, cacheRead: 9000, cacheWrite: 0 }, cost: 0.05, aiu: null, ttftMs: 800, durationMs: 5000, finish: 'tool-calls', source: 't', ...over,
  }
}
const est = (sessionId: string, over: Partial<UsageEstimate> = {}): UsageEstimate => ({
  sessionId, rootId: MOCK_IDS.rootBuild, harness: 'opencode', startedAt: T0, updatedAt: T0, estOutputTokens: 10, inFlight: true, ...over,
})
let frame = 9000
const usageFrame = (samples: UsageSample[], estimates: UsageEstimate[] = []) => st().applyStreamEvent({ type: 'usage', seq: ++frame, samples, estimates })

beforeEach(() => {
  history.replaceState(null, '', '/?mock=1')
  resetMockBackend()
  resetOccStore()
  usageBus.clear()
  st().applyBootstrap(mockBootstrap())
  seqN = 100
})
afterEach(() => { vi.useRealTimers(); usageBus.clear() })

describe('usage slice', () => {
  it('upserts samples keeping the higher ledgerSeq (equal replaces), in compareSamples order', () => {
    usageFrame([smp('b', { ts: T0 + 20, ledgerSeq: 5 }), smp('a', { ts: T0 + 10, ledgerSeq: 6 })])
    expect(st().usage.samples.order).toEqual(['a', 'b'])
    const v = st().usage.samples.version
    usageFrame([smp('a', { ts: T0 + 10, ledgerSeq: 4, cost: 9 })])
    expect(st().usage.samples.byId.a.cost).toBe(0.05) // lower seq ignored
    usageFrame([smp('a', { ts: T0 + 10, ledgerSeq: 6, cost: 7 })])
    expect(st().usage.samples.byId.a.cost).toBe(7) // equal replaces
    usageFrame([smp('a', { ts: T0 + 30, ledgerSeq: 8 })]) // ts moved → reordered
    expect(st().usage.samples.order).toEqual(['b', 'a'])
    expect(st().usage.samples.order).toHaveLength(2)
    expect(st().usage.samples.version).toBeGreaterThan(v)
  })

  it('caps the ring at 50,000 dropping the oldest', () => {
    const many = Array.from({ length: USAGE_RING_MAX + 5 }, (_, i) => smp(`m${i}`, { ts: T0 + i, ledgerSeq: i + 1 }))
    usageFrame(many)
    expect(st().usage.samples.order).toHaveLength(USAGE_RING_MAX)
    expect(st().usage.samples.byId.m0).toBeUndefined()
    expect(st().usage.samples.byId[`m${USAGE_RING_MAX + 4}`]).toBeDefined()
  })

  it('sets estimates and deletes them when inFlight is false', () => {
    usageFrame([], [est('s1'), est('s2')])
    expect(Object.keys(st().usage.estimates).sort()).toEqual(['s1', 's2'])
    usageFrame([], [est('s1', { inFlight: false })])
    expect(Object.keys(st().usage.estimates)).toEqual(['s2'])
  })

  it('emits on the bus after the state update; a throwing listener does not break others', () => {
    const seen: Array<{ n: number; version: number }> = []
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    usageBus.subscribe(() => { throw new Error('boom') })
    usageBus.subscribe((ev) => seen.push({ n: ev.samples.length, version: st().usage.samples.version }))
    const before = st().usage.samples.version
    usageFrame([smp('x'), smp('y')], [est('s1')])
    expect(seen).toEqual([{ n: 2, version: before + 1 }])
    expect(err).toHaveBeenCalled()
    const off = usageBus.subscribe(() => seen.push({ n: -1, version: 0 }))
    off()
    usageFrame([smp('z')])
    expect(seen).toHaveLength(2)
  })

  it('bootstrap resync clears usage and caches', async () => {
    usageFrame([smp('x')], [est('s1')])
    await st().fetchUsageReport({ kind: 'fleet', id: null })
    expect(Object.keys(st().usageReports)).toHaveLength(1)
    st().applyBootstrap(mockBootstrap())
    expect(st().usage.samples.order).toEqual([])
    expect(st().usage.estimates).toEqual({})
    expect(st().usageReports).toEqual({})
    expect(st().usageCalls).toEqual({})
  })

  it('persists token prefs', () => {
    st().setTokensPrefs({ units: 'cost', windowMs: 3_600_000 })
    expect(st().ui.tokens).toMatchObject({ units: 'cost', windowMs: 3_600_000, scale: 'balanced' })
    expect(JSON.parse(localStorage.getItem('occ-tokens')!)).toMatchObject({ units: 'cost' })
  })
})

describe('fetchers', () => {
  it('fetchUsageReport caches by key; fetchUsageCalls pages older merged', async () => {
    history.replaceState(null, '', '/?mock=1')
    await st().fetchUsageReport({ kind: 'workflow', id: MOCK_IDS.rootBuild }, { windowMs: null })
    const key = usageReportKey({ kind: 'workflow', id: MOCK_IDS.rootBuild }, null)
    expect(st().usageReports[key].status).toBe('ready')
    expect(st().usageReports[key].data!.scope).toEqual({ kind: 'workflow', id: MOCK_IDS.rootBuild })
    await st().fetchUsageCalls({ kind: 'fleet', id: null })
    const first = st().usageCalls['fleet:'].data!
    expect(first.calls.length).toBe(200)
    expect(first.hasMore).toBe(true)
    await st().fetchUsageCalls({ kind: 'fleet', id: null }, { older: true })
    const merged = st().usageCalls['fleet:'].data!
    expect(merged.calls.length).toBeGreaterThan(200)
    expect(new Set(merged.calls.map((c) => c.id)).size).toBe(merged.calls.length)
  })

  it('stores errors for unknown ids', async () => {
    await st().fetchUsageReport({ kind: 'session', id: 'nope' })
    expect(st().usageReports[usageReportKey({ kind: 'session', id: 'nope' }, null)].status).toBe('error')
  })
})

describe('selectors', () => {
  it('auto scope: run → run, session → workflow of its root, else fleet (stable refs)', () => {
    st().selectSession(MOCK_IDS.coderTests)
    const a = selectAutoUsageScope(st())
    expect(a).toEqual({ kind: 'workflow', id: MOCK_IDS.rootBuild })
    expect(selectAutoUsageScope(st())).toBe(a)
    st().selectRun(MOCK_IDS.runBoard)
    expect(selectAutoUsageScope(st())).toEqual({ kind: 'run', id: MOCK_IDS.runBoard })
    st().selectRun(null); st().selectSession(null)
    expect(selectAutoUsageScope(st())).toEqual({ kind: 'fleet', id: null })
  })

  it('session usage, in-flight and fleet burn', () => {
    expect(selectSessionUsage(st(), MOCK_IDS.rootBuild)?.tree?.sessions).toBe(7)
    expect(selectSessionUsage(st(), 'zzz')).toBeNull()
    usageFrame([], [est(MOCK_IDS.coderViewModel), est(MOCK_IDS.copilot, { rootId: MOCK_IDS.copilot, harness: 'copilot' })])
    const wf = selectInFlight(st(), { kind: 'workflow', id: MOCK_IDS.rootBuild })
    expect(wf.map((e) => e.sessionId)).toEqual([MOCK_IDS.coderViewModel])
    expect(selectInFlight(st(), { kind: 'workflow', id: MOCK_IDS.rootBuild })).toBe(wf)
    const burn0 = selectFleetBurn(st())
    expect(burn0.inFlight).toBe(2)
    const asOf = st().stats!.usage!.rates.asOf
    usageFrame([smp('burn1', { ts: asOf + 1000, cost: 1, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 60_000, cacheWrite: 0 } })])
    const burn1 = selectFleetBurn(st())
    expect(burn1.costPerHour).toBeGreaterThan(burn0.costPerHour)
    expect(burn1.tokensPerMin).toBeGreaterThan(burn0.tokensPerMin)
  })
})

describe('scope membership', () => {
  const ctx = (): UsageScopeCtx => ({ sessions: st().sessions, orchestration: st().orchestration })
  it('covers fleet, workflow, session and run', () => {
    const child = smp('c1')
    const other = smp('o1', { sessionId: MOCK_IDS.blocked, rootId: MOCK_IDS.blocked })
    const noRoot = smp('n1', { rootId: null })
    const scopes: Array<[UsageScope, boolean, boolean, boolean]> = [
      [{ kind: 'fleet', id: null }, true, true, true],
      [{ kind: 'workflow', id: MOCK_IDS.rootBuild }, true, false, true], // fallback to the session's rootId
      [{ kind: 'session', id: MOCK_IDS.coderViewModel }, true, false, true],
      [{ kind: 'session', id: MOCK_IDS.rootBuild }, false, false, false],
      [{ kind: 'run', id: MOCK_IDS.runBoard }, false, false, false],
    ]
    for (const [scope, a, b, c] of scopes) {
      expect([sampleInScope(child, scope, ctx()), sampleInScope(other, scope, ctx()), sampleInScope(noRoot, scope, ctx())]).toEqual([a, b, c])
    }
    // run: sessions linked via orca.runId (the coordinator) or the run's coordinatorSessionId
    const coord = smp('r1', { sessionId: MOCK_IDS.waiting, rootId: MOCK_IDS.waiting })
    expect(sampleInScope(coord, { kind: 'run', id: MOCK_IDS.runBoard }, ctx())).toBe(true)
    expect(sampleInScope(coord, { kind: 'run', id: MOCK_IDS.runSpike }, ctx())).toBe(false)
  })
})

/* ───────── live merge ───────── */

function baseReport(scope: UsageScope, windowMs: number | null = null) {
  const b = createMockBackend({ now: T0, live: false })
  return b.get('GET /api/usage', { params: { scope: scope.kind, id: scope.id ?? undefined, windowHours: windowMs ? windowMs / 3_600_000 : undefined } })
}

describe('LiveUsageModel', () => {
  const ctx = () => ({ sessions: st().sessions, orchestration: st().orchestration })
  const scope: UsageScope = { kind: 'workflow', id: MOCK_IDS.rootBuild }

  it('applies only ledgerSeq > watermark, exactly once, equal to a rebuild (no gap, no double count)', async () => {
    const report: UsageReport = await baseReport(scope)
    const m = new LiveUsageModel(report, scope, ctx())
    const w = report.ledgerSeq
    const old = smp('old', { ledgerSeq: w, ts: T0 - 5000 })
    const a = smp('live-a', { ledgerSeq: w + 1, ts: T0 + 1000 })
    const b = smp('live-b', { ledgerSeq: w + 2, ts: T0 + 2000, sessionId: MOCK_IDS.exploreBackoff })
    const foreign = smp('live-x', { ledgerSeq: w + 3, ts: T0 + 3000, sessionId: MOCK_IDS.blocked, rootId: MOCK_IDS.blocked })
    expect(m.ingest([old, a, b, foreign], T0 + 4000)).toBe(2)
    expect(m.ingest([old, a, b, foreign], T0 + 4000)).toBe(0) // exactly once
    const snap = m.snapshot(T0 + 4000)
    const expected = totalsOf([...report.recentCalls, a, b])
    expect(snap.totals.calls).toBe(report.totals.calls + 2)
    expect(snap.totals.tokens.cacheRead).toBe(report.totals.tokens.cacheRead + a.tokens.cacheRead + b.tokens.cacheRead)
    expect(snap.totals.cost).toBeCloseTo(report.totals.cost + 0.1, 9)
    expect(snap.totals.lastTs).toBe(expected.lastTs)
    expect(snap.series.buckets.reduce((n, x) => n + x.calls, 0)).toBe(report.series.buckets.reduce((n, x) => n + x.calls, 0) + 2)
    expect(snap.recentCalls.at(-1)!.id).toBe('live-b')
    expect(snap.bySession.find((r) => r.key === MOCK_IDS.exploreBackoff)!.totals.calls).toBe(
      report.bySession.find((r) => r.key === MOCK_IDS.exploreBackoff)!.totals.calls + 1)
    expect(snap.sankey.nodes.reduce((n, x) => (x.kind === 'source' ? n + x.value : n), 0)).toBeGreaterThan(
      report.sankey.nodes.reduce((n, x) => (x.kind === 'source' ? n + x.value : n), 0))
    expect(report.totals.calls).not.toBe(snap.totals.calls) // baseline untouched (structural clone)
    expect(m.lastSampleAt).toBe(T0 + 2000)
  })

  it('merged report equals a rebuild from baseline + live samples (series, breakdown)', async () => {
    const report = await baseReport({ kind: 'fleet', id: null })
    const m = new LiveUsageModel(report, { kind: 'fleet', id: null }, ctx())
    const live = [1, 2, 3].map((i) => smp(`l${i}`, { ledgerSeq: report.ledgerSeq + i, ts: T0 + i * 1000, sessionId: MOCK_IDS.rootBuild, rootId: MOCK_IDS.rootBuild, agent: 'build' }))
    m.ingest(live, T0 + 4000)
    const snap = m.snapshot(T0 + 4000)
    const agentRow = snap.byAgent.find((r) => r.key === 'build')!
    const baseRow = report.byAgent.find((r) => r.key === 'build')!
    expect(agentRow.totals.calls).toBe(baseRow.totals.calls + 3)
    expect(snap.byModel.reduce((n, r) => n + r.totals.calls, 0)).toBe(report.totals.calls + 3)
    expect(snap.byAgent.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1, 6)
  })

  it('slides a windowed scope: drops old buckets and recomputes rates from live samples', async () => {
    const win = 3_600_000
    const report = await baseReport({ kind: 'fleet', id: null }, win)
    const m = new LiveUsageModel(report, { kind: 'fleet', id: null }, ctx())
    const first = report.series.buckets[0].t
    m.ingest([smp('w1', { ledgerSeq: report.ledgerSeq + 1, ts: T0 + 10 * 60_000 })], T0 + 10 * 60_000)
    const snap = m.snapshot(T0 + 10 * 60_000)
    expect(snap.series.buckets[0].t).toBeGreaterThan(first)
    expect(snap.series.buckets.at(-1)!.t).toBeGreaterThanOrEqual(Math.floor((T0 + 10 * 60_000) / report.series.bucketMs) * report.series.bucketMs)
    expect(snap.rates.asOf).toBe(T0 + 10 * 60_000)
    expect(snap.rates.windowMs).toBe(report.rates.windowMs)
    const sorted = [...report.recentCalls, smp('w1', { ledgerSeq: 0, ts: T0 + 10 * 60_000 })].sort((a, b) => a.ts - b.ts)
    expect(snap.rates.callsPerMin).toBeCloseTo(ratesOf(sorted, T0 + 10 * 60_000, report.rates.windowMs).callsPerMin, 9)
  })

  it('seeds the series when the baseline has no buckets and keeps in-flight from estimates', async () => {
    const empty = await baseReport({ kind: 'session', id: MOCK_IDS.rootBuild })
    empty.series.buckets = []
    const m = new LiveUsageModel(empty, { kind: 'session', id: MOCK_IDS.rootBuild }, ctx())
    m.ingest([smp('e1', { sessionId: MOCK_IDS.rootBuild, ledgerSeq: empty.ledgerSeq + 1 })], T0 + 1000)
    m.setInFlight([est(MOCK_IDS.rootBuild)])
    const snap = m.snapshot(T0 + 1000)
    expect(snap.series.buckets.length).toBeGreaterThan(0)
    expect(snap.inFlight).toHaveLength(1)
    m.ingest([smp('e2', { sessionId: MOCK_IDS.rootBuild, ledgerSeq: empty.ledgerSeq + 2 })], T0 + 2000)
    expect(m.snapshot(T0 + 2000).inFlight).toHaveLength(0) // metered sample supersedes the estimate
  })
})

describe('useLiveUsage / useUsageBurst', () => {
  const scope: UsageScope = { kind: 'workflow', id: MOCK_IDS.rootBuild }

  it('fetches the baseline, applies live samples once and throttles recomputes to ≤ 4 Hz', async () => {
    vi.useFakeTimers({ now: T0 })
    const seen = new Set<UsageReport>()
    const { result, unmount } = renderHook(() => { const r = useLiveUsage(scope); if (r.report) seen.add(r.report); return r })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const base = result.current.report!
    expect(result.current.status).toBe('ready')
    const w = base.ledgerSeq
    const n = base.totals.calls
    const before = seen.size
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    const afterIdle = seen.size
    // A burst of frames (incl. a replayed upsert) collapses into one recompute at the next 250 ms slot.
    await act(async () => {
      for (let i = 1; i <= 5; i++) {
        usageFrame([smp(`h${i}`, { ledgerSeq: w + i, ts: Date.now() + i })])
        await vi.advanceTimersByTimeAsync(10)
      }
      usageFrame([smp('h1', { ledgerSeq: w + 1, ts: Date.now() + 1 })])
    })
    expect(result.current.report!.totals.calls).toBeLessThan(n + 5) // still within the throttle slot
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(result.current.report!.totals.calls).toBe(n + 5) // each sample counted once
    expect(seen.size - afterIdle).toBeLessThanOrEqual(2)
    expect(result.current.lastSampleAt).not.toBeNull()
    expect(before).toBeGreaterThan(0)
    unmount()
  })

  it('re-fetches the baseline on option change, every 60 s and after > 1000 deltas', async () => {
    vi.useFakeTimers({ now: T0 })
    const spy = vi.fn(st().fetchUsageReport)
    useOcc.setState({ fetchUsageReport: spy })
    const { rerender, result, unmount } = renderHook((p: { w: number | null }) => useLiveUsage(scope, { windowMs: p.w }), { initialProps: { w: null as number | null } })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(result.current.report).not.toBeNull()
    const calls = spy.mock.calls.length
    rerender({ w: 3_600_000 })
    expect(spy.mock.calls.length).toBe(calls + 1)
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ windowMs: 3_600_000, force: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(spy.mock.calls.length).toBeGreaterThan(calls + 1)
    const afterInterval = spy.mock.calls.length
    const w = result.current.report!.ledgerSeq
    await act(async () => {
      usageFrame(Array.from({ length: 1001 }, (_, i) => smp(`d${i}`, { ledgerSeq: w + 1 + i, ts: Date.now() })))
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(spy.mock.calls.length).toBeGreaterThan(afterInterval)
    unmount()
  })

  it('useUsageBurst calls back only for in-scope samples and estimates', () => {
    const got: string[] = []
    renderHook(() => useUsageBurst(scope, (x) => got.push('id' in x ? x.id : `est:${x.sessionId}`)))
    usageFrame([smp('in1'), smp('out1', { sessionId: MOCK_IDS.blocked, rootId: MOCK_IDS.blocked })], [est(MOCK_IDS.coderViewModel), est(MOCK_IDS.blocked, { rootId: MOCK_IDS.blocked })])
    expect(got).toEqual(['in1', `est:${MOCK_IDS.coderViewModel}`])
  })
})


describe('live corrections (re-sent ids)', () => {
  const ctx = () => ({ sessions: st().sessions, orchestration: st().orchestration })
  const scope: UsageScope = { kind: 'workflow', id: MOCK_IDS.rootBuild }

  it('live id re-sent: identical → no change; changed → counted once with the new value', async () => {
    const report: UsageReport = await baseReport(scope)
    const m = new LiveUsageModel(report, scope, ctx())
    const a = smp('dup-a', { ledgerSeq: report.ledgerSeq + 1, ts: T0 + 1000 })
    m.ingest([a], T0 + 2000)
    const s1 = m.snapshot(T0 + 2000)
    m.ingest([{ ...a, ledgerSeq: a.ledgerSeq + 1 }], T0 + 2000)
    expect(m.snapshot(T0 + 2000).totals).toEqual(s1.totals)
    const b = { ...a, ledgerSeq: a.ledgerSeq + 2, tokens: { ...a.tokens, output: a.tokens.output + 1000 } }
    m.ingest([b], T0 + 2000)
    const s2 = m.snapshot(T0 + 2000)
    expect(s2.totals.calls).toBe(s1.totals.calls)
    expect(s2.totals.tokens.output).toBe(s1.totals.tokens.output + 1000)
    expect(s2.totals.outflow).toBe(s1.totals.outflow + 1000)
    expect(s2.byAgent.find((r) => r.key === 'sonnet-coder')!.totals.tokens.output).toBe(s1.byAgent.find((r) => r.key === 'sonnet-coder')!.totals.tokens.output + 1000)
    expect(s2.series.buckets.reduce((n, x) => n + x.calls, 0)).toBe(s1.series.buckets.reduce((n, x) => n + x.calls, 0))
    expect(s2.series.buckets.reduce((n, x) => n + x.output, 0)).toBe(s1.series.buckets.reduce((n, x) => n + x.output, 0) + 1000)
    const sum = (r: UsageReport) => r.sankey.links.filter((l) => l.flow === 'output').reduce((n, l) => n + l.value, 0)
    expect(sum(s2)).toBe(sum(s1) + 1000)
  })

  it('baseline recent id updated → only the difference', async () => {
    const report: UsageReport = await baseReport(scope)
    const old = report.recentCalls.at(-1)!
    const m = new LiveUsageModel(report, scope, ctx())
    m.ingest([{ ...old, ledgerSeq: report.ledgerSeq + 5 }], T0)
    expect(m.snapshot(T0).totals).toEqual(report.totals)
    m.ingest([{ ...old, ledgerSeq: report.ledgerSeq + 6, tokens: { ...old.tokens, input: old.tokens.input + 7 } }], T0)
    const snap = m.snapshot(T0)
    expect(snap.totals.calls).toBe(report.totals.calls)
    expect(snap.totals.tokens.input).toBe(report.totals.tokens.input + 7)
  })
})

describe('bus dedupe', () => {
  it('exact re-emit at equal ledgerSeq is not re-emitted', () => {
    const seen: UsageSample[] = []
    usageBus.subscribe((ev) => seen.push(...ev.samples))
    const a = smp('e1')
    usageFrame([a]); usageFrame([{ ...a }])
    expect(seen).toHaveLength(1)
    usageFrame([{ ...a, tokens: { ...a.tokens, output: 1 } }])
    expect(seen).toHaveLength(2)
  })
})

describe('15m window', () => {
  it('fetchUsageReport works end to end with windowMinutes', async () => {
    await st().fetchUsageReport({ kind: 'fleet', id: null }, { windowMs: 15 * 60_000, force: true })
    const l = st().usageReports[usageReportKey({ kind: 'fleet', id: null }, 15 * 60_000)]
    expect(l?.status).toBe('ready')
    expect(l?.data?.windowMs).toBe(15 * 60_000)
  })
  it('mock rejects both params / out of range', async () => {
    const b = createMockBackend({ now: T0, live: false })
    await expect(b.get('GET /api/usage', { params: { scope: 'fleet', windowHours: 1, windowMinutes: 15 } })).rejects.toBeTruthy()
    await expect(b.get('GET /api/usage', { params: { scope: 'fleet', windowMinutes: 0 } })).rejects.toBeTruthy()
    await expect(b.get('GET /api/usage', { params: { scope: 'fleet', windowMinutes: 43_201 } })).rejects.toBeTruthy()
  })
})

describe('useInFlightMeters', () => {
  const scope: UsageScope = { kind: 'workflow', id: MOCK_IDS.rootBuild }
  const sid = MOCK_IDS.coderViewModel
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0) })

  it('estimate → sample → metered entry → dropped after hold', () => {
    const { result } = renderHook(() => useInFlightMeters(scope))
    act(() => { usageFrame([], [est(sid, { startedAt: T0, estOutputTokens: 40 })]); vi.advanceTimersByTime(300) })
    expect(result.current).toHaveLength(1)
    expect(result.current[0]).toMatchObject({ sessionId: sid, estTokens: 40, metered: null, done: false })
    act(() => { vi.advanceTimersByTime(1000); usageFrame([], [est(sid, { inFlight: false })]); usageFrame([smp('m1', { ts: T0 + 1100 })]); vi.advanceTimersByTime(300) })
    expect(result.current[0]).toMatchObject({ metered: 550, done: true })
    const ref = result.current
    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current).toBe(ref)
    act(() => { vi.advanceTimersByTime(METER_HOLD_MS + 500) })
    expect(result.current).toHaveLength(0)
  })

  it('sample arriving before the estimate ends still morphs', () => {
    const { result } = renderHook(() => useInFlightMeters(scope))
    act(() => { usageFrame([], [est(sid)]); vi.advanceTimersByTime(300) })
    act(() => { usageFrame([smp('m2', { ts: T0 + 100 })]); vi.advanceTimersByTime(300) })
    act(() => { usageFrame([], [est(sid, { inFlight: false })]); vi.advanceTimersByTime(300) })
    expect(result.current[0]).toMatchObject({ metered: 550, done: true })
  })

  it('no sample within 5 s → dropped; out-of-scope ignored', () => {
    const { result } = renderHook(() => useInFlightMeters(scope))
    act(() => { usageFrame([], [est(sid), est('ses-elsewhere', { rootId: 'other-root' })]); vi.advanceTimersByTime(300) })
    expect(result.current.map((e) => e.sessionId)).toEqual([sid])
    act(() => { usageFrame([], [est(sid, { inFlight: false })]); vi.advanceTimersByTime(300) })
    expect(result.current).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(5200) })
    expect(result.current).toHaveLength(0)
  })
})
