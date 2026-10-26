import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ActivityEvent, BootstrapPayload, SessionSummary, SessionTree, StreamEvent } from '../../src/shared/contract.js'
import { FAKE_SECRETS, FLEET } from '../fixtures/opencode.js'
import { COORDINATOR_HANDLE, RICH_RUN_ID } from '../fixtures/orchestration.js'
import { TERMINAL_LIST_JSON, FAKE_TOKEN as ORCA_FAKE_TOKEN } from '../fixtures/orca.js'
import { FAKE_COMMAND_SECRET, FAKE_TOKEN as COPILOT_FAKE_TOKEN } from '../fixtures/copilot.js'
import { FAKE_TOKEN as ORCH_FAKE_TOKEN } from '../fixtures/orchestration.js'
import { createEnv, hookEntry, writeHooksFile, type Env } from './env.js'

const byId = (b: BootstrapPayload, id: string): SessionSummary => b.sessions.find((s) => s.id === id)!

describe('boot', () => {
  let env: Env
  let boot: BootstrapPayload
  beforeAll(async () => {
    env = await createEnv()
    boot = await env.bootstrap()
  })
  afterAll(() => env.close())

  it('serves sessions from OpenCode and Copilot', () => {
    const ids = boot.sessions.map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining([FLEET.root, FLEET.childDone, FLEET.childLive, FLEET.rootQuestion]))
    expect(ids).not.toContain(FLEET.rootOld)
    expect(ids).toEqual(expect.arrayContaining([env.copilot!.finishedId, env.copilot!.liveId]))
    expect(byId(boot, FLEET.root)).toMatchObject({ harness: 'opencode', depth: 0, rootId: FLEET.root, state: 'working', live: true })
    expect(byId(boot, FLEET.childLive)).toMatchObject({ rootId: FLEET.root, depth: 1, parentId: FLEET.root, state: 'working', stateSource: 'parent-tool' })
    expect(byId(boot, FLEET.childDone)).toMatchObject({ state: 'done', stateSource: 'parent-tool' })
    expect(byId(boot, FLEET.root).childIds).toEqual(expect.arrayContaining([FLEET.childDone, FLEET.childLive]))
    expect(byId(boot, FLEET.root).descendantCount).toBe(2)
    expect(byId(boot, env.copilot!.finishedId)).toMatchObject({ harness: 'copilot', state: 'done' })
    expect(byId(boot, env.copilot!.liveId)).toMatchObject({ harness: 'copilot', state: 'waiting' })
  })

  it('has seq, orca snapshot, orchestration runs, attention and stats', () => {
    expect(boot.seq).toBe(env.hub.seq)
    expect(boot.meta.readOnly).toBe(true)
    expect(boot.orca.status.running).toBe(true)
    expect(boot.orca.worktrees.length).toBe(3)
    expect(boot.orca.terminals.length).toBe(4)
    expect(boot.orchestration.available).toBe(true)
    expect(boot.orchestration.runs.map((r) => r.id)).toContain(RICH_RUN_ID)
    const kinds = boot.attention.map((a) => `${a.kind}:${a.sessionId ?? a.runId}`)
    expect(kinds).toContain(`question:${FLEET.rootQuestion}`)
    expect(kinds).toContain(`permission:${env.copilot!.liveId}`)
    expect(boot.attention.some((a) => a.kind === 'gate')).toBe(true)
    const sev = boot.attention.map((a) => a.severity)
    expect(sev).toEqual([...sev].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)))
    expect(boot.stats.sessions.total).toBe(6)
    expect(boot.stats.sessions.roots).toBeGreaterThanOrEqual(4)
    expect(boot.stats.histogram).toHaveLength(60)
    expect(boot.activity.length).toBeGreaterThan(10)
    expect(boot.activity.some((e) => e.kind === 'step')).toBe(false)
    expect(boot.meta.sources.map((s) => [s.id, s.status])).toEqual([
      ['opencode', 'ok'],
      ['copilot', 'ok'],
      ['orca-cli', 'ok'],
      ['orca-hooks', 'ok'],
      ['orca-orchestration', 'ok'],
    ])
  })

  it('computes counters in the background', async () => {
    await new Promise((r) => setTimeout(r, 300))
    const b = await env.bootstrap()
    expect(byId(b, FLEET.root).counters).not.toBeNull()
    expect(byId(b, FLEET.root).counters!.tools).toBeGreaterThan(0)
    expect(b.stats.activity.toolCalls).toBeGreaterThan(0)
    expect(b.stats.topTools.length).toBeGreaterThan(0)
  })

  it('returns the session tree with labelled spawn edges', async () => {
    const tree = await env.get<SessionTree>(`/api/sessions/${FLEET.childLive}/tree`)
    expect(tree.rootId).toBe(FLEET.root)
    expect(tree.nodes.map((n) => n.id).sort()).toEqual([FLEET.root, FLEET.childDone, FLEET.childLive].sort())
    expect(tree.edges).toHaveLength(2)
    for (const e of tree.edges) {
      expect(e.from).toBe(FLEET.root)
      expect(e.label).toBeTruthy()
      expect(e.status).not.toBeNull()
    }
    expect(tree.orchestration).toBeNull()
  })

  it('serves detail, transcript, activity, parts, file changes and artifacts', async () => {
    const detail = await env.get<{ session: SessionSummary; ancestors: SessionSummary[]; children: SessionSummary[]; provenance: string[]; todos: unknown[] }>(`/api/sessions/${FLEET.childDone}`)
    expect(detail.session.id).toBe(FLEET.childDone)
    expect(detail.ancestors.map((a) => a.id)).toEqual([FLEET.root])
    expect(detail.provenance).toContain('opencode.db · session')
    const old = await env.get<{ session: SessionSummary }>(`/api/sessions/${FLEET.rootOld}`)
    expect(old.session.id).toBe(FLEET.rootOld)
    const unknown = await fetch(`${env.base}/api/sessions/ses_nope`)
    expect(unknown.status).toBe(404)
    const tr = await env.get<{ messages: unknown[] }>(`/api/sessions/${FLEET.root}/transcript?limit=10`)
    expect(tr.messages.length).toBeGreaterThan(0)
    const act = await env.get<{ events: ActivityEvent[] }>(`/api/activity?rootId=${FLEET.root}&limit=500`)
    expect(act.events.some((e) => e.sessionId === FLEET.childDone)).toBe(true)
    const part = await fetch(`${env.base}/api/parts/${encodeURIComponent('opencode:' + FLEET.parts.bashDone)}`)
    expect(part.status).toBe(200)
    const fcs = await env.get<{ changes: Array<{ id: string }> }>(`/api/file-changes?rootId=${FLEET.root}`)
    expect(fcs.changes.length).toBeGreaterThan(0)
    const diff = await fetch(`${env.base}/api/file-changes/${encodeURIComponent(fcs.changes[0]!.id)}/diff`)
    expect(diff.status).toBe(200)
    const arts = await env.get<{ artifacts: Array<{ kind: string; url: string | null }> }>(`/api/artifacts?rootId=${FLEET.root}`)
    expect(arts.artifacts.some((a) => a.kind === 'pull-request' && a.url === FLEET.prUrl)).toBe(true)
    const run = await env.get<{ run: { id: string } }>(`/api/orchestration/runs/${RICH_RUN_ID}`)
    expect(run.run.id).toBe(RICH_RUN_ID)
    expect((await fetch(`${env.base}/api/orchestration/runs/nope`)).status).toBe(404)
  })

  it('returns the fleet activity ring and honours cursors', async () => {
    const p1 = await env.get<{ events: ActivityEvent[]; before: string | null; hasMore: boolean }>('/api/activity?limit=5')
    expect(p1.events).toHaveLength(5)
    expect(p1.hasMore).toBe(true)
    const p2 = await env.get<{ events: ActivityEvent[] }>(`/api/activity?limit=5&before=${encodeURIComponent(p1.before!)}`)
    expect(p2.events.every((e) => e.ts <= p1.events[0]!.ts)).toBe(true)
    expect(new Set([...p1.events, ...p2.events].map((e) => e.id)).size).toBe(10)
  })

  it('bootstrap stays small', async () => {
    expect((await env.getText('/api/bootstrap')).length).toBeLessThan(2 * 1024 * 1024)
  })
})

