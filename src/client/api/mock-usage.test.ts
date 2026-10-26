import { describe, expect, it } from 'vitest'
import type { StreamEvent, UsageSample, UsageScope } from '../../shared/contract'
import { LIMITS } from '../../shared/contract'
import { compareSamples, inflowOf, totalsOf } from '../../shared/usage-math'
import { createMockBackend, MOCK_IDS } from './mock'

const NOW = 1_800_000_000_000
const mk = () => createMockBackend({ now: NOW, live: false })

describe('mock usage ledger', () => {
  const b = mk()
  const w = b.world

  it('is realistic: cache-read dominant, list prices, Copilot aiu with null cost', () => {
    const all = w.usage
    const t = totalsOf(all.filter((x) => x.harness === 'opencode'))
    expect(t.tokens.cacheRead).toBeGreaterThan(t.inflow * 0.8)
    expect(t.tokens.input).toBeLessThan(t.inflow * 0.05)
    for (const x of all) {
      expect(x.ttftMs!).toBeGreaterThanOrEqual(400)
      expect(x.ttftMs!).toBeLessThanOrEqual(2000)
      expect(x.durationMs!).toBeGreaterThanOrEqual(3000)
      expect(x.durationMs!).toBeLessThanOrEqual(40_000)
      expect(x.tokens.output).toBeGreaterThanOrEqual(1000)
      expect(x.tokens.output).toBeLessThanOrEqual(6000)
    }
    const opus = all.find((x) => x.model?.modelId === 'claude-opus-5.5')!
    const p = opus.tokens
    expect(opus.cost).toBeCloseTo((p.input * 15 + (p.output + p.reasoning) * 75 + p.cacheRead * 1.5 + p.cacheWrite * 18.75) / 1e6, 9)
    const sonnet = all.find((x) => x.model?.modelId === 'claude-sonnet-5.5')!
    const q = sonnet.tokens
    expect(sonnet.cost).toBeCloseTo((q.input * 3 + (q.output + q.reasoning) * 15 + q.cacheRead * 0.3 + q.cacheWrite * 3.75) / 1e6, 9)
    const cop = all.filter((x) => x.sessionId === MOCK_IDS.copilot)
    expect(cop.length).toBeGreaterThan(3)
    expect(cop.every((x) => x.cost === null && (x.aiu ?? 0) > 0 && x.harness === 'copilot')).toBe(true)
    expect(new Set(all.map((x) => x.id)).size).toBe(all.length)
    expect(all.some((x) => x.tokens.cacheWrite > 0)).toBe(true)
    expect(all.some((x) => x.tokens.reasoning === 0)).toBe(true)
  })

  it('summaries equal Σ of their samples, roots carry tree totals, live sessions carry rates', () => {
    for (const s of w.sessions.values()) {
      const t = totalsOf(w.usage.filter((x) => x.sessionId === s.id))
      expect(s.tokens).toEqual(t.tokens)
      expect(s.cost).toBeCloseTo(t.cost, 9)
      expect(s.usage?.calls).toBe(t.calls)
      expect(s.usage?.inflow).toBe(t.inflow)
    }
    const root = w.sessions.get(MOCK_IDS.rootBuild)!
    const tree = totalsOf(w.usage.filter((x) => x.rootId === MOCK_IDS.rootBuild))
    expect(root.usage!.tree).toMatchObject({ sessions: 7, calls: tree.calls, inflow: tree.inflow, outflow: tree.outflow })
    expect(root.usage!.rates).not.toBeNull()
    expect(w.sessions.get(MOCK_IDS.coderPolicy)!.usage!.tree).toBeNull()
    expect(w.sessions.get(MOCK_IDS.done)!.usage!.rates).toBeNull()
    const stats = b.bootstrap().stats
    expect(stats.usage!.totals.calls).toBe(w.usage.length)
  })

  const scopes: UsageScope[] = [
    { kind: 'fleet', id: null },
    { kind: 'workflow', id: MOCK_IDS.rootBuild },
    { kind: 'session', id: MOCK_IDS.coderViewModel },
    { kind: 'run', id: MOCK_IDS.runBoard },
  ]
  for (const scope of scopes) {
    it(`report totals == Σ samples · ${scope.kind}`, async () => {
      const r = await b.get('GET /api/usage', { params: { scope: scope.kind, id: scope.id ?? undefined } })
      const ids = new Set(
        [...w.sessions.values()]
          .filter((s) => scope.kind === 'fleet' || (scope.kind === 'workflow' ? s.rootId === scope.id : scope.kind === 'session' ? s.id === scope.id : s.rootId === MOCK_IDS.waiting))
          .map((s) => s.id),
      )
      const mine = w.usage.filter((x) => ids.has(x.sessionId))
      const t = totalsOf(mine)
      expect(r.totals.calls).toBe(t.calls)
      expect(r.totals.calls).toBeGreaterThan(0)
      expect(r.totals.tokens).toEqual(t.tokens)
      expect(r.totals.cost).toBeCloseTo(t.cost, 9)
      expect(r.ledgerSeq).toBe(w.ledgerSeq)
      expect(r.series.buckets.reduce((n, x) => n + x.calls, 0)).toBe(t.calls)
      expect(r.byModel.reduce((n, x) => n + x.totals.calls, 0)).toBe(t.calls)
      expect(r.bySession.reduce((n, x) => n + x.totals.inflow, 0)).toBe(t.inflow)
      expect(r.sankey.links.filter((l) => l.source.startsWith('src:')).reduce((n, l) => n + l.value, 0)).toBe(t.inflow)
      expect(r.recentCalls.length).toBe(Math.min(t.calls, LIMITS.usageReportCalls))
      expect(r.recentCalls.slice().sort(compareSamples)).toEqual(r.recentCalls)
      expect(r.output === null).toBe(scope.kind === 'fleet' || scope.kind === 'run')
      expect(r.coverage.sessions).toBe(ids.size)
    })
  }

  it('windows, 404/400 and calls paging', async () => {
    const full = await b.get('GET /api/usage', { params: { scope: 'fleet' } })
    const hour = await b.get('GET /api/usage', { params: { scope: 'fleet', windowHours: 1 } })
    expect(hour.windowMs).toBe(3_600_000)
    expect(hour.totals.calls).toBeLessThan(full.totals.calls)
    expect(totalsOf(w.usage.filter((x) => x.ts >= Date.now() - 3_600_000 - 5000)).calls).toBeGreaterThanOrEqual(hour.totals.calls - 5)
    await expect(b.get('GET /api/usage', { params: { scope: 'session', id: 'nope' } })).rejects.toMatchObject({ status: 404 })
    await expect(b.get('GET /api/usage', { params: { scope: 'session' } })).rejects.toMatchObject({ status: 400 })
    await expect(b.get('GET /api/usage', { params: { scope: 'wat' } })).rejects.toMatchObject({ status: 400 })
    const p1 = await b.get('GET /api/usage/calls', { params: { scope: 'fleet', limit: 50 } })
    expect(p1.calls).toHaveLength(50)
    const p2 = await b.get('GET /api/usage/calls', { params: { scope: 'fleet', limit: 50, before: p1.before! } })
    expect(p2.calls.at(-1)!.ts).toBeLessThanOrEqual(p1.calls[0].ts)
    expect(new Set([...p1.calls, ...p2.calls].map((x) => x.id)).size).toBe(100)
  })
})

