import { describe, expect, it } from 'vitest'
import type { UsageSample, UsageSankey } from './contract.js'
import {
  NICE_BUCKETS_MS, ZERO_TOKENS, addSample, addToBreakdown, addToSankey, addToSeries, addTokens, alignDown,
  breakdown, bucketize, buildSankey, cacheHitRate, chooseBucketMs, compareSamples, emptyTotals,
  estimateTokensFromChars, inflowOf, insertSorted, lowerBoundTs, mergeTotals, modelKey, outflowOf, percentile,
  ratesOf, sampleKeyOf, throughputTps, tokensOf, totalsOf, trimSeries, ttftStats,
} from './usage-math.js'

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let n = 0
function mk(p: Partial<UsageSample> = {}): UsageSample {
  n++
  return {
    id: `s${n}`, harness: 'opencode', sessionId: 'ses', rootId: null, ledgerSeq: 0, ts: 1000 + n,
    startTs: null, model: { providerId: 'p', modelId: 'm' }, agent: 'build',
    tokens: tokensOf({ input: 1, output: 2 }), cost: null, aiu: null, ttftMs: null, durationMs: null,
    finish: null, source: 't', ...p,
  }
}

describe('tokens', () => {
  it('tokensOf / add / flows', () => {
    expect(tokensOf()).toEqual(ZERO_TOKENS)
    expect(tokensOf({ input: NaN, output: 3, cacheRead: Infinity })).toEqual({ ...ZERO_TOKENS, output: 3 })
    const t = addTokens(tokensOf({ input: 1, cacheRead: 2, cacheWrite: 3 }), tokensOf({ output: 4, reasoning: 5 }))
    expect(inflowOf(t)).toBe(6)
    expect(outflowOf(t)).toBe(9)
    expect(cacheHitRate(t)).toBeCloseTo(1 / 3)
    expect(cacheHitRate(ZERO_TOKENS)).toBeNull()
  })
})

describe('totals', () => {
  it('verified real totals', () => {
    const samples = [
      mk({ tokens: { input: 100, output: 70_000, reasoning: 100_000, cacheRead: 10_000_000, cacheWrite: 1_000_000 }, cost: 10.5 }),
      mk({ tokens: { input: 52, output: 100_749, reasoning: 9_213, cacheRead: 10_483_274, cacheWrite: 811_581 }, cost: 8.2544 }),
    ]
    const t = totalsOf(samples)
    expect(t.tokens).toEqual({ input: 152, output: 170_749, reasoning: 109_213, cacheRead: 20_483_274, cacheWrite: 1_811_581 })
    expect(t.inflow).toBe(22_295_007)
    expect(t.outflow).toBe(279_962)
    expect(t.cacheHitRate).toBeCloseTo(0.91874, 4)
    expect(Math.abs(t.cost - 18.7544)).toBeLessThan(1e-9)
    expect(t.calls).toBe(2)
  })
  it('cost null / NaN handling and ts bounds', () => {
    const t = emptyTotals()
    addSample(t, mk({ cost: null, aiu: 1, ts: 50 }))
    addSample(t, mk({ cost: NaN, aiu: NaN, ts: 10 }))
    expect(t.costedCalls).toBe(0)
    expect(t.aiu).toBe(1)
    addSample(t, mk({ cost: 2, ts: 90 }))
    expect(t.costedCalls).toBe(1)
    expect(t.cost).toBe(2)
    expect([t.firstTs, t.lastTs]).toEqual([10, 90])
  })
  it('mergeTotals', () => {
    const a = totalsOf([mk({ cost: 1, ts: 5 })])
    const b = totalsOf([mk({ cost: 2, ts: 9 })])
    const m = mergeTotals(a, b)
    expect(m.calls).toBe(2)
    expect(m.cost).toBe(3)
    expect([m.firstTs, m.lastTs]).toEqual([5, 9])
    expect(a.calls).toBe(1)
    expect(mergeTotals(emptyTotals(), emptyTotals()).firstTs).toBeNull()
  })
})

