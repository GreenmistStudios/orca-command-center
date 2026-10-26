/**
 * Mock backend (`?mock=1`): serves every REST route and a synthetic live stream so UI work does not
 * depend on the server. Fleet description lives in `mock-data.ts` (`buildMockWorld`).
 * `?mock=1&degraded=1` serves a degraded scenario (Orca stopped, missing/erroring sources, newer schema).
 */
import {
  LIMITS, type ActivityEvent, type ActivityPage, type ApiResponses, type ApiRoute, type BootstrapPayload, type FleetStats,
  type SessionDetail, type SessionSummary, type SessionTree, type StreamEvent, type TranscriptMessage, type TranscriptPage,
  type PartDetail, type ActivityKind, type StreamPayload,
} from '../../shared/contract'
import {
  artifactsOf, buildMockWorld, fileChangesOf, metaOf, MOCK_IDS, mulberry32, orchestrationSummary, recomputeAll, recomputeSession,
  toolInfo, type MockWorld,
} from './mock-data'
import { ApiRequestError, type GetOptions } from './types'

export { MOCK_IDS } from './mock-data'

export interface MockBackend {
  /** Same contract as `api.get`. */
  get<R extends ApiRoute>(route: R, opts?: GetOptions): Promise<ApiResponses[R]>
  /** Subscribe to the live stream; returns an unsubscribe. Starts timers on first subscriber unless `live:false`. */
  connect(onEvent: (e: StreamEvent) => void): () => void
  bootstrap(): BootstrapPayload
  /** Emit one ~800 ms live update (tool started → completed, thinking, MCP). */
  tick(): void
  /** Emit one ~6 s update (spawn a subagent or flip a state). */
  tickSlow(): void
  /** Emit a stats frame (~5 s). */
  tickStats(): void
  readonly world: MockWorld
}

export interface MockOptions { now?: number; seed?: number; live?: boolean; scenario?: 'healthy' | 'degraded' }

export function isMockMode(search: string = typeof location !== 'undefined' ? location.search : ''): boolean {
  return /[?&]mock=/.test(search) && !/[?&]mock=0\b/.test(search)
}

let singleton: MockBackend | null = null
/** Shared backend for the browser session (`?mock=1`). */
export function getMockBackend(): MockBackend {
  if (!singleton) {
    singleton = createMockBackend({ scenario: /[?&]degraded=1/.test(location.search) ? 'degraded' : 'healthy' })
  }
  return singleton
}
/** Test helper. */
export function resetMockBackend(): void { singleton = null }

const pick = <T,>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)]

