import type {
  ActivityEvent,
  EpochMs,
  FleetStats,
  SessionCounters,
  SessionSummary,
  ToolStat,
} from '../../shared/contract.js'

const MIN = 60_000

export function histogramOf(events: readonly ActivityEvent[], now: EpochMs): FleetStats['histogram'] {
  // minute-aligned: the last bucket contains `now`
  const first = Math.floor(now / MIN) * MIN - 59 * MIN
  const buckets: FleetStats['histogram'] = Array.from({ length: 60 }, (_, i) => ({
    t: first + i * MIN,
    thinking: 0,
    tools: 0,
    mcp: 0,
    edits: 0,
    errors: 0,
  }))
  const start = first
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.ts < start) break
    const idx = Math.floor((e.ts - first) / MIN)
    const b = buckets[Math.min(59, Math.max(0, idx))]
    if (!b || e.ts >= first + 60 * MIN) continue
    switch (e.kind) {
      case 'thinking':
        b.thinking++
        break
      case 'tool':
      case 'subagent':
        b.tools++
        break
      case 'mcp':
        b.tools++
        b.mcp++
        break
      case 'file-change':
        b.edits++
        break
      case 'error':
        b.errors++
        break
    }
    if (e.status === 'error' && e.kind !== 'error') b.errors++
  }
  return buckets
}

/** Plan §9.5. Pure. */
export function computeStats(
  sessions: readonly SessionSummary[],
  counters: (id: string) => SessionCounters | null,
  toolStats: readonly ToolStat[],
  ringEvents: readonly ActivityEvent[],
  windowMs: number,
  now: EpochMs,
): FleetStats {
  const st: FleetStats = {
    windowMs,
    computedAt: now,
    sessions: { total: 0, roots: 0, live: 0, working: 0, blocked: 0, waiting: 0, error: 0 },
    activity: { toolCalls: 0, toolErrors: 0, mcpCalls: 0, thinking: 0, fileChanges: 0, filesTouched: 0, subagents: 0 },
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    byHarness: [],
    byModel: [],
    byAgent: [],
    topTools: [],
    mcpServers: [],
    histogram: histogramOf(ringEvents, now),
  }
  const harness = new Map<string, { harness: SessionSummary['harness']; sessions: number; live: number; cost: number }>()
  const model = new Map<string, { model: string; sessions: number; cost: number; tokens: number }>()
  const agent = new Map<string, { agent: string; sessions: number; cost: number }>()

  for (const s of sessions) {
    st.sessions.total++
    if (s.depth === 0) st.sessions.roots++
    if (s.live) st.sessions.live++
    if (s.state === 'working') st.sessions.working++
    else if (s.state === 'blocked') st.sessions.blocked++
    else if (s.state === 'waiting') st.sessions.waiting++
    else if (s.state === 'error') st.sessions.error++
    const c = counters(s.id) ?? s.counters
    if (c) {
      st.activity.toolCalls += c.tools
      st.activity.toolErrors += c.toolErrors
      st.activity.mcpCalls += c.mcpCalls
      st.activity.thinking += c.thinking
      st.activity.fileChanges += c.fileChanges
      st.activity.filesTouched += c.filesTouched
      st.activity.subagents += c.subagents
    }
    st.tokens.input += s.tokens.input
    st.tokens.output += s.tokens.output
    st.tokens.reasoning += s.tokens.reasoning
    st.tokens.cacheRead += s.tokens.cacheRead
    st.tokens.cacheWrite += s.tokens.cacheWrite
    st.cost += s.cost
    const tok = s.tokens.input + s.tokens.output + s.tokens.reasoning

    const h = harness.get(s.harness) ?? { harness: s.harness, sessions: 0, live: 0, cost: 0 }
    h.sessions++
    if (s.live) h.live++
    h.cost += s.cost
    harness.set(s.harness, h)

    const mk = s.model ? s.model.modelId : 'unknown'
    const m = model.get(mk) ?? { model: mk, sessions: 0, cost: 0, tokens: 0 }
    m.sessions++
    m.cost += s.cost
    m.tokens += tok
    model.set(mk, m)

    const ak = s.agent ?? 'unknown'
    const a = agent.get(ak) ?? { agent: ak, sessions: 0, cost: 0 }
    a.sessions++
    a.cost += s.cost
    agent.set(ak, a)
  }

  st.byHarness = [...harness.values()].sort((a, b) => b.sessions - a.sessions)
  st.byModel = [...model.values()].sort((a, b) => b.cost - a.cost || b.sessions - a.sessions)
  st.byAgent = [...agent.values()].sort((a, b) => b.sessions - a.sessions || b.cost - a.cost)

  // merge tool stats across harnesses by (name, server)
  const tools = new Map<string, ToolStat>()
  for (const t of toolStats) {
    const k = `${t.mcpServer ?? ''}\u0000${t.name}`
    const prev = tools.get(k)
    if (prev) {
      prev.calls += t.calls
      prev.errors += t.errors
    } else tools.set(k, { ...t })
  }
  const all = [...tools.values()].sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1))
  st.topTools = all.slice(0, 20)
  const servers = new Map<string, { server: string; calls: number; errors: number; tools: number }>()
  for (const t of all) {
    if (!t.mcpServer) continue
    const e = servers.get(t.mcpServer) ?? { server: t.mcpServer, calls: 0, errors: 0, tools: 0 }
    e.calls += t.calls
    e.errors += t.errors
    e.tools++
    servers.set(t.mcpServer, e)
  }
  st.mcpServers = [...servers.values()].sort((a, b) => b.calls - a.calls)
  return st
}