describe('join', () => {
  let env: Env
  beforeAll(async () => {
    const now = Date.now()
    env = await createEnv({
      now,
      hooks: [
        hookEntry({
          paneKey: 'tab-1:leaf-1',
          providerSession: { key: 'session_id', id: FLEET.root },
          hookEventName: 'PermissionRequest',
          payload: { state: 'blocked', prompt: 'x', agentType: 'opencode' },
          receivedAt: now + 1000,
          stateStartedAt: now + 1000,
        }),
      ],
    })
  })
  afterAll(() => env.close())

  it('links hook → terminal → worktree and derives state from the hook', async () => {
    const b = await env.bootstrap()
    const s = byId(b, FLEET.root)
    expect(s.state).toBe('blocked')
    expect(s.stateSource).toBe('orca-hook')
    expect(s.orca).toMatchObject({ paneKey: 'tab-1:leaf-1', tabId: 'tab-1', terminalHandle: 'term_aaaa', worktreeId: 'repo-1::/work/acme/feature-x', hookState: 'blocked', hookEvent: 'PermissionRequest' })
    expect(s.workspace).toMatchObject({ key: 'repo-1::/work/acme/feature-x', name: 'feature-x', path: '/work/acme/feature-x' })
    const child = byId(b, FLEET.childLive)
    expect(child.workspace?.key).toBe('repo-1::/work/acme/feature-x')
    expect(child.orca?.paneKey).toBeNull()
    expect(b.orca.terminals.find((t) => t.handle === 'term_aaaa')?.sessionId).toBe(FLEET.root)
    const att = b.attention.find((a) => a.id === `permission:${FLEET.root}`)
    expect(att).toMatchObject({ kind: 'permission', severity: 'high', sessionId: FLEET.root })
    // unlinked session falls back to its directory
    expect(byId(b, FLEET.rootQuestion).workspace).toMatchObject({ key: '/repo/other', name: 'other', repo: null })
    const detail = await env.get<{ provenance: string[] }>(`/api/sessions/${FLEET.root}`)
    expect(detail.provenance).toEqual(expect.arrayContaining(['Orca hooks · pane tab-1:leaf-1', 'orca terminal list · term_aaaa']))
  })
})