export function createMockBackend(opts: MockOptions = {}): MockBackend {
  const t0 = Date.now()
  const base = opts.now ?? t0
  const clock = () => base + (Date.now() - t0)
  const scenario = opts.scenario ?? 'healthy'
  const world = buildMockWorld({ now: base, seed: opts.seed, scenario })
  const rnd = mulberry32((opts.seed ?? 7) + 101)
  const bootId = `mock-boot-${(opts.seed ?? 7).toString(16)}`
  const listeners = new Set<(e: StreamEvent) => void>()
  let seq = 1000
  let timers: ReturnType<typeof setInterval>[] = []
  let pending: ActivityEvent | null = null
  let slowN = 0
  let spawned = 0
  let evN = 0

  const emit = (e: StreamPayload) => {
    const frame = { ...structuredClone(e), seq: ++seq } as StreamEvent
    listeners.forEach((l) => l(frame))
  }
  const sessionList = () => [...world.sessions.values()]
  const nowMs = () => clock()

  /* ───────── derived payloads ───────── */
  function stats(): FleetStats {
    const t = nowMs()
    const ss = sessionList()
    const evs = world.events
    const toolEvs = evs.filter((e) => e.tool && e.kind !== 'subagent')
    const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    let cost = 0
    for (const s of ss) { cost += s.cost; for (const k of Object.keys(tokens) as Array<keyof typeof tokens>) tokens[k] += s.tokens[k] }
    const by = <K extends string>(f: (s: SessionSummary) => K | null) => {
      const m = new Map<K, { sessions: number; cost: number; live: number; tokens: number }>()
      for (const s of ss) { const k = f(s); if (!k) continue; const v = m.get(k) ?? { sessions: 0, cost: 0, live: 0, tokens: 0 }; v.sessions++; v.cost += s.cost; v.live += s.live ? 1 : 0; v.tokens += s.tokens.input + s.tokens.output; m.set(k, v) }
      return m
    }
    const toolMap = new Map<string, { name: string; category: import('../../shared/contract').ToolCategory; mcpServer: string | null; calls: number; errors: number }>()
    for (const e of toolEvs) {
      const k = e.tool!.name
      const v = toolMap.get(k) ?? { name: k, category: e.tool!.category, mcpServer: e.tool!.mcpServer, calls: 0, errors: 0 }
      v.calls++; if (e.status === 'error') v.errors++; toolMap.set(k, v)
    }
    const topTools = [...toolMap.values()].sort((a, b) => b.calls - a.calls).slice(0, 10)
    const mcpMap = new Map<string, { server: string; calls: number; errors: number; tools: Set<string> }>()
    for (const e of evs.filter((x) => x.kind === 'mcp')) {
      const s = e.tool!.mcpServer ?? 'unknown'
      const v = mcpMap.get(s) ?? { server: s, calls: 0, errors: 0, tools: new Set() }
      v.calls++; if (e.status === 'error') v.errors++; v.tools.add(e.tool!.name); mcpMap.set(s, v)
    }
    const hist = Array.from({ length: 60 }, (_, i) => {
      const bucketT = t - (59 - i) * 60_000
      const r = mulberry32(i * 31 + (opts.seed ?? 7))
      const ramp = 0.4 + 0.6 * Math.sin((i / 60) * Math.PI)
      return { t: bucketT, thinking: Math.round(r() * 3 * ramp), tools: Math.round(r() * 12 * ramp), mcp: Math.round(r() * 3 * ramp), edits: Math.round(r() * 4 * ramp), errors: r() > 0.85 ? Math.ceil(r() * 3) : 0 }
    })
    return {
      windowMs: 24 * 3_600_000, computedAt: t,
      sessions: { total: ss.length, roots: ss.filter((s) => s.depth === 0).length, live: ss.filter((s) => s.live).length, working: ss.filter((s) => s.state === 'working').length, blocked: ss.filter((s) => s.state === 'blocked').length, waiting: ss.filter((s) => s.state === 'waiting').length, error: ss.filter((s) => s.state === 'error').length },
      activity: { toolCalls: toolEvs.length, toolErrors: toolEvs.filter((e) => e.status === 'error').length, mcpCalls: evs.filter((e) => e.kind === 'mcp').length, thinking: evs.filter((e) => e.kind === 'thinking').length, fileChanges: evs.filter((e) => e.kind === 'file-change').length, filesTouched: new Set(evs.flatMap((e) => e.files)).size, subagents: ss.filter((s) => s.depth > 0).length },
      tokens, cost: Math.round(cost * 100) / 100,
      byHarness: [...by((s) => s.harness)].map(([harness, v]) => ({ harness, sessions: v.sessions, live: v.live, cost: Math.round(v.cost * 100) / 100 })),
      byModel: [...by((s) => s.model?.modelId ?? null)].map(([model, v]) => ({ model, sessions: v.sessions, cost: Math.round(v.cost * 100) / 100, tokens: v.tokens })),
      byAgent: [...by((s) => s.agent)].map(([agent, v]) => ({ agent, sessions: v.sessions, cost: Math.round(v.cost * 100) / 100 })),
      topTools, mcpServers: [...mcpMap.values()].map((v) => ({ server: v.server, calls: v.calls, errors: v.errors, tools: v.tools.size })),
      histogram: hist,
    }
  }

  const meta = () => metaOf(world, scenario, bootId, nowMs())

  function bootstrap(): BootstrapPayload {
    return {
      meta: meta(), seq, sessions: sessionList(), orca: world.orca, attention: world.attention,
      activity: world.events.filter((e) => e.kind !== 'step').sort((a, b) => a.ts - b.ts).slice(-LIMITS.bootstrapActivity),
      orchestration: orchestrationSummary(world, scenario), stats: stats(),
    }
  }

  function tree(id: string): SessionTree {
    const s = world.sessions.get(id)
    if (!s) throw new ApiRequestError(404, 'not_found', `session ${id} not found`)
    const root = world.sessions.get(s.rootId)!
    const nodes: SessionSummary[] = []
    const edges: SessionTree['edges'] = []
    const walk = (n: SessionSummary) => {
      nodes.push(n)
      for (const cid of n.childIds) {
        const c = world.sessions.get(cid)!
        edges.push({ id: `edge:${n.id}:${c.id}`, from: n.id, to: c.id, label: c.spawn?.description ?? null, status: c.spawn?.status ?? null, activityId: c.spawn?.activityId || null })
        walk(c)
      }
    }
    walk(root)
    const run = world.runs.find((r) => r.run.coordinatorSessionId === root.id)
    return { rootId: root.id, nodes, edges, orchestration: run ? { runId: run.run.id, taskIds: run.tasks.map((t) => t.id) } : null }
  }

  function messagesOf(sessionId: string): TranscriptMessage[] {
    const evs = world.events.filter((e) => e.sessionId === sessionId).sort((a, b) => a.ts - b.ts)
    const order: string[] = []
    const items = new Map<string, ActivityEvent[]>()
    for (const e of evs) {
      const mid = e.messageId ?? `msg_orphan_${sessionId}`
      if (!items.has(mid)) { items.set(mid, []); order.push(mid) }
      items.get(mid)!.push(e)
    }
    const s = world.sessions.get(sessionId)!
    return order.map((mid) => {
      const h = world.messages.get(mid)
      const its = items.get(mid)!
      const usage = its.find((x) => x.usage)?.usage ?? null
      return {
        id: mid, sessionId, role: h?.role ?? 'assistant', agent: h?.agent ?? s.agent, model: h?.model ?? s.model, createdAt: h?.createdAt ?? its[0].ts,
        completedAt: h?.completedAt ?? its[its.length - 1].endTs ?? its[its.length - 1].ts, tokens: usage?.tokens ?? null, cost: usage?.cost ?? null, finish: h?.finish ?? null, error: h?.error ?? null, items: its,
      }
    })
  }

  function page<T>(all: T[], before: string | undefined, limit: number): { items: T[]; before: string | null; hasMore: boolean } {
    const end = before != null && before !== '' ? Math.max(0, Math.min(all.length, Number(before))) : all.length
    const start = Math.max(0, end - limit)
    return { items: all.slice(start, end), before: start > 0 ? String(start) : null, hasMore: start > 0 }
  }

  function part(id: string): PartDetail {
    const e = world.events.find((x) => x.id === id)
    const d = world.details.get(id)
    if (!e || !d) throw new ApiRequestError(404, 'not_found', `part ${id} not found`)
    return {
      id, sessionId: e.sessionId ?? '', kind: e.kind, title: e.title, text: d.text, input: d.input, output: d.output ? `${d.output}${d.output.length > 120 ? '' : '\n(full output)'}` : null,
      error: d.error, metadata: { source: e.source, harness: e.harness, durationMs: e.tool?.durationMs ?? null }, truncated: false,
    }
  }

  function sessionDetail(id: string): SessionDetail {
    const s = world.sessions.get(id)
    if (!s) throw new ApiRequestError(404, 'not_found', `session ${id} not found`)
    const ancestors: SessionSummary[] = []
    for (let p = s.parentId ? world.sessions.get(s.parentId) : undefined; p; p = p.parentId ? world.sessions.get(p.parentId) : undefined) ancestors.unshift(p)
    return {
      session: s, ancestors, children: s.childIds.map((c) => world.sessions.get(c)!), todos: world.todos.get(id) ?? [],
      fileChanges: fileChangesOf(world).filter((c) => c.sessionId === id), artifacts: artifactsOf(world).filter((a) => a.sessionId === id),
      provenance: [s.harness === 'copilot' ? 'copilot · session-state/events.jsonl' : 'opencode.db · session', s.harness === 'copilot' ? 'copilot · workspace.yaml' : 'opencode.db · message/part', ...(s.orca?.paneKey ? ['orca hooks · last-status.json'] : []), ...(s.parentId ? ['parent task tool call'] : [])],
    }
  }

  /* ───────── REST ───────── */
  const routes: Record<string, (o: GetOptions) => unknown> = {
    'GET /api/meta': () => meta(),
    'GET /api/bootstrap': () => bootstrap(),
    'GET /api/sessions': (o) => {
      const p = o.params ?? {}
      let ss = sessionList()
      if (p.live) ss = ss.filter((s) => s.live)
      if (p.harness) ss = ss.filter((s) => s.harness === p.harness)
      if (p.state) ss = ss.filter((s) => s.state === p.state)
      if (p.q) ss = ss.filter((s) => `${s.title} ${s.agent ?? ''}`.toLowerCase().includes(String(p.q).toLowerCase()))
      return { sessions: ss.slice(0, Number(p.limit ?? 2000)) }
    },
    'GET /api/sessions/:id': (o) => sessionDetail(o.path!.id),
    'GET /api/sessions/:id/tree': (o) => tree(o.path!.id),
    'GET /api/sessions/:id/transcript': (o): TranscriptPage => {
      const id = o.path!.id
      if (!world.sessions.has(id)) throw new ApiRequestError(404, 'not_found', `session ${id} not found`)
      const limit = Math.min(Number(o.params?.limit ?? LIMITS.transcriptPageDefault), LIMITS.transcriptPageMax)
      const r = page(messagesOf(id), o.params?.before as string | undefined, limit)
      return { sessionId: id, messages: r.items, before: r.before, hasMore: r.hasMore }
    },
    'GET /api/activity': (o): ActivityPage => {
      const p = o.params ?? {}
      let evs = world.events.slice().sort((a, b) => a.ts - b.ts)
      if (p.sessionId) evs = evs.filter((e) => e.sessionId === p.sessionId)
      else if (p.rootId) evs = evs.filter((e) => e.rootId === p.rootId)
      if (p.kinds) { const k = new Set(String(p.kinds).split(',') as ActivityKind[]); evs = evs.filter((e) => k.has(e.kind)) }
      if (p.sinceMs) evs = evs.filter((e) => e.ts >= Number(p.sinceMs))
      const r = page(evs, p.before as string | undefined, Math.min(Number(p.limit ?? 500), LIMITS.activityPageMax))
      return { events: r.items, before: r.before, hasMore: r.hasMore }
    },
    'GET /api/parts/:id': (o) => part(o.path!.id),
    'GET /api/file-changes': (o) => {
      let c = fileChangesOf(world)
      if (o.params?.sessionId) c = c.filter((x) => x.sessionId === o.params!.sessionId)
      else if (o.params?.rootId) c = c.filter((x) => x.rootId === o.params!.rootId)
      return { changes: c }
    },
    'GET /api/file-changes/:id/diff': (o) => {
      const d = world.diffs.get(o.path!.id)
      if (!d) throw new ApiRequestError(404, 'not_found', `diff ${o.path!.id} not found`)
      return d
    },
    'GET /api/artifacts': (o) => ({ artifacts: artifactsOf(world).filter((a) => !o.params?.rootId || a.rootId === o.params.rootId) }),
    'GET /api/attention': () => ({ items: world.attention }),
    'GET /api/stats': () => stats(),
    'GET /api/orca': () => world.orca,
    'GET /api/orchestration': () => orchestrationSummary(world, scenario),
    'GET /api/orchestration/runs/:id': (o) => {
      const r = world.runs.find((x) => x.run.id === o.path!.id)
      if (!r) throw new ApiRequestError(404, 'not_found', `run ${o.path!.id} not found`)
      return r
    },
    'GET /api/orchestration/tasks/:id': (o) => {
      for (const r of world.runs) {
        const task = r.tasks.find((t) => t.id === o.path!.id)
        if (task) {
          return {
            task, spec: `${task.specPreview}\n\n## Acceptance\n- Tests pass\n- Report via worker_done`, result: task.status === 'completed' ? 'Completed successfully. 14 tests pass.' : task.status === 'failed' ? 'Worker crashed twice; circuit breaker opened.' : null,
            dispatches: r.dispatches.filter((d) => d.taskId === task.id), messages: r.messages.filter((m) => m.taskId === task.id), gates: r.gates.filter((g) => g.taskId === task.id),
          }
        }
      }
      throw new ApiRequestError(404, 'not_found', `task ${o.path!.id} not found`)
    },
  }

  async function get<R extends ApiRoute>(route: R, o: GetOptions = {}): Promise<ApiResponses[R]> {
    await Promise.resolve()
    if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const h = routes[route]
    if (!h) throw new ApiRequestError(404, 'not_found', `unknown route ${route}`)
    return structuredClone(h(o)) as ApiResponses[R]
  }

  /* ───────── live updates ───────── */
  const LIVE = [MOCK_IDS.rootBuild, MOCK_IDS.coderViewModel, MOCK_IDS.copilot]
  const touch = (s: SessionSummary, cur: SessionSummary['current']) => {
    s.current = cur; s.lastActivityAt = nowMs(); s.updatedAt = nowMs(); s.live = true
  }

  function addEvent(sessionId: string, p: Partial<ActivityEvent> & { kind: ActivityKind; title: string }): ActivityEvent {
    const s = world.sessions.get(sessionId)!
    const t = nowMs()
    const ev: ActivityEvent = {
      id: s.harness === 'copilot' ? `copilot:${sessionId}:live${++evN}` : `opencode:prt_live_${++evN}`, rev: t, harness: s.harness, sessionId, rootId: s.rootId,
      messageId: [...world.messages.values()].filter((m) => m.sessionId === sessionId && m.role === 'assistant').pop()?.id ?? null, ts: t, endTs: null, status: null, summary: null, tool: null, files: [], childSessionId: null,
      usage: null, links: [], source: s.harness === 'copilot' ? 'copilot.events' : 'opencode.part', detailRef: null, ...p,
    }
    world.events.push(ev)
    world.details.set(ev.id, { input: ev.tool ? { command: ev.tool.input } : null, output: ev.tool?.output ?? null, text: ev.summary, error: ev.tool?.error ?? null })
    ev.detailRef = ev.id
    return ev
  }

  function tick() {
    const t = nowMs()
    if (pending) {
      const p = pending
      pending = null
      const failed = p.kind === 'mcp' && p.tool?.name.startsWith('bitrise') && rnd() > 0.4
      const done: ActivityEvent = {
        ...p, rev: t, endTs: t, status: failed ? 'error' : 'completed',
        tool: p.tool ? { ...p.tool, durationMs: t - p.ts, output: failed ? null : p.kind === 'tool' ? 'ok' : '{"ok":true}', error: failed ? 'HTTP 404: build log not available yet' : null } : null,
      }
      const idx = world.events.findIndex((e) => e.id === p.id)
      world.events[idx] = done
      world.details.set(done.id, { input: done.tool ? { command: done.tool.input } : null, output: done.tool?.output ?? null, text: done.summary, error: done.tool?.error ?? null })
      const s = world.sessions.get(done.sessionId!)!
      recomputeSession(world, s.id)
      emit({ type: 'activity', events: [done] })
      emit({ type: 'sessions', sessions: [s], removed: [] })
      return
    }
    const sid = pick(rnd, LIVE)
    const s = world.sessions.get(sid)!
    const r = rnd()
    let ev: ActivityEvent
    if (r < 0.4) {
      const cmd = pick(rnd, ['npm test', './gradlew :app:testDebugUnitTest', 'git status --short', 'rg "RetryPolicy" -n', 'npm run typecheck'])
      ev = addEvent(sid, { kind: 'tool', title: `bash · ${cmd}`, status: 'running', tool: toolInfo('bash', 'shell', cmd, null) })
      touch(s, { kind: 'tool', label: 'bash', detail: cmd, since: t, activityId: ev.id })
    } else if (r < 0.6) {
      const file = pick(rnd, ['RemoteStartViewModel.kt', 'RetryPolicy.kt', 'RemoteStartUseCase.kt', 'strings.xml'])
      ev = addEvent(sid, { kind: 'tool', title: `read · ${file}`, status: 'running', files: [`/Users/dev/Development/acme-android/app/src/main/${file}`], tool: toolInfo('read', 'read', file, null) })
      touch(s, { kind: 'tool', label: 'read', detail: file, since: t, activityId: ev.id })
    } else if (r < 0.8) {
      const [server, tool, input] = pick(rnd, [['atlassian', 'jira_get_issue', '{"issueKey":"ACME-4412"}'], ['github', 'list_pull_requests', '{"state":"open"}'], ['bitrise', 'get_build_log', '{"buildSlug":"a1b2c3"}']] as const)
      ev = addEvent(sid, { kind: 'mcp', title: `${server} · ${tool}`, status: 'running', tool: toolInfo(`${server}_${tool}`, 'mcp', input, null, { mcpServer: server, displayName: tool }) })
      touch(s, { kind: 'mcp', label: tool, detail: server, since: t, activityId: ev.id })
    } else {
      const text = pick(rnd, ['Checking the call sites again.\nThe ViewModel already exposes attempt; confirm the Compose screen reads it.', 'Backoff math: 400 << attempt, capped at 8s.\nAttempt 5 would wait 6.4s.'])
      ev = addEvent(sid, { kind: 'thinking', title: 'Thinking', summary: text, status: 'running' })
      touch(s, { kind: 'thinking', label: 'Thinking', detail: null, since: t, activityId: ev.id })
    }
    pending = ev
    recomputeSession(world, sid)
    emit({ type: 'activity', events: [ev] })
    emit({ type: 'sessions', sessions: [s], removed: [] })
  }

  function tickSlow() {
    const t = nowMs()
    slowN++
    const root = world.sessions.get(MOCK_IDS.rootBuild)!
    const runningSpawned = [...world.sessions.values()].find((s) => s.id.startsWith('ses_live_') && s.state === 'working')
    if (slowN % 2 === 1 && spawned < 4) {
      spawned++
      const agent = pick(rnd, ['explore', 'sonnet-coder', 'prr-validator'] as const)
      const desc = pick(rnd, ['Check Compose previews compile', 'Scan for hard-coded delays', 'Validate PR description', 'Summarize test failures'])
      const child: SessionSummary = {
        ...structuredClone(world.sessions.get(MOCK_IDS.exploreUsages)!), id: `ses_live_${spawned}`, parentId: root.id, rootId: root.id, depth: 1, title: desc, agent,
        createdAt: t, updatedAt: t, lastActivityAt: t, state: 'working', stateSource: 'parent-tool', stateSince: t, live: true, childIds: [], descendantCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0,
        current: { kind: 'thinking', label: 'Thinking', detail: null, since: t, activityId: null }, spawn: { parentSessionId: root.id, activityId: '', callId: null, description: desc, subagentType: agent, status: 'running' }, orca: null,
        lastPrompt: desc, lastMessage: null,
      }
      world.sessions.set(child.id, child)
      const ev = addEvent(root.id, { kind: 'subagent', title: `task · ${desc}`, status: 'running', childSessionId: child.id, summary: desc, tool: toolInfo('task', 'subagent', desc, null, { displayName: agent }) })
      child.spawn!.activityId = ev.id
      recomputeAll(world)
      emit({ type: 'activity', events: [ev] })
      emit({ type: 'sessions', sessions: [child, root], removed: [] })
    } else if (runningSpawned) {
      runningSpawned.state = 'done'; runningSpawned.live = false; runningSpawned.current = null; runningSpawned.stateSince = t
      runningSpawned.spawn = { ...runningSpawned.spawn!, status: 'completed' }
      const sub = world.events.find((e) => e.id === runningSpawned.spawn!.activityId)
      const out: ActivityEvent[] = []
      if (sub) { const done = { ...sub, rev: t, status: 'completed' as const, endTs: t }; world.events[world.events.indexOf(sub)] = done; out.push(done) }
      if (out.length) emit({ type: 'activity', events: out })
      emit({ type: 'sessions', sessions: [runningSpawned], removed: [] })
    } else {
      // flip the Copilot session between working and waiting
      const cp = world.sessions.get(MOCK_IDS.copilot)!
      cp.state = cp.state === 'working' ? 'waiting' : 'working'; cp.stateSince = t; cp.live = true
      emit({ type: 'sessions', sessions: [cp], removed: [] })
    }
  }

  const tickStats = () => emit({ type: 'stats', stats: stats() })

  function connect(onEvent: (e: StreamEvent) => void): () => void {
    listeners.add(onEvent)
    queueMicrotask(() => onEvent({ type: 'hello', seq, bootId, meta: meta() }))
    if (opts.live !== false && timers.length === 0) {
      timers = [setInterval(tick, 800), setInterval(tickSlow, 6000), setInterval(tickStats, 5000)]
    }
    return () => {
      listeners.delete(onEvent)
      if (listeners.size === 0) { timers.forEach(clearInterval); timers = [] }
    }
  }

  return { get, connect, bootstrap, tick, tickSlow, tickStats, world }
}
