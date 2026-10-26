/**
 * Stub — replaced by Task-8.
 *
 * Satisfies the Store contract with empty-but-valid data so the server core can run before the
 * real store exists.
 */
import type { BootstrapPayload, FleetStats, OrcaSnapshot, OrcaStatus, ServerMeta } from '../../shared/contract.js'
import type { CreateStore, Store } from '../types.js'

export const createStore: CreateStore = (deps): Store => {
  const startedAt = deps.now()

  const orcaStatus = (): OrcaStatus => ({
    running: false,
    reachable: false,
    pid: null,
    version: null,
    runtimeState: null,
    checkedAt: deps.now(),
    error: null,
  })

  const meta = (): ServerMeta => ({
    app: 'orca-command-center',
    version: deps.version,
    bootId: deps.hub.bootId,
    startedAt,
    now: deps.now(),
    host: deps.config.host,
    port: deps.config.port,
    readOnly: true,
    windowMs: deps.config.windowMs,
    sources: [],
    orca: orcaStatus(),
  })

  const orca = (): OrcaSnapshot => ({ status: orcaStatus(), worktrees: [], terminals: [], hooks: [] })

  const orchestration = () => ({
    available: false,
    schemaVersion: null,
    testedSchemaVersion: 43,
    degraded: [],
    runs: [],
  })

  const stats = (windowMs?: number): FleetStats => {
    const computedAt = deps.now()
    return {
      windowMs: windowMs ?? deps.config.windowMs,
      computedAt,
      sessions: { total: 0, roots: 0, live: 0, working: 0, blocked: 0, waiting: 0, error: 0 },
      activity: { toolCalls: 0, toolErrors: 0, mcpCalls: 0, thinking: 0, fileChanges: 0, filesTouched: 0, subagents: 0 },
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      byHarness: [],
      byModel: [],
      byAgent: [],
      topTools: [],
      mcpServers: [],
      histogram: Array.from({ length: 60 }, (_, i) => ({
        t: computedAt - (59 - i) * 60_000,
        thinking: 0,
        tools: 0,
        mcp: 0,
        edits: 0,
        errors: 0,
      })),
    }
  }

  const bootstrap = (): BootstrapPayload => ({
    meta: meta(),
    seq: deps.hub.seq,
    sessions: [],
    orca: orca(),
    attention: [],
    activity: [],
    orchestration: orchestration(),
    stats: stats(),
  })

  return {
    async start() {},
    async stop() {},
    meta,
    bootstrap,
    listSessions: () => [],
    sessionDetail: () => null,
    sessionTree: () => null,
    transcript: () => null,
    activity: () => ({ events: [], before: null, hasMore: false }),
    part: () => null,
    fileChanges: () => [],
    fileDiff: () => null,
    artifacts: () => [],
    attention: () => [],
    stats,
    orca,
    orchestration,
    orchestrationRun: () => null,
    orchestrationTask: () => null,
  }
}
