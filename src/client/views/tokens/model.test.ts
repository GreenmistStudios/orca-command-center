import { describe, expect, it } from 'vitest'
import type { UsageSample, UsageSankey } from '../../../shared/contract'
import { CSV_HEADERS, RateTracker, callsToCsv, csvField, csvFilename, effectiveWindow, linkIdsFor, mergeCalls, resolveTokensScope, DAY_MS } from './model'
import { stableUsageScope } from '../../state/selectors'

const smp = (id: string, over: Partial<UsageSample> = {}): UsageSample => ({
  id, harness: 'opencode', sessionId: 's1', rootId: 'r1', ledgerSeq: 1, ts: 1_800_000_000_000, startTs: null,
  model: { providerId: 'anthropic', modelId: 'claude' }, agent: 'coder', tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 100, cacheWrite: 0 },
  cost: 0.01, aiu: null, ttftMs: 500, durationMs: 2000, finish: 'stop', source: 't', ...over,
})

const sankey: UsageSankey = {
  middle: 'agent',
  nodes: [
    { id: 'src:input', label: 'Input', column: 0, kind: 'source', flow: 'input', sessionId: null, value: 10, cost: null },
    { id: 'mid:coder', label: 'coder', column: 1, kind: 'middle', flow: null, sessionId: null, value: 115, cost: 0.01 },
    { id: 'sink:output', label: 'Output', column: 2, kind: 'sink', flow: 'output', sessionId: null, value: 5, cost: null },
  ],
  links: [
    { id: 'src:input→mid:coder', source: 'src:input', target: 'mid:coder', flow: 'input', value: 10 },
    { id: 'mid:coder→sink:output', source: 'mid:coder', target: 'sink:output', flow: 'output', value: 5 },
  ],
}

describe('csv', () => {
  it('quotes per RFC 4180', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('l1\nl2')).toBe('"l1\nl2"')
    expect(csvField(null)).toBe('')
    expect(csvField(0)).toBe('0')
  })
  it('emits headers and one row per call', () => {
    const csv = callsToCsv([smp('a', { agent: 'x,y' }), smp('b', { cost: null, model: null })])
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[0]).toBe(CSV_HEADERS.join(','))
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('"x,y"')
    expect(lines[1]).toContain('anthropic/claude')
    expect(lines[2].split(',').slice(5, 6)).toEqual([''])
  })
  it('names the file by scope and date', () => {
    expect(csvFilename(stableUsageScope('workflow', 'ses_a/b'), Date.UTC(2026, 9, 26, 12))).toBe('occ-usage-workflow-ses_a_b-2026-10-26.csv')
    expect(csvFilename(stableUsageScope('fleet', null), Date.UTC(2026, 9, 26))).toBe('occ-usage-fleet-all-2026-10-26.csv')
  })
})

describe('RateTracker', () => {
  it('adds x/τ per sample and decays with τ = 8 s', () => {
    const t = new RateTracker(8)
    t.add('l', 800, 0)
    expect(t.snapshot(0).l).toBeCloseTo(100)
    expect(t.snapshot(8000).l).toBeCloseTo(100 / Math.E, 3)
    expect(t.snapshot(8000 + 120_000).l).toBeUndefined()
    expect(t.active).toBe(false)
  })
  it('seeds from sustained per-minute rates by link share', () => {
    const t = new RateTracker()
    t.seed(sankey, 600, 60)
    const r = t.snapshot(0)
    expect(r['src:input→mid:coder']).toBeCloseTo(10)
    expect(r['mid:coder→sink:output']).toBeCloseTo(1)
  })
})

describe('linkIdsFor', () => {
  it('maps a sample onto existing links only, falling back to other', () => {
    expect(linkIdsFor(smp('a'), sankey)).toEqual([['src:input→mid:coder', 10], ['mid:coder→sink:output', 5]])
    expect(linkIdsFor(smp('a', { agent: 'zzz' }), sankey)).toEqual([])
  })
})

describe('scope & window', () => {
  const sessions = { r1: { id: 'r1', rootId: 'r1', title: 'Root' }, s1: { id: 's1', rootId: 'r1', title: 'Child' } } as never
  it('disables options without a selection and falls back to fleet', () => {
    const r = resolveTokensScope('session', stableUsageScope('fleet', null), { selectedRootId: null, selectedSessionId: null, selectedRunId: null }, {}, undefined)
    expect(r.kind).toBe('fleet')
    expect(r.options.session.enabled).toBe(false)
    expect(r.options.run.enabled).toBe(false)
  })
  it('resolves workflow/session titles and keeps the auto scope object', () => {
    const auto = stableUsageScope('workflow', 'r1')
    const r = resolveTokensScope('auto', auto, { selectedRootId: null, selectedSessionId: 's1', selectedRunId: null }, sessions, undefined)
    expect(r.scope).toBe(auto)
    expect(r.title).toBe('Root')
    expect(r.options.session.title).toBe('Child')
  })
  it('fleet defaults to 24 h, others to all time', () => {
    expect(effectiveWindow(null, 'fleet')).toBe(DAY_MS)
    expect(effectiveWindow(null, 'session')).toBeNull()
    expect(effectiveWindow(900_000, 'fleet')).toBe(900_000)
  })
})

describe('mergeCalls', () => {
  it('unions by id keeping the higher ledgerSeq, newest first', () => {
    const m = mergeCalls([smp('a', { ts: 1 }), smp('b', { ts: 3 })], [smp('a', { ts: 1, ledgerSeq: 9, cost: 7 }), smp('c', { ts: 2 })])
    expect(m.map((c) => c.id)).toEqual(['b', 'c', 'a'])
    expect(m[2].cost).toBe(7)
  })
})
