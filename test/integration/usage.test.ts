import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  SessionDetail,
  SessionSummary,
  StreamEvent,
  UsageCallsPage,
  UsageReport,
  UsageSample,
} from '../../src/shared/contract.js'
import { totalsOf } from '../../src/shared/usage-math.js'
import { FLEET, type OpenCodeFixture } from '../fixtures/opencode.js'
import { COORDINATOR_HANDLE, RICH_RUN_ID } from '../fixtures/orchestration.js'
import { TERMINAL_LIST_JSON } from '../fixtures/orca.js'
import { createEnv, hookEntry, type Env } from './env.js'

const TF = { root: 'ses_tf_root', child: 'ses_tf_child', old: 'ses_tf_old' } as const
const CALLS: Record<string, Array<{ i: number; o: number; r: number; cr: number; cw: number; cost: number }>> = {
  [TF.root]: [
    { i: 5, o: 100, r: 20, cr: 1000, cw: 300, cost: 0.11 },
    { i: 3, o: 60, r: 0, cr: 1400, cw: 0, cost: 0.07 },
    { i: 2, o: 80, r: 40, cr: 1800, cw: 0, cost: 0.09 },
  ],
  [TF.child]: [
    { i: 7, o: 30, r: 0, cr: 500, cw: 100, cost: 0.03 },
    { i: 1, o: 45, r: 5, cr: 650, cw: 0, cost: 0.04 },
  ],
  [TF.old]: [{ i: 9, o: 9, r: 0, cr: 90, cw: 0, cost: 0.02 }],
}

