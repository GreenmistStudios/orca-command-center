import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HarnessUpdate, Config, SourceDeps } from '../../types.js'
import { createToolClassifier } from '../../lib/tool-classify.js'
import { createCopilotFixture, SECRET_PROMPT_SENTINEL, type ShutdownModelMetric } from '../../../../test/fixtures/copilot.js'
import { createCopilotSource } from './source.js'
import { SessionModel } from './model.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'copilot-sum-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const M = 'claude-sonnet-5.5'
const metric = (input: number, cr: number, cw: number, out: number, reasoning: number, aiu: number, withDetails = true): ShutdownModelMetric => ({
  requests: { count: 3, cost: 1 },
  usage: { inputTokens: input + cr + cw, outputTokens: out + reasoning, cacheReadTokens: cr, cacheWriteTokens: cw, reasoningTokens: reasoning },
  totalNanoAiu: aiu * 1e9,
  ...(withDetails ? { tokenDetails: { input: { tokenCount: input } } } : {}),
})

function build(mode: 'per-run' | 'cumulative', fx: ReturnType<typeof createCopilotFixture>, events: ReturnType<typeof fx.event>[]) {
  const m = new SessionModel('s1', createToolClassifier({ knownServers: [] }))
  m.shutdownMode = mode
  for (const e of events) m.ingest(JSON.stringify(e))
  return m
}
const sum = (m: SessionModel) => {
  const t = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let aiu = 0
  for (const u of m.samples.values()) {
    for (const k of Object.keys(t) as Array<keyof typeof t>) t[k] += u.tokens[k]
    aiu += u.aiu ?? 0
  }
  return { t, aiu }
}