describe('orchestration roles', () => {
  let env: Env
  beforeAll(async () => {
    const now = Date.now()
    const list = JSON.parse(TERMINAL_LIST_JSON)
    list.result.terminals[0].handle = COORDINATOR_HANDLE
    env = await createEnv({
      now,
      terminalListJson: JSON.stringify(list),
      hooks: [hookEntry({ providerSession: { key: 'session_id', id: FLEET.root }, payload: { state: 'working', agentType: 'opencode' }, receivedAt: now, stateStartedAt: now })],
    })
  })
  afterAll(() => env.close())

  it('marks the coordinator session and fills coordinatorSessionId', async () => {
    const b = await env.bootstrap()
    expect(byId(b, FLEET.root).orca).toMatchObject({ role: 'coordinator', runId: RICH_RUN_ID, terminalHandle: COORDINATOR_HANDLE })
    expect(b.orchestration.runs.find((r) => r.id === RICH_RUN_ID)?.coordinatorSessionId).toBe(FLEET.root)
    const tree = await env.get<SessionTree>(`/api/sessions/${FLEET.root}/tree`)
    expect(tree.orchestration?.runId).toBe(RICH_RUN_ID)
    expect(tree.orchestration?.taskIds.length).toBeGreaterThan(3)
    const run = await env.get<{ run: { coordinatorSessionId: string | null } }>(`/api/orchestration/runs/${RICH_RUN_ID}`)
    expect(run.run.coordinatorSessionId).toBe(FLEET.root)
  })
})

describe('live', () => {
  let env: Env
  beforeAll(async () => {
    env = await createEnv({
      hooks: [hookEntry({ providerSession: { key: 'session_id', id: FLEET.root }, payload: { state: 'working', agentType: 'opencode' }, receivedAt: Date.now() - 600_000, stateStartedAt: Date.now() - 600_000 })],
    })
  })
  afterAll(() => env.close())

  it('streams OpenCode activity and a session update', async () => {
    const stream = env.openStream()
    await stream.waitFor((e) => e.type === 'hello')
    const fx = env.opencode!
    const now = Date.now()
    fx.addPart({
      id: 'prt_live_new',
      messageId: FLEET.messages.asstLive,
      sessionId: FLEET.root,
      created: now,
      data: { type: 'tool', callID: 'c-live', tool: 'bash', state: { status: 'running', input: { command: 'echo live-marker' }, time: { start: now } } },
    })
    fx.appendPartEvent('prt_live_new', now)
    const act = await stream.waitFor((e) => e.type === 'activity' && e.events.some((x) => x.id === 'opencode:prt_live_new'))
    const ev = (act as Extract<StreamEvent, { type: 'activity' }>).events.find((x) => x.id === 'opencode:prt_live_new')!
    expect(ev.rootId).toBe(FLEET.root)
    const sess = await stream.waitFor((e) => e.type === 'sessions' && e.sessions.some((s) => s.id === FLEET.root && s.current?.activityId === 'opencode:prt_live_new'))
    expect(sess.type).toBe('sessions')
  })

  it('streams Copilot activity', async () => {
    const stream = env.openStream()
    await stream.waitFor((e) => e.type === 'hello')
    const { fixture, liveId } = env.copilot!
    fixture.append(liveId, [fixture.ev.toolStart('call-new-live', 'bash', { command: 'echo copilot-live' }, { model: 'gpt-5' })])
    const act = await stream.waitFor((e) => e.type === 'activity' && e.events.some((x) => x.id.includes('call-new-live')), 10_000)
    expect(act.type).toBe('activity')
    await stream.waitFor((e) => e.type === 'sessions' && e.sessions.some((s) => s.id === liveId), 10_000)
  })

  it('streams hook transitions as orca + activity + sessions frames', async () => {
    const stream = env.openStream()
    await stream.waitFor((e) => e.type === 'hello')
    const t = Date.now()
    writeHooksFile(env.hooksPath!, [
      hookEntry({
        providerSession: { key: 'session_id', id: FLEET.root },
        hookEventName: 'PermissionRequest',
        payload: { state: 'blocked', agentType: 'opencode' },
        receivedAt: t + 5000,
        stateStartedAt: t + 5000,
      }),
    ])
    await stream.waitFor((e) => e.type === 'orca' && !!e.orca.hooks, 10_000)
    const act = (await stream.waitFor((e) => e.type === 'activity' && e.events.some((x) => x.source === 'orca.hooks'), 10_000)) as Extract<StreamEvent, { type: 'activity' }>
    expect(act.events.find((x) => x.source === 'orca.hooks')!.rootId).toBe(FLEET.root)
    await stream.waitFor((e) => e.type === 'sessions' && e.sessions.some((s) => s.id === FLEET.root && s.state === 'blocked'), 10_000)
    await stream.waitFor((e) => e.type === 'attention' && e.items.some((i) => i.id === `permission:${FLEET.root}`), 10_000)
  })
})