describe('mock live usage', () => {
  it('estimates exist for working sessions and grow every tick', () => {
    const b = mk()
    const working = [...b.world.sessions.values()].filter((s) => s.live && s.state === 'working').map((s) => s.id)
    expect(working).toEqual(expect.arrayContaining([MOCK_IDS.rootBuild, MOCK_IDS.coderViewModel, MOCK_IDS.copilot]))
    expect([...b.world.estimates.keys()].sort()).toEqual([...working].sort())
    expect(b.bootstrap().sessions.find((s) => s.id === MOCK_IDS.rootBuild)!.usage!.inFlight).not.toBeNull()
    expect(b.world.estimates.has(MOCK_IDS.blocked)).toBe(false)
  })

  it('finishes a call every 1.5–4 s with sample + summary + next estimate; ledgerSeq increases', () => {
    const b = mk()
    const frames: StreamEvent[] = []
    b.connect((e) => frames.push(e))
    const seq0 = b.world.ledgerSeq
    const start = NOW + 100
    const samples: UsageSample[] = []
    let grew = false
    for (let t = start; t <= start + 20_000; t += 400) {
      const n = frames.length
      b.tickUsage(t)
      for (const f of frames.slice(n)) {
        if (f.type !== 'usage') continue
        samples.push(...f.samples)
        if (f.estimates.some((e) => e.inFlight && e.estOutputTokens > 0)) grew = true
        for (const e of f.estimates) expect(['inFlight', 'sessionId', 'startedAt', 'updatedAt', 'estOutputTokens', 'rootId', 'harness']).toEqual(expect.arrayContaining(Object.keys(e)))
      }
    }
    expect(grew).toBe(true)
    expect(samples.length).toBeGreaterThanOrEqual(4)
    expect(samples.map((s) => s.ledgerSeq)).toEqual(Array.from({ length: samples.length }, (_, i) => seq0 + 1 + i))
    for (const s of samples) {
      expect(s.cost === null).toBe(s.harness === 'copilot')
      expect(s.durationMs!).toBeGreaterThanOrEqual(1400)
      expect(s.durationMs!).toBeLessThanOrEqual(4500)
      expect(inflowOf(s.tokens)).toBeGreaterThan(s.tokens.cacheRead * 0.9)
    }
    const perSession = samples.filter((s) => s.sessionId === MOCK_IDS.rootBuild).length
    expect(perSession).toBeGreaterThanOrEqual(3)
    expect(perSession).toBeLessThanOrEqual(14)
    // a sessions frame accompanied the samples, and summaries still equal Σ samples
    const last = [...frames].reverse().find((f) => f.type === 'sessions' && f.sessions.some((s) => s.id === MOCK_IDS.rootBuild))
    expect(last).toBeDefined()
    const root = b.world.sessions.get(MOCK_IDS.rootBuild)!
    expect(root.tokens).toEqual(totalsOf(b.world.usage.filter((x) => x.sessionId === MOCK_IDS.rootBuild)).tokens)
    // a report fetched now carries the new watermark
    return b.get('GET /api/usage', { params: { scope: 'fleet' } }).then((r) => {
      expect(r.ledgerSeq).toBe(b.world.ledgerSeq)
      expect(r.totals.calls).toBe(b.world.usage.length)
    })
  })

  it('ends the estimate when a session stops working', () => {
    const b = mk()
    const frames: StreamEvent[] = []
    b.connect((e) => frames.push(e))
    const cp = b.world.sessions.get(MOCK_IDS.copilot)!
    cp.state = 'waiting'
    b.tickUsage(NOW + 400)
    const u = frames.find((f) => f.type === 'usage')!
    expect(u.type === 'usage' && u.estimates.find((e) => e.sessionId === MOCK_IDS.copilot)?.inFlight).toBe(false)
    expect(b.world.estimates.has(MOCK_IDS.copilot)).toBe(false)
  })
})