describe('sorted samples', () => {
  it('insertSorted keeps order and replaces by id', () => {
    const arr: UsageSample[] = []
    insertSorted(arr, mk({ id: 'b', ts: 20 }))
    insertSorted(arr, mk({ id: 'a', ts: 20 }))
    insertSorted(arr, mk({ id: 'c', ts: 10 }))
    expect(arr.map((s) => s.id)).toEqual(['c', 'a', 'b'])
    const idx = insertSorted(arr, mk({ id: 'a', ts: 20, cost: 7 }))
    expect(idx).toBe(1)
    expect(arr).toHaveLength(3)
    expect(arr[1]!.cost).toBe(7)
    insertSorted(arr, mk({ id: 'c', ts: 30 }))
    expect(arr.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(arr.slice().sort(compareSamples)).toEqual(arr)
  })
  it('lowerBoundTs', () => {
    const arr = [10, 20, 20, 30].map((ts) => mk({ ts }))
    expect(lowerBoundTs(arr, 5)).toBe(0)
    expect(lowerBoundTs(arr, 20)).toBe(1)
    expect(lowerBoundTs(arr, 21)).toBe(3)
    expect(lowerBoundTs(arr, 99)).toBe(4)
  })
  it('ratesOf window edges (asOf-window, asOf]', () => {
    const arr = [mk({ ts: 940_000 }), mk({ ts: 940_001 }), mk({ ts: 1_000_000 }), mk({ ts: 1_000_001 })]
    const r = ratesOf(arr, 1_000_000, 60_000)
    expect(r.callsPerMin).toBe(2)
    expect(r.inflowPerMin).toBe(2)
    expect(r.outflowPerMin).toBe(4)
    const r2 = ratesOf(arr, 1_000_000, 120_000)
    expect(r2.callsPerMin).toBeCloseTo(1.5)
    const c = ratesOf([mk({ ts: 5, cost: 1 })], 10, 1_800_000)
    expect(c.costPerHour).toBeCloseTo(2)
  })
})

describe('buckets', () => {
  it('chooseBucketMs', () => {
    expect(NICE_BUCKETS_MS).toHaveLength(18)
    expect(chooseBucketMs(15 * 60_000)).toBe(5_000)
    expect(chooseBucketMs(3_600_000)).toBe(15_000)
    expect(chooseBucketMs(86_400_000)).toBe(600_000)
    expect(chooseBucketMs(7 * 86_400_000)).toBe(3_600_000)
    expect(chooseBucketMs(1e15)).toBe(86_400_000)
    expect(chooseBucketMs(0)).toBe(1000)
  })
  it('bucketize alignment and empties', () => {
    expect(alignDown(1234, 1000)).toBe(1000)
    const b = bucketize(
      [mk({ ts: 1500 }), mk({ ts: 4200 }), mk({ ts: 100 }), mk({ ts: 99_000 })], 1200, 4900, 1000,
    )
    expect(b.map((x) => x.t)).toEqual([1000, 2000, 3000, 4000])
    expect(b.map((x) => x.calls)).toEqual([1, 0, 0, 1])
    expect(b[0]!.input).toBe(1)
  })
  it('addToSeries ≡ bucketize (property)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed)
      const bucketMs = [1000, 5000, 60_000][Math.floor(rnd() * 3)]!
      const from = Math.floor(rnd() * 1e6)
      const samples = Array.from({ length: 40 }, () =>
        mk({
          ts: from + Math.floor(rnd() * 20 * bucketMs),
          tokens: tokensOf({ input: Math.floor(rnd() * 100), output: Math.floor(rnd() * 50), cacheRead: Math.floor(rnd() * 9) }),
          cost: rnd() < 0.5 ? null : rnd(),
        }),
      )
      samples.sort(compareSamples)
      const first = samples[0]!
      const series = { bucketMs, buckets: bucketize([first], from, first.ts, bucketMs) }
      for (const s of samples.slice(1)) addToSeries(series, s)
      const last = samples[samples.length - 1]!.ts
      const expected = bucketize(samples, from, last, bucketMs)
      expect(series.buckets.length).toBe(expected.length)
      series.buckets.forEach((b, i) => {
        expect(b.t).toBe(expected[i]!.t)
        expect(b.calls).toBe(expected[i]!.calls)
        expect(b.input).toBe(expected[i]!.input)
        expect(b.cost).toBeCloseTo(expected[i]!.cost, 9)
      })
    }
  })
  it('addToSeries ignores older, trimSeries drops', () => {
    const series = { bucketMs: 1000, buckets: bucketize([], 5000, 6000, 1000) }
    addToSeries(series, mk({ ts: 100 }))
    expect(series.buckets.every((b) => b.calls === 0)).toBe(true)
    addToSeries(series, mk({ ts: 8500 }))
    expect(series.buckets.map((b) => b.t)).toEqual([5000, 6000, 7000, 8000])
    trimSeries(series, 7000)
    expect(series.buckets.map((b) => b.t)).toEqual([7000, 8000])
    trimSeries(series, 7001)
    expect(series.buckets.map((b) => b.t)).toEqual([7000, 8000])
    trimSeries(series, 8001)
    expect(series.buckets.map((b) => b.t)).toEqual([8000])
  })
})