describe('session-summary usage', () => {
  it('emits the remainder after subtracting same-model calls; other models untouched; Σ == shutdown totals', () => {
    const fx = createCopilotFixture(tmp)
    const m = build('per-run', fx, [
      fx.ev.sessionStart(),
      fx.ev.modelCallSuccess({ prompt: 300, cached: 100, cacheWrite: 50, completion: 40, reasoning: 10, nanoAiu: 2e9, callId: 'a' }),
      fx.ev.shutdown({ modelMetrics: { [M]: metric(1000, 5000, 200, 700, 30, 10), 'gpt-x': metric(7, 0, 0, 3, 0, 0.5) } }),
    ])
    const sums = [...m.samples.values()].filter((s) => s.source === 'copilot.session-summary')
    expect(sums).toHaveLength(2)
    const a = sums.find((s) => s.model?.modelId === M)!
    expect(a.tokens).toEqual({ input: 1000 - 150, cacheRead: 5000 - 100, cacheWrite: 200 - 50, output: 670, reasoning: 20 })
    expect(a.aiu).toBeCloseTo(8, 9)
    expect(a).toMatchObject({ finish: 'session-summary', durationMs: null, ttftMs: null, cost: null, agent: 'copilot', model: { providerId: 'github-copilot', modelId: M } })
    expect(a.id).toMatch(/^copilot:s1:summary:.+:claude-sonnet-5\.5$/)
    expect(a.startTs).not.toBeNull()
    const o = sums.find((s) => s.model?.modelId === 'gpt-x')!
    expect(o.tokens).toEqual({ input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    const { t, aiu } = sum(m)
    expect(t).toEqual({ input: 1007, cacheRead: 5000, cacheWrite: 200, output: 703, reasoning: 30 })
    expect(aiu).toBeCloseTo(10.5, 6)
    expect(m.toSession().tokens).toEqual(t)
  })

  it('clamps at zero, derives fresh input without tokenDetails, skips all-zero remainders', () => {
    const fx = createCopilotFixture(tmp)
    const m = build('per-run', fx, [
      fx.ev.sessionStart(),
      fx.ev.modelCallSuccess({ prompt: 500, completion: 50, nanoAiu: 3e9, callId: 'a' }),
      fx.ev.shutdown({ modelMetrics: { [M]: metric(100, 0, 0, 10, 0, 1, false), z: metric(0, 0, 0, 0, 0, 0) } }),
    ])
    const sums = [...m.samples.values()].filter((s) => s.source === 'copilot.session-summary')
    expect(sums).toHaveLength(0) // calls exceed totals → clamped to zero → skipped
    const m2 = build('per-run', fx, [fx.ev.sessionStart(), fx.ev.shutdown({ modelMetrics: { [M]: metric(0, 0, 0, 0, 0, 0, false), w: { ...metric(0, 40, 10, 5, 0, 0, false), usage: { inputTokens: 60, outputTokens: 5, cacheReadTokens: 40, cacheWriteTokens: 10 } } } })])
    const only = [...m2.samples.values()]
    expect(only).toHaveLength(1)
    expect(only[0]!.tokens).toEqual({ input: 10, cacheRead: 40, cacheWrite: 10, output: 5, reasoning: 0 })
  })

  it('multiple shutdowns: per-run is additive, cumulative subtracts earlier totals', () => {
    const mk = () => {
      const fx = createCopilotFixture(tmp)
      return [
        fx.ev.sessionStart(),
        fx.ev.modelCallSuccess({ prompt: 20, completion: 5, nanoAiu: 1e9, callId: 'c1' }),
        fx.ev.shutdown({ modelMetrics: { [M]: metric(100, 0, 0, 50, 0, 4) } }),
        fx.ev.sessionStart(),
        fx.ev.modelCallSuccess({ prompt: 10, completion: 2, nanoAiu: 1e9, callId: 'c2' }),
        fx.ev.shutdown({ modelMetrics: { [M]: metric(60, 0, 0, 30, 0, 2) } }),
      ]
    }
    const fx = createCopilotFixture(tmp)
    const per = build('per-run', fx, mk())
    expect(sum(per).t).toEqual({ input: 160, output: 80, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(sum(per).aiu).toBeCloseTo(6, 6)
    const cum = build('cumulative', fx, mk().map((e) => e).map((e, i) => (i === 5 ? { ...e, data: { ...e.data, modelMetrics: { [M]: metric(160, 0, 0, 80, 0, 6) } } } : e)))
    expect(sum(cum).t).toEqual({ input: 160, output: 80, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(sum(cum).aiu).toBeCloseTo(6, 6)
    const ids = [...per.samples.keys()].filter((k) => k.includes(':summary:'))
    expect(new Set(ids).size).toBe(2)
    const second = per.samples.get(ids[1]!)!
    const first = per.samples.get(ids[0]!)!
    expect(second.startTs).toBe(first.ts)
  })

  it('live session shows checkpoint facts and no synthetic tokens; ended session drops them', () => {
    const fx = createCopilotFixture(tmp)
    const m = build('per-run', fx, [fx.ev.sessionStart(), fx.ev.usage(3, 12_345_000_000)])
    const facts = m.toSession().facts
    expect(facts).toContainEqual({ label: 'AI units so far', value: '12.35' })
    expect(facts).toContainEqual({ label: 'Premium requests', value: '3' })
    expect(facts).toContainEqual({ label: 'Token usage', value: 'reported when the session ends' })
    expect(m.toSession().tokens).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    m.ingest(JSON.stringify(fx.ev.shutdown({ modelMetrics: { [M]: metric(1, 0, 0, 1, 0, 1) } })))
    expect(m.toSession().facts.some((f) => f.label === 'Token usage' || f.label === 'AI units so far')).toBe(false)
  })

  it('live tail of a shutdown emits summary samples; no sentinel leakage', async () => {
    const fx = createCopilotFixture(tmp)
    fx.createSession('live', { events: [fx.ev.sessionStart(), fx.ev.turnStart('1')] })
    const config = { copilotDir: tmp, windowMs: 30 * 86_400_000, mcpServers: [] } as unknown as Config
    const log = { debug() {}, info() {}, warn() {}, error() {} }
    const src = createCopilotSource({ config, log, now: () => Date.now() } as SourceDeps, { pollMs: 25 })
    const updates: HarnessUpdate[] = []
    src.subscribe((u) => updates.push(u))
    await src.start()
    try {
      const sd = fx.ev.shutdown({ modelMetrics: { [M]: { ...metric(10, 20, 5, 7, 2, 1.5), requestMessages: SECRET_PROMPT_SENTINEL, quotaSnapshots: SECRET_PROMPT_SENTINEL } as ShutdownModelMetric } })
      fx.append('live', [sd])
      const deadline = Date.now() + 4000
      const got = () => updates.filter((u): u is Extract<HarnessUpdate, { type: 'usage' }> => u.type === 'usage').flatMap((u) => u.samples)
      while (got().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
      expect(got().map((s) => s.source)).toEqual(['copilot.session-summary'])
      expect(src.getUsageSamples!(['live']).map((s) => s.source)).toEqual(['copilot.session-summary'])
      expect(src.getSession('live')!.tokens).toEqual({ input: 10, cacheRead: 20, cacheWrite: 5, output: 7, reasoning: 2 })
      expect(JSON.stringify([updates, src.listSessions(0)])).not.toContain(SECRET_PROMPT_SENTINEL)
    } finally {
      await src.stop()
    }
  })
})