describe('resilience', () => {
  it('survives a missing OpenCode DB, a failing Orca CLI and a newer orchestration schema', async () => {
    const env = await createEnv({ opencodeMissing: true, orca: 'failing', orchestration: 'newer-schema' })
    try {
      const b = await env.bootstrap()
      const st = Object.fromEntries(b.meta.sources.map((s) => [s.id, s.status]))
      expect(st.opencode).toBe('missing')
      expect(['error', 'degraded']).toContain(st['orca-cli'])
      expect(['ok', 'degraded']).toContain(st['orca-orchestration'])
      expect(st.copilot).toBe('ok')
      expect(b.sessions.every((s) => s.harness === 'copilot')).toBe(true)
      expect(b.sessions.length).toBe(2)
      expect(b.orca.status.running).toBe(false)
      expect((await fetch(`${env.base}/api/stats`)).status).toBe(200)
    } finally {
      await env.close()
    }
  })

  it('lists unconfigured sources as disabled', async () => {
    const env = await createEnv({ opencode: false, copilot: false, orchestration: null, orca: null, hooks: null })
    try {
      const b = await env.bootstrap()
      expect(b.sessions).toEqual([])
      expect(b.meta.sources.map((s) => [s.id, s.status])).toEqual([
        ['opencode', 'disabled'],
        ['copilot', 'disabled'],
        ['orca-cli', 'disabled'],
        ['orca-hooks', 'disabled'],
        ['orca-orchestration', 'disabled'],
      ])
      expect(b.meta.sources.every((s) => !!s.detail)).toBe(true)
      expect(b.orchestration.available).toBe(false)
    } finally {
      await env.close()
    }
  })
})

describe('safety', () => {
  it('never leaks fixture secrets over HTTP', async () => {
    const env = await createEnv()
    try {
      const b = await env.bootstrap()
      const bodies = [JSON.stringify(b)]
      for (const r of [
        '/api/meta',
        '/api/sessions',
        `/api/sessions/${FLEET.root}`,
        `/api/sessions/${FLEET.root}/tree`,
        `/api/sessions/${FLEET.root}/transcript?limit=200`,
        `/api/sessions/${env.copilot!.finishedId}/transcript?limit=200`,
        `/api/activity?rootId=${FLEET.root}&limit=5000`,
        `/api/activity?sessionId=${env.copilot!.finishedId}&limit=5000`,
        '/api/activity?limit=5000',
        '/api/file-changes',
        '/api/artifacts',
        '/api/attention',
        '/api/stats',
        '/api/orca',
        '/api/orchestration',
        `/api/orchestration/runs/${RICH_RUN_ID}`,
      ]) {
        bodies.push(await env.getText(r))
      }
      for (const id of b.activity.map((e) => e.detailRef).filter((x): x is string => !!x).slice(0, 80)) {
        bodies.push(await env.getText(`/api/parts/${encodeURIComponent(id)}`))
      }
      const all = bodies.join('\n')
      for (const secret of [...FAKE_SECRETS, FLEET.commandSecret, FAKE_COMMAND_SECRET, COPILOT_FAKE_TOKEN, ORCA_FAKE_TOKEN, ORCH_FAKE_TOKEN, 'ghp_FAKE']) {
        expect(all, `leaked ${secret}`).not.toContain(secret)
      }
      expect(all).not.toContain('data:image/png;base64')
    } finally {
      await env.close()
    }
  })
})