describe('breakdown', () => {
  const sams = () => [
    mk({ sessionId: 'a', model: { providerId: 'x', modelId: 'big' }, tokens: tokensOf({ input: 10 }), harness: 'opencode' }),
    mk({ sessionId: 'a', model: { providerId: 'x', modelId: 'big' }, tokens: tokensOf({ input: 10 }), harness: 'copilot' }),
    mk({ sessionId: 'b', model: null, agent: null, tokens: tokensOf({ output: 20 }) }),
    mk({ sessionId: 'c', tokens: tokensOf({ output: 20 }) }),
  ]
  it('keys, labels', () => {
    expect(modelKey(null)).toBe('unknown')
    expect(modelKey({ providerId: null, modelId: 'm' })).toBe('m')
    expect(modelKey({ providerId: 'p', modelId: 'm' })).toBe('p/m')
    const s = sams()
    expect(sampleKeyOf(s[2]!, 'agent')).toBe('unknown')
    expect(sampleKeyOf(s[0]!, 'harness')).toBe('opencode')
  })
  it('ordering, shares, harness, labels', () => {
    const rows = breakdown(sams(), 'session', { session: (id) => `S-${id}` })
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c'])
    expect(rows[0]!.label).toBe('S-a')
    expect(rows[0]!.sessionId).toBe('a')
    expect(rows[0]!.harness).toBeNull()
    expect(rows[1]!.harness).toBe('opencode')
    expect(rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1)
    expect(rows[0]!.share).toBeCloseTo(1 / 3)
    const m = breakdown(sams(), 'model')
    expect(m.find((r) => r.key === 'x/big')!.label).toBe('big')
    expect(m[0]!.sessionId).toBeNull()
    expect(breakdown([], 'agent')).toEqual([])
    expect(breakdown([mk({ tokens: ZERO_TOKENS })], 'agent')[0]!.share).toBe(0)
  })
  it('addToBreakdown ≡ breakdown', () => {
    const all = sams()
    const rows = breakdown(all.slice(0, 2), 'session')
    let total = 20
    for (const s of all.slice(2)) {
      total += inflowOf(s.tokens) + outflowOf(s.tokens)
      addToBreakdown(rows, s, 'session', total)
    }
    expect(rows).toEqual(breakdown(all, 'session'))
  })
})

function sorted(s: UsageSankey) {
  const by = <T extends { id: string }>(a: T[]) => [...a].sort((x, y) => (x.id < y.id ? -1 : 1))
  return { middle: s.middle, nodes: by(s.nodes), links: by(s.links) }
}