function seedWorkflow(fx: OpenCodeFixture, now: number): void {
  const ago = (s: number) => now - s * 1000
  const mk = (id: string, parentId: string | null, created: number, updated: number) => {
    const calls = CALLS[id]!
    const sum = (k: 'i' | 'o' | 'r' | 'cr' | 'cw' | 'cost') => calls.reduce((n, c) => n + c[k], 0)
    fx.addSession({
      id, parentId, title: `TF ${id}`, agent: 'build', model: { id: 'claude-opus-5.5', providerID: 'github-copilot' },
      directory: '/repo/tf', created, updated, cost: Math.round(sum('cost') * 1e6) / 1e6,
      tokens: { input: sum('i'), output: sum('o'), reasoning: sum('r'), cacheRead: sum('cr'), cacheWrite: sum('cw') },
    })
    calls.forEach((c, n) => {
      const t = created + (n + 1) * 20_000
      const msg = `msg_${id}_${n}`
      fx.addMessage({ id: msg, sessionId: id, created: t - 5000, data: { role: 'assistant', agent: 'build', modelID: 'claude-opus-5.5', providerID: 'github-copilot', time: { created: t - 5000 } } })
      fx.addStepStart({ id: `prt_${id}_${n}_s`, messageId: msg, sessionId: id, created: t - 4000 })
      fx.addStepFinish({ id: `prt_${id}_${n}_f`, messageId: msg, sessionId: id, created: t, tokens: { input: c.i, output: c.o, reasoning: c.r, cacheRead: c.cr, cacheWrite: c.cw }, cost: c.cost, reason: 'stop' })
    })
  }
  mk(TF.root, null, ago(1200), ago(600))
  mk(TF.child, TF.root, ago(1000), ago(500))
  mk(TF.old, null, ago(5 * 86400), ago(5 * 86400 - 300))
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6
const usage = (env: Env, q: string) => env.get<UsageReport>(`/api/usage?${q}`)

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as T
    if (Date.now() > end) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('usage reports & exactness', () => {
  let env: Env
  let startMs = 0
  beforeAll(async () => {
    const t0 = Date.now()
    const now = Date.now()
    const list = JSON.parse(TERMINAL_LIST_JSON)
    list.result.terminals[0].handle = COORDINATOR_HANDLE
    env = await createEnv({
      now,
      seedOpenCode: seedWorkflow,
      terminalListJson: JSON.stringify(list),
      hooks: [hookEntry({ providerSession: { key: 'session_id', id: FLEET.root }, payload: { state: 'working', agentType: 'opencode' }, receivedAt: now, stateStartedAt: now })],
    })
    startMs = Date.now() - t0
  })
  afterAll(() => env.close())

  it('boots without waiting for usage seeding, then fills in the background', async () => {
    // The 1.5 s boot budget is enforced on real data by scripts/perf.mjs. Here we only guard
    // against start() blocking on seeding, with headroom for CPU contention in the full suite.
    expect(startMs).toBeLessThan(5000)
    const b = await waitFor(async () => {
      const x = await env.bootstrap()
      return x.stats.usage && x.sessions.some((s) => s.id === TF.root && s.usage) ? x : null
    }, 20_000)
    expect(b.stats.usage!.totals.calls).toBeGreaterThan(5)
  })

  it('session totals equal the harness session tokens/cost exactly', async () => {
    for (const id of [TF.root, TF.child, FLEET.childDone]) {
      const r = await usage(env, `scope=session&id=${id}`)
      const d = await env.get<SessionDetail>(`/api/sessions/${id}`)
      expect(r.totals.tokens, id).toEqual(d.session.tokens)
      expect(near(r.totals.cost, d.session.cost), id).toBe(true)
      expect(d.session.usage?.calls).toBe(r.totals.calls)
      expect(r.coverage.sessionsWithUsage).toBe(1)
    }
    for (const c of [env.copilot!.finishedId, env.copilot!.liveId]) {
      const r = await usage(env, `scope=session&id=${c}`)
      const d = await env.get<SessionDetail>(`/api/sessions/${c}`)
      expect(r.totals.tokens, c).toEqual(d.session.tokens)
      expect(r.totals.aiu).toBeGreaterThan(0)
      expect(r.coverage.notes.join(' ')).toMatch(/Copilot CLI session.*report token totals only when they end/)
    }
  })

  it('keeps harness totals authoritative when the ledger disagrees (fixture root has one call)', async () => {
    const d = await env.get<SessionDetail>(`/api/sessions/${FLEET.root}`)
    const r = await usage(env, `scope=session&id=${FLEET.root}`)
    expect(d.session.tokens.input).toBe(1200)
    expect(r.totals.tokens.input).toBe(100)
  })

  it('workflow totals equal the sum of its sessions; any member id resolves to the root', async () => {
    const w = await usage(env, `scope=workflow&id=${TF.child}`)
    expect(w.scope).toEqual({ kind: 'workflow', id: TF.root })
    const rd = await env.get<SessionDetail>(`/api/sessions/${TF.root}`)
    const cd = await env.get<SessionDetail>(`/api/sessions/${TF.child}`)
    expect(w.totals.calls).toBe(5)
    expect(w.totals.tokens.output).toBe(rd.session.tokens.output + cd.session.tokens.output)
    expect(near(w.totals.cost, rd.session.cost + cd.session.cost)).toBe(true)
    expect(w.bySession.map((r) => r.key).sort()).toEqual([TF.child, TF.root])
    expect(w.bySession.find((r) => r.key === TF.root)!.label).toBe(`TF ${TF.root}`)
    expect(w.sankey.middle).toBe('session')
    expect(w.series.buckets.reduce((n, b) => n + b.calls, 0)).toBe(5)
    expect(w.output).not.toBeNull()
    expect(w.coverage).toMatchObject({ sessions: 2, sessionsWithUsage: 2 })
    expect(w.recentCalls).toHaveLength(5)
    expect(w.ledgerSeq).toBeGreaterThan(0)
    // totals are consistent with the shared math over the recent calls
    expect(totalsOf(w.recentCalls).tokens).toEqual(w.totals.tokens)
    const root = (await env.bootstrap()).sessions.find((s) => s.id === TF.root)!
    expect(root.usage!.tree).toMatchObject({ sessions: 2, calls: 5 })
    expect(root.usage!.tree!.tokens).toEqual(w.totals.tokens)
    expect(root.usage!.calls).toBe(3)
  })

  it('loads sessions outside the window on demand', async () => {
    const before = await env.bootstrap()
    expect(before.sessions.map((s) => s.id)).not.toContain(TF.old)
    const r = await usage(env, `scope=workflow&id=${TF.old}`)
    expect(r.totals.calls).toBe(1)
    expect(r.windowMs).toBeNull()
    const fleet = await usage(env, 'scope=fleet')
    expect(fleet.windowMs).toBe(env.config.windowMs)
    expect(fleet.bySession.map((x) => x.key)).not.toContain(TF.old)
  })

  it('fleet report matches FleetStats.usage; run scope links coordinator sessions', async () => {
    const fleet = await usage(env, 'scope=fleet')
    const stats = await env.get<{ usage?: { totals: { calls: number } } }>('/api/stats')
    expect(stats.usage!.totals.calls).toBe(fleet.totals.calls)
    expect(fleet.byHarness.map((h) => h.key).sort()).toEqual(['copilot', 'opencode'])
    const run = await usage(env, `scope=run&id=${RICH_RUN_ID}`)
    const wf = await usage(env, `scope=workflow&id=${FLEET.root}`)
    expect(run.scope).toEqual({ kind: 'run', id: RICH_RUN_ID })
    expect(run.totals.calls).toBe(wf.totals.calls)
    expect(run.output).toBeNull()
    expect((await fetch(`${env.base}/api/usage?scope=run&id=nope`)).status).toBe(404)
  })

  it('pages calls newest-first and 404s unknown ids', async () => {
    const p1 = await env.get<UsageCallsPage>(`/api/usage/calls?scope=workflow&id=${TF.root}&limit=2`)
    expect(p1.calls).toHaveLength(2)
    expect(p1.hasMore).toBe(true)
    const p2 = await env.get<UsageCallsPage>(`/api/usage/calls?scope=workflow&id=${TF.root}&limit=2&before=${encodeURIComponent(p1.before!)}`)
    expect(p2.calls).toHaveLength(2)
    expect(p2.calls.at(-1)!.ts).toBeLessThanOrEqual(p1.calls[0]!.ts)
    const p3 = await env.get<UsageCallsPage>(`/api/usage/calls?scope=workflow&id=${TF.root}&limit=2&before=${encodeURIComponent(p2.before!)}`)
    expect(p3).toMatchObject({ hasMore: false, before: null })
    const ids = [...p3.calls, ...p2.calls, ...p1.calls].map((c) => c.id)
    expect(new Set(ids).size).toBe(5)
    expect([...p3.calls, ...p2.calls, ...p1.calls].map((c) => c.ts)).toEqual([...ids.map((id) => [...p3.calls, ...p2.calls, ...p1.calls].find((c) => c.id === id)!.ts)].sort((a, b) => a - b))
    expect((await fetch(`${env.base}/api/usage/calls?scope=session&id=nope`)).status).toBe(404)
  })

  it('answers warm workflow reports quickly', async () => {
    await usage(env, `scope=workflow&id=${TF.root}`)
    const t0 = performance.now()
    await usage(env, `scope=workflow&id=${TF.root}`)
    expect(performance.now() - t0).toBeLessThan(50)
  })
})

describe('usage live', () => {
  let env: Env
  beforeAll(async () => {
    env = await createEnv({ seedOpenCode: seedWorkflow })
    await waitFor(async () => (await env.bootstrap()).sessions.find((s) => s.id === TF.root)?.usage)
  })
  afterAll(() => env.close())

  it('streams an OpenCode step-finish as a usage frame (sample + estimate end) and an updated session summary', async () => {
    const stream = env.openStream()
    await stream.waitFor((e) => e.type === 'hello')
    const fx = env.opencode!
    const now = Date.now()
    const before = await usage(env, `scope=session&id=${TF.root}`)
    const msg = 'msg_tf_live'
    fx.addMessage({ id: msg, sessionId: TF.root, created: now, data: { role: 'assistant', agent: 'build', modelID: 'claude-opus-5.5', providerID: 'github-copilot', time: { created: now } } })
    fx.addStepStart({ id: 'prt_tf_live_s', messageId: msg, sessionId: TF.root, created: now })
    fx.appendPartEvent('prt_tf_live_s', now)
    fx.addPart({ id: 'prt_tf_live_t', messageId: msg, sessionId: TF.root, created: now + 1, data: { type: 'text', text: 'x', time: { start: now + 1 } } })
    fx.appendTextGrowth('prt_tf_live_t', 'streaming a reasonably long answer here', now + 2)
    await stream.waitFor((e) => e.type === 'usage' && e.estimates.some((x) => x.sessionId === TF.root && x.inFlight), 10_000)
    fx.addStepFinish({ id: 'prt_tf_live_f', messageId: msg, sessionId: TF.root, created: now + 500, tokens: { input: 4, output: 77, reasoning: 3, cacheRead: 900, cacheWrite: 0 }, cost: 0.05, reason: 'stop' })
    fx.appendPartEvent('prt_tf_live_f', now + 500)
    const f = (await stream.waitFor((e) => e.type === 'usage' && e.samples.some((s) => s.id === 'opencode:prt_tf_live_f'), 10_000)) as Extract<StreamEvent, { type: 'usage' }>
    const s = f.samples.find((x) => x.id === 'opencode:prt_tf_live_f')!
    expect(s).toMatchObject({ sessionId: TF.root, rootId: TF.root, tokens: { input: 4, output: 77 }, cost: 0.05 })
    expect(s.ledgerSeq).toBeGreaterThan(before.ledgerSeq)
    await stream.waitFor((e) => e.type === 'usage' && e.estimates.some((x) => x.sessionId === TF.root && !x.inFlight), 10_000)
    const sess = (await stream.waitFor((e) => e.type === 'sessions' && e.sessions.some((x) => x.id === TF.root && x.usage?.calls === 4), 10_000)) as Extract<StreamEvent, { type: 'sessions' }>
    const root = sess.sessions.find((x) => x.id === TF.root) as SessionSummary
    expect(root.usage!.tree!.calls).toBe(6)
    const after = await usage(env, `scope=session&id=${TF.root}`)
    expect(after.totals.calls).toBe(before.totals.calls + 1)
    expect(after.inFlight).toEqual([])
  })

  it('streams a Copilot model_call_success as a sample with aiu', async () => {
    const stream = env.openStream()
    await stream.waitFor((e) => e.type === 'hello')
    const { fixture, liveId } = env.copilot!
    fixture.append(liveId, [fixture.ev.modelCallStarted({ turn: 5 }), fixture.ev.modelCallSuccess({ prompt: 2000, cached: 500, completion: 90, nanoAiu: 3_000_000_000, ttftMs: 200, durationMs: 1500, callId: 'mc-live-x', turn: 5 })])
    const f = (await stream.waitFor((e) => e.type === 'usage' && e.samples.some((s) => s.id.includes('mc-live-x')), 10_000)) as Extract<StreamEvent, { type: 'usage' }>
    const s = f.samples.find((x: UsageSample) => x.id.includes('mc-live-x'))!
    expect(s).toMatchObject({ harness: 'copilot', sessionId: liveId, aiu: 3 })
    expect(s.rootId).toBe(liveId)
    const r = await usage(env, `scope=session&id=${liveId}`)
    expect(r.totals.aiu).toBeGreaterThanOrEqual(3)
  })
})