describe('sankey', () => {
  it('structure', () => {
    const s = buildSankey(
      [
        mk({ agent: 'a', tokens: tokensOf({ input: 5, cacheRead: 10, output: 3 }), cost: 1 }),
        mk({ agent: 'b', tokens: tokensOf({ input: 1, reasoning: 2 }) }),
      ],
      'agent',
    )
    expect(s.nodes.map((x) => x.id)).toEqual([
      'src:input', 'src:cacheRead', 'mid:a', 'mid:b', 'sink:output', 'sink:reasoning',
    ])
    expect(s.nodes.find((x) => x.id === 'src:cacheWrite')).toBeUndefined()
    expect(s.nodes.find((x) => x.id === 'src:input')!.label).toBe('Fresh input')
    expect(s.links.map((l) => l.id)).toContain('src:cacheRead→mid:a')
    expect(s.links.map((l) => l.id)).toContain('mid:a→sink:output')
    const a = s.nodes.find((x) => x.id === 'mid:a')!
    expect(a.value).toBe(15) // max(in 15, out 3): non-conservation
    expect(a.cost).toBe(1)
    expect(s.nodes.find((x) => x.id === 'mid:b')!.cost).toBeNull()
    expect(s.nodes.find((x) => x.id === 'src:input')!.value).toBe(6)
  })
  it('Other merge and session ids', () => {
    const sams = ['a', 'b', 'c', 'd'].map((k, i) => mk({ sessionId: k, tokens: tokensOf({ input: 10 - i }) }))
    const s = buildSankey(sams, 'session', { maxMiddle: 2, label: (k) => k.toUpperCase() })
    expect(s.nodes.filter((x) => x.kind === 'middle').map((x) => x.id)).toEqual(['mid:a', 'mid:b', 'mid:other'])
    const other = s.nodes.find((x) => x.id === 'mid:other')!
    expect(other.label).toBe('Other (2)')
    expect(other.value).toBe(8 + 7)
    expect(s.nodes.find((x) => x.id === 'mid:a')!.label).toBe('A')
    expect(s.nodes.find((x) => x.id === 'mid:a')!.sessionId).toBe('a')
    expect(buildSankey([], 'agent')).toEqual({ middle: 'agent', nodes: [], links: [] })
  })
  it('addToSankey ≡ buildSankey with stable membership (property)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed * 7)
      const keys = ['a', 'b', 'c', 'd']
      const gen = () =>
        mk({
          agent: keys[Math.floor(rnd() * keys.length)]!,
          tokens: tokensOf({
            input: Math.floor(rnd() * 9), cacheRead: Math.floor(rnd() * 90), cacheWrite: Math.floor(rnd() * 3),
            output: Math.floor(rnd() * 9), reasoning: Math.floor(rnd() * 5),
          }),
          cost: rnd() < 0.5 ? null : Math.floor(rnd() * 100) / 10,
        })
      const base = Array.from({ length: 30 }, gen)
      const extra = Array.from({ length: 30 }, gen)
      const sk = buildSankey(base, 'agent', { maxMiddle: 12 })
      for (const s of extra) addToSankey(sk, s, { maxMiddle: 12 })
      expect(sorted(sk)).toEqual(sorted(buildSankey([...base, ...extra], 'agent', { maxMiddle: 12 })))
    }
  })
  it('new key beyond top N goes to Other', () => {
    const sk = buildSankey([mk({ agent: 'a' }), mk({ agent: 'b' })], 'agent', { maxMiddle: 2 })
    addToSankey(sk, mk({ agent: 'c' }), { maxMiddle: 2 })
    addToSankey(sk, mk({ agent: 'd' }), { maxMiddle: 2 })
    addToSankey(sk, mk({ agent: 'd' }), { maxMiddle: 2 })
    expect(sk.nodes.find((x) => x.id === 'mid:c')).toBeUndefined()
    expect(sk.nodes.find((x) => x.id === 'mid:other')!.label).toBe('Other (2)')
    expect(sk.nodes.find((x) => x.id === 'mid:other')!.value).toBe(6)
  })
})

describe('throughput & stats', () => {
  it('throughputTps', () => {
    expect(throughputTps(mk({ tokens: tokensOf({ output: 50, reasoning: 50 }), durationMs: 2000, ttftMs: 1000 }))).toBe(100)
    expect(throughputTps(mk({ tokens: tokensOf({ output: 10 }), durationMs: 2000 }))).toBe(5)
    expect(throughputTps(mk({ durationMs: null }))).toBeNull()
    expect(throughputTps(mk({ durationMs: 1000, ttftMs: 1000 }))).toBeNull()
  })
  it('percentile / ttftStats', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([5], 0.95)).toBe(5)
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5)
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1)
    const st = ttftStats([100, 200, 300, null].map((t) => mk({ ttftMs: t })))
    expect(st).toEqual({ p50: 200, p95: 290, n: 3 })
    expect(ttftStats([])).toEqual({ p50: null, p95: null, n: 0 })
  })
  it('estimateTokensFromChars', () => {
    expect(estimateTokensFromChars(0)).toBe(0)
    expect(estimateTokensFromChars(1)).toBe(1)
    expect(estimateTokensFromChars(9)).toBe(3)
    expect(estimateTokensFromChars(-5)).toBe(0)
  })
})
