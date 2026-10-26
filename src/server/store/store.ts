import { performance } from 'node:perf_hooks'
import type {
  ActivityEvent,
  ActivityKind,
  ActivityPage,
  AgentState,
  Artifact,
  AttentionItem,
  BootstrapPayload,
  EpochMs,
  FileChange,
  FileDiff,
  FleetStats,
  Harness,
  HookEntry,
  OrcaSnapshot,
  OrcaStatus,
  OrchestrationSummary,
  OrchMessage,
  OrchRunDetail,
  OrchTaskDetail,
  PartDetail,
  ServerMeta,
  SessionCounters,
  SessionDetail,
  SessionEdge,
  SessionSummary,
  SessionTree,
  SourceHealth,
  TerminalInfo,
  ToolStat,
  UsageOutput,
  TranscriptPage,
  WorktreeInfo,
} from '../../shared/contract.js'
import { LIMITS } from '../../shared/contract.js'
import { clip } from '../lib/text.js'
import type {
  ActivityQuery,
  CreateStore,
  HarnessSession,
  HarnessSource,
  HarnessUpdate,
  OrcaCliUpdate,
  OrchestrationUpdate,
  SessionQuery,
  Store,
} from '../types.js'
import { deriveArtifacts } from './artifacts.js'
import { computeAttention } from './attention.js'
import { JoinIndex } from './join.js'
import { ChangeGate, Publisher } from './publish.js'
import { compareEvents, cursorOf, Ring } from './ring.js'
import { allHealth, buildSources, type SourceSet } from './sources.js'
import { deriveState, isLive } from './state.js'
import { computeStats } from './stats.js'
import { UsageService } from './usage-service.js'

const CLOCK_TICK_MS = 15_000
const COUNTER_MIN_INTERVAL_MS = 5_000
const STATS_PUBLISH_MS = 5_000
const TOOL_STATS_TTL_MS = 15_000
const ARTIFACT_TTL_MS = 10_000
const MAX_TREE_NODES = 500
const MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024
const MAX_EXTRAS = 400
const TESTED_ORCH_SCHEMA = 43

const isHookOrOrchEvent = (e: ActivityEvent): boolean => e.source === 'orca.hooks' || e.kind === 'orchestration'

export const createStore: CreateStore = (deps): Store => {
  const { config, log, now } = deps
  const startedAt = now()
  const th = config.thresholds
  const sources: SourceSet = buildSources({ config, log, now })
  const harnessByName = new Map<Harness, HarnessSource>()
  for (const h of sources.harnesses) harnessByName.set(h.harness, h)
  const pub = new Publisher(deps.hub, log)
  const ring = new Ring(config.ringSize)

  /* ───────────────────────────── model state ───────────────────────────── */
  const sessions = new Map<string, HarnessSession>()
  const children = new Map<string, Set<string>>()
  const extras = new Set<string>()
  const summaries = new Map<string, SessionSummary>()
  const observed = new Map<string, { state: AgentState; since: EpochMs | null }>()
  const stalled = new Set<string>()
  const childrenLoaded = new Set<string>()
  const unknownIds = new Map<string, EpochMs>()
  const UNKNOWN_TTL_MS = 5 * 60_000
  const UNKNOWN_MAX = 5000
  const isUnknown = (id: string): boolean => {
    const at = unknownIds.get(id)
    if (at === undefined) return false
    if (now() - at > UNKNOWN_TTL_MS) {
      unknownIds.delete(id)
      return false
    }
    return true
  }
  const markUnknown = (id: string): void => {
    unknownIds.delete(id)
    unknownIds.set(id, now())
    while (unknownIds.size > UNKNOWN_MAX) unknownIds.delete(unknownIds.keys().next().value as string)
  }
  const counterCache = new Map<string, { value: SessionCounters; at: number }>()
  const pendingCounters = new Set<string>()

  let hooks: HookEntry[] = []
  let terminals: TerminalInfo[] = []
  let worktrees: WorktreeInfo[] = []
  let orchSummary: OrchestrationSummary | null = null
  const runDetails = new Map<string, OrchRunDetail>()
  let join = new JoinIndex({ hooks, terminals, worktrees, runs: [], summaryRuns: [] })
  let attentionItems: AttentionItem[] = []
  let started = false
  let stopped = false
  let statsDirty = false
  let derivedScheduled = false

  const attentionGate = new ChangeGate()
  const statsGate = new ChangeGate()
  const orchGate = new ChangeGate()
  const healthGate = new ChangeGate()
  const unsubs: Array<() => void> = []
  const timers = new Set<NodeJS.Timeout>()
  let counterTimer: NodeJS.Timeout | null = null
  const toolStatsCache = new Map<string, { at: number; value: ToolStat[] }>()
  const artifactCache = new Map<string, { at: number; value: Artifact[] }>()

  /* ───────────────────────────── token-flow usage ───────────────────────────── */
  const usage: UsageService = new UsageService({
    log,
    now,
    windowMs: config.windowMs,
    harnesses: sources.harnesses,
    sessionOf: (id) => sessions.get(id) ?? null,
    findSession: (id) => findSession(id),
    rootOf: (id) => rootOf(id),
    loadTree: (id) => void loadTree(id),
    treeIds: (id) => descendantsKnown(id),
    windowSessionIds: (w) => {
      const since = now() - w
      const out: string[] = []
      for (const hs of sessions.values()) if (hs.updatedAt >= since) out.push(hs.id)
      return out
    },
    isLive: (id) => summaries.get(id)?.live === true,
    isProtected: (id) => (sessions.get(id)?.updatedAt ?? 0) >= now() - config.windowMs,
    titleOf: (id) => sessions.get(id)?.title ?? '',
    runSessionIds: (runId) => {
      const d = runDetails.get(runId) ?? sources.orch?.getRun(runId) ?? null
      if (!d) return null
      const out = new Set<string>()
      const c = sessionLinkOfHandle(d.run.coordinatorHandle)
      if (c) out.add(c)
      for (const x of d.dispatches) {
        const a = sessionLinkOfHandle(x.assigneeHandle)
        if (a) out.add(a)
      }
      return [...out]
    },
    outputOf: (kind, id): UsageOutput => {
      const changes = kind === 'workflow' ? fileChanges({ rootId: id }) : fileChanges({ sessionId: id })
      const arts = kind === 'workflow' ? artifacts({ rootId: id }) : artifactsFor(`session:${id}`, () => scopedArtifacts([id]))
      return {
        fileChanges: changes.length,
        filesTouched: new Set(changes.map((c) => c.path)).size,
        additions: changes.reduce((n, c) => n + (c.additions ?? 0), 0),
        deletions: changes.reduce((n, c) => n + (c.deletions ?? 0), 0),
        artifacts: arts.length,
        pullRequests: arts.filter((a) => a.kind === 'pull-request').length,
      }
    },
    publishUsage: (samples, estimates) => pub.publish({ type: 'usage', samples, estimates }),
    refreshSessions: (ids) => publishSessions(rebuild(ids)),
    markStatsDirty: () => {
      statsDirty = true
    },
  })

  /* ───────────────────────────── session graph ───────────────────────────── */

  function srcOf(id: string): HarnessSource | null {
    const hs = sessions.get(id)
    return hs ? (harnessByName.get(hs.harness) ?? null) : null
  }

  function ingestSession(hs: HarnessSession, extra = false): void {
    const prev = sessions.get(hs.id)
    if (prev && prev.parentId !== hs.parentId && prev.parentId) children.get(prev.parentId)?.delete(hs.id)
    if (!prev || prev.parentId !== hs.parentId) usage.invalidateRoots()
    sessions.set(hs.id, hs)
    if (extra && !prev) extras.add(hs.id)
    if (!extra) extras.delete(hs.id)
    if (hs.parentId) {
      let set = children.get(hs.parentId)
      if (!set) children.set(hs.parentId, (set = new Set()))
      set.add(hs.id)
    }
  }

  /** Make sure the ancestors of `id` are loaded (asks the owning harness). Returns ids newly added. */
  function ensureAncestors(id: string): string[] {
    const added: string[] = []
    let cur = sessions.get(id)
    for (let i = 0; cur?.parentId && i < 30; i++) {
      let parent = sessions.get(cur.parentId)
      if (!parent) {
        if (isUnknown(cur.parentId)) break
        let loaded: HarnessSession | null = null
        try {
          loaded = harnessByName.get(cur.harness)?.getSession(cur.parentId) ?? null
        } catch (e) {
          log.debug('store: getSession(%s) failed: %s', cur.parentId, String(e))
        }
        if (!loaded) {
          markUnknown(cur.parentId)
          break
        }
        ingestSession(loaded, true)
        added.push(loaded.id)
        parent = loaded
      }
      cur = parent
    }
    return added
  }

  /** Find a session anywhere (map → harness lookups). */
  function findSession(id: string): HarnessSession | null {
    const known = sessions.get(id)
    if (known) return known
    if (isUnknown(id)) return null
    for (const src of sources.harnesses) {
      try {
        const hs = src.getSession(id)
        if (hs) {
          ingestSession(hs, true)
          const added = ensureAncestors(id)
          rebuild([id, ...added, ...ancestorIds(id)])
          return hs
        }
      } catch (e) {
        log.debug('store: getSession failed: %s', String(e))
      }
    }
    markUnknown(id)
    return null
  }

  function rootOf(id: string): string {
    let cur = id
    for (let i = 0; i < 50; i++) {
      const p = sessions.get(cur)?.parentId
      if (!p || !sessions.has(p)) return cur
      cur = p
    }
    return cur
  }

  function ancestorIds(id: string): string[] {
    const out: string[] = []
    let cur = sessions.get(id)
    for (let i = 0; cur?.parentId && i < 50; i++) {
      out.push(cur.parentId)
      cur = sessions.get(cur.parentId)
    }
    return out
  }

  function descendantsKnown(rootId: string, cap = MAX_TREE_NODES): string[] {
    const out: string[] = [rootId]
    const seen = new Set<string>(out)
    for (let i = 0; i < out.length && out.length < cap; i++) {
      for (const c of children.get(out[i]!) ?? []) if (sessions.has(c) && !seen.has(c)) {
          seen.add(c)
          out.push(c)
        }
    }
    return out
  }

  /** Subtree size (incl. self), memoised per rebuild pass; cycle-safe. */
  function subtreeSize(id: string, memo: Map<string, number>, visiting: Set<string>): number {
    const hit = memo.get(id)
    if (hit !== undefined) return hit
    if (visiting.has(id)) return 0
    visiting.add(id)
    let n = 1
    for (const c of children.get(id) ?? []) if (sessions.has(c)) n += subtreeSize(c, memo, visiting)
    visiting.delete(id)
    memo.set(id, n)
    return n
  }

  function descendantCount(id: string, memo: Map<string, number>): number {
    return Math.min(subtreeSize(id, memo, new Set()), 5000) - 1
  }

  /** Load every descendant (via getChildren) of a root; returns the ids loaded now. */
  function loadTree(rootId: string): string[] {
    const added: string[] = []
    const queue = [rootId]
    const queued = new Set<string>(queue)
    for (let i = 0; i < queue.length && queue.length < MAX_TREE_NODES; i++) {
      const id = queue[i]!
      const src = srcOf(id)
      if (src && !childrenLoaded.has(id)) {
        try {
          for (const c of src.getChildren(id)) {
            if (!sessions.has(c.id)) {
              ingestSession(c, true)
              added.push(c.id)
            } else if (!sessions.get(c.id) || sessions.get(c.id)!.updatedAt < c.updatedAt) ingestSession(c, extras.has(c.id))
          }
          childrenLoaded.add(id)
        } catch (e) {
          log.debug('store: getChildren(%s) failed: %s', id, String(e))
        }
      }
      for (const c of children.get(id) ?? []) if (sessions.has(c) && !queued.has(c)) {
        queued.add(c)
        queue.push(c)
      }
    }
    if (added.length) rebuild([...added, ...ancestorIds(rootId), rootId])
    return added
  }

  /* ───────────────────────────── summaries ───────────────────────────── */

  function computeCounters(id: string): SessionCounters | null {
    const src = srcOf(id)
    if (!src) return null
    try {
      const value = src.getCounters(id)
      counterCache.set(id, { value, at: now() })
      return value
    } catch (e) {
      log.debug('store: getCounters(%s) failed: %s', id, String(e))
      return null
    }
  }

  function buildSummary(id: string, t: EpochMs, linkCache: Map<string, ReturnType<JoinIndex['linkRoot']>>,
    sizeMemo: Map<string, number>,
  ): SessionSummary | null {
    const hs = sessions.get(id)
    if (!hs) return null
    const rootId = rootOf(id)
    let depth = 0
    for (let cur = hs; cur.parentId && sessions.has(cur.parentId) && depth < 50; depth++) cur = sessions.get(cur.parentId)!
    const root = sessions.get(rootId)!
    let rootLink = linkCache.get(rootId)
    if (!rootLink) linkCache.set(rootId, (rootLink = join.linkRoot(rootId, root.directory)))
    let orca = null as SessionSummary['orca']
    let workspace = rootLink.workspace
    if (rootId === id) orca = rootLink.orca
    else if (rootLink.orca?.worktreeId) {
      orca = {
        paneKey: null,
        tabId: null,
        terminalHandle: null,
        terminalTitle: null,
        worktreeId: rootLink.orca.worktreeId,
        hookEvent: null,
        hookState: null,
        hookAt: null,
        runId: null,
        taskId: null,
        dispatchId: null,
        role: null,
      }
    }
    if (!workspace) workspace = join.workspaceByDirectory(hs.directory)

    const hook = join.hookBySession.get(id) ?? null
    const dispatch = hook && hook.state ? null : join.dispatchOf(id)
    const d = deriveState({ session: hs, hook, dispatch }, t, th)
    if (d.stalled) stalled.add(id)
    else stalled.delete(id)
    const prev = observed.get(id)
    if (!prev || prev.state !== d.state) observed.set(id, { state: d.state, since: prev ? t : null })
    const stateSince = d.hookSince ?? observed.get(id)?.since ?? hs.lastActivityAt ?? hs.updatedAt
    const kids = [...(children.get(id) ?? [])]
      .map((c) => sessions.get(c))
      .filter((c): c is HarnessSession => !!c)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((c) => c.id)

    const live = isLive(d.state, hs.lastActivityAt, hs.updatedAt, t, th)
    const usageRollup = usage.usageOf(id, live, rootId === id)

    return {
      id,
      harness: hs.harness,
      parentId: hs.parentId,
      rootId,
      depth,
      title: hs.title,
      agent: hs.agent,
      model: hs.model,
      directory: hs.directory,
      workspace,
      createdAt: hs.createdAt,
      updatedAt: hs.updatedAt,
      lastActivityAt: hs.lastActivityAt,
      archivedAt: hs.archivedAt,
      state: d.state,
      stateSource: d.stateSource,
      stateSince,
      live,
      current: hs.current,
      lastPrompt: hs.lastPrompt,
      lastMessage: hs.lastMessage,
      counters: counterCache.get(id)?.value ?? null,
      tokens: hs.tokens,
      cost: hs.cost,
      childIds: kids,
      descendantCount: kids.length === 0 ? 0 : descendantCount(id, sizeMemo),
      spawn: hs.spawn,
      orca,
      facts: hs.facts,
      ...(usageRollup ? { usage: usageRollup } : {}),
    }
  }

  const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)
  /** Cheap field-wise comparison: primitives/identity first, JSON only for differing object refs. */
  function summaryEqual(a: SessionSummary, b: SessionSummary, withRates = false): boolean {
    const x = a as unknown as Record<string, unknown>
    const y = b as unknown as Record<string, unknown>
    for (const k in y) {
      const u = x[k]
      const v = y[k]
      if (u === v) continue
      if (typeof u !== 'object' || typeof v !== 'object' || !u || !v) return false
      if (k === 'usage') {
        // rates decay continuously and estimates re-stamp on every poll: only the clock tick compares them
        const skip = withRates ? ['asOf'] : ['asOf', 'rates', 'updatedAt']
        const norm = (o: unknown) => JSON.stringify(o, (key, val) => (skip.includes(key) ? undefined : val))
        if (norm(u) !== norm(v)) return false
      } else if (k === 'childIds') {
        const ua = u as string[]
        const va = v as string[]
        if (ua.length !== va.length || ua.some((c, i) => c !== va[i])) return false
      } else if (!sameJson(u, v)) return false
    }
    for (const k in x) if (!(k in y) && x[k] !== undefined) return false
    return true
  }

  /** Rebuild summaries; returns the ones whose JSON changed. */
  function rebuild(ids: Iterable<string>, force = false, withRates = false): SessionSummary[] {
    const t = now()
    const linkCache = new Map<string, ReturnType<JoinIndex['linkRoot']>>()
    const sizeMemo = new Map<string, number>()
    const changed: SessionSummary[] = []
    for (const id of new Set(ids)) {
      const s = buildSummary(id, t, linkCache, sizeMemo)
      if (!s) continue
      const old = summaries.get(id)
      if (!force && old && summaryEqual(old, s, withRates)) continue
      summaries.set(id, s)
      changed.push(s)
    }
    if (changed.length) statsDirty = true
    return changed
  }

  const visibleIds = (windowMs = config.windowMs): Set<string> => {
    const since = now() - windowMs
    const out = new Set<string>()
    for (const hs of sessions.values()) {
      if (hs.updatedAt < since || extras.has(hs.id)) continue
      out.add(hs.id)
      for (const a of ancestorIds(hs.id)) out.add(a)
    }
    return out
  }

  const windowSessions = (windowMs = config.windowMs): SessionSummary[] => {
    const since = now() - windowMs
    const out: SessionSummary[] = []
    for (const hs of sessions.values()) {
      if (hs.updatedAt < since) continue
      const s = summaries.get(hs.id)
      if (s) out.push(s)
    }
    return out
  }

  function publishSessions(changed: SessionSummary[], removed: string[] = []): void {
    if (!pub.ready) return
    const vis = visibleIds()
    const out = changed.filter((s) => vis.has(s.id))
    if (out.length === 0 && removed.length === 0) return
    pub.publish({ type: 'sessions', sessions: out, removed })
  }

  /** Re-derive every session (joins/time changed) and publish what changed. */
  function rebuildAllAndPublish(): void {
    const changed = rebuild(sessions.keys())
    publishSessions(changed)
    scheduleDerived()
  }

  /* ───────────────────────────── counters ───────────────────────────── */

  function noteActivity(id: string): void {
    pendingCounters.add(id)
    if (!counterTimer && !stopped) {
      counterTimer = setTimeout(flushCounters, 1000)
      counterTimer.unref?.()
    }
  }

  function flushCounters(): void {
    counterTimer = null
    if (stopped) return
    const t = now()
    const done: string[] = []
    for (const id of pendingCounters) {
      const c = counterCache.get(id)
      if (c && t - c.at < COUNTER_MIN_INTERVAL_MS) continue
      pendingCounters.delete(id)
      if (computeCounters(id)) done.push(id)
    }
    if (done.length) publishSessions(rebuild(done))
    if (pendingCounters.size) {
      counterTimer = setTimeout(flushCounters, 1000)
      counterTimer.unref?.()
    }
  }

  function backgroundCounters(ids: string[]): void {
    let i = 0
    const step = () => {
      if (stopped) return
      const t0 = performance.now()
      const done: string[] = []
      while (i < ids.length && performance.now() - t0 < 25) {
        const id = ids[i++]!
        if (!counterCache.has(id) && computeCounters(id)) done.push(id)
      }
      if (done.length) publishSessions(rebuild(done))
      if (i < ids.length) setImmediate(step)
    }
    setImmediate(step)
  }

  /* ───────────────────────────── ring / events ───────────────────────────── */

  function withRoot(e: ActivityEvent): ActivityEvent {
    if (!e.sessionId) return e
    if (!sessions.has(e.sessionId)) findSession(e.sessionId)
    const rootId = sessions.has(e.sessionId) ? rootOf(e.sessionId) : e.rootId
    return rootId === e.rootId ? e : { ...e, rootId }
  }

  function ingestEvents(events: ActivityEvent[]): ActivityEvent[] {
    return ring.upsertMany(events.map(withRoot))
  }

  const sessionLinkOfHandle = (handle: string | null | undefined): string | null => (handle ? (join.sessionByHandle.get(handle) ?? null) : null)

  function orchEvent(m: OrchMessage): ActivityEvent {
    const sid = sessionLinkOfHandle(m.from)
    const hs = sid ? sessions.get(sid) : undefined
    return {
      id: `orch:${m.id}`,
      rev: m.createdAt ?? 0,
      harness: hs?.harness ?? 'unknown',
      sessionId: sid,
      rootId: sid && hs ? rootOf(sid) : null,
      messageId: null,
      ts: m.createdAt ?? now(),
      endTs: null,
      kind: 'orchestration',
      status: null,
      title: clip(`${m.type} · ${m.subject}`, LIMITS.titleChars),
      summary: m.bodyPreview ? clip(m.bodyPreview, LIMITS.summaryChars) : null,
      tool: null,
      files: [],
      childSessionId: null,
      usage: null,
      links: [],
      source: 'orchestration.messages',
      detailRef: null,
    }
  }

  /* ───────────────────────────── orchestration ───────────────────────────── */

  function refreshRuns(): void {
    const src = sources.orch
    orchSummary = src ? src.summary() : null
    const seen = new Set<string>()
    for (const r of orchSummary?.runs ?? []) {
      seen.add(r.id)
      const d = src?.getRun(r.id)
      if (d) runDetails.set(r.id, d)
    }
    for (const id of [...runDetails.keys()]) if (!seen.has(id)) runDetails.delete(id)
  }

  function rebuildJoin(): void {
    join = new JoinIndex({ hooks, terminals, worktrees, runs: [...runDetails.values()], summaryRuns: orchSummary?.runs ?? [] })
  }

  function fillRun(d: OrchRunDetail): OrchRunDetail {
    return {
      ...d,
      run: { ...d.run, coordinatorSessionId: sessionLinkOfHandle(d.run.coordinatorHandle) },
      dispatches: d.dispatches.map((x) => ({ ...x, assigneeSessionId: sessionLinkOfHandle(x.assigneeHandle) })),
    }
  }

  function orchestrationSummary(): OrchestrationSummary {
    if (!orchSummary) {
      const h = sources.orch?.health()
      return { available: false, schemaVersion: null, testedSchemaVersion: TESTED_ORCH_SCHEMA, degraded: h?.detail ? [h.detail] : [], runs: [] }
    }
    return { ...orchSummary, runs: orchSummary.runs.map((r) => ({ ...r, coordinatorSessionId: sessionLinkOfHandle(r.coordinatorHandle) })) }
  }

  function maybePublishOrchestration(changedRunIds: string[], force = false): void {
    const summary = orchestrationSummary()
    if (orchGate.changed(summary) || force) pub.publish({ type: 'orchestration', summary, changedRunIds })
  }

  /* ───────────────────────────── orca views ───────────────────────────── */

  const defaultOrcaStatus = (reason: string): OrcaStatus => ({ running: false, reachable: false, pid: null, version: null, runtimeState: null, checkedAt: now(), error: reason })
  const orcaStatus = (): OrcaStatus => (sources.cli ? sources.cli.status() : defaultOrcaStatus('Orca CLI not found'))

  function orcaSnapshot(): OrcaSnapshot {
    return { status: orcaStatus(), worktrees, terminals: join.terminalsWithSessions(terminals), hooks }
  }

  /* ───────────────────────────── attention / stats ───────────────────────────── */

  function recomputeAttention(): void {
    const t = now()
    const win = windowSessions()
    const toolErrors = new Map<string, ActivityEvent[]>()
    const liveIds = new Set(win.filter((s) => s.live).map((s) => s.id))
    for (const e of ring.query({
      sinceMs: t - 10 * 60_000,
      limit: 5000,
      filter: (e) => (e.kind === 'tool' || e.kind === 'mcp') && e.status === 'error' && !!e.sessionId && liveIds.has(e.sessionId),
    }).events) {
      const l = toolErrors.get(e.sessionId!) ?? []
      l.push(e)
      toolErrors.set(e.sessionId!, l)
    }
    const latestPermission = new Map<string, ActivityEvent>()
    for (const s of win) {
      if (s.harness === 'copilot' && s.state === 'waiting') {
        const e = ring.query({ sessionIds: [s.id], kinds: ['permission'], limit: 1 }).events[0]
        if (e) latestPermission.set(s.id, e)
      }
    }
    attentionItems = computeAttention({
      sessions: win,
      stalled,
      runs: [...runDetails.values()].map(fillRun),
      toolErrors,
      latestPermission,
      now: t,
      thresholds: th,
    })
    if (attentionGate.changed(attentionItems)) pub.publish({ type: 'attention', items: attentionItems })
  }

  function scheduleDerived(): void {
    if (derivedScheduled || stopped) return
    derivedScheduled = true
    setImmediate(() => {
      derivedScheduled = false
      if (!stopped && started) recomputeAttention()
    })
  }

  function toolStatsFor(windowMs: number): ToolStat[] {
    const key = String(windowMs)
    const hit = toolStatsCache.get(key)
    const t = now()
    if (hit && t - hit.at < TOOL_STATS_TTL_MS) {
      toolStatsCache.delete(key)
      toolStatsCache.set(key, hit)
      return hit.value
    }
    const byHarness = groupByHarness(windowSessions(windowMs).map((s) => s.id))
    const out: ToolStat[] = []
    for (const [src, ids] of byHarness) {
      try {
        out.push(...src.getToolStats(ids))
      } catch (e) {
        log.debug('store: getToolStats failed: %s', String(e))
      }
    }
    toolStatsCache.delete(key)
    toolStatsCache.set(key, { at: t, value: out })
    while (toolStatsCache.size > 8) toolStatsCache.delete(toolStatsCache.keys().next().value as string)
    return out
  }

  function groupByHarness(ids: string[]): Map<HarnessSource, string[]> {
    const m = new Map<HarnessSource, string[]>()
    for (const id of ids) {
      const src = srcOf(id)
      if (!src) continue
      const l = m.get(src) ?? []
      l.push(id)
      m.set(src, l)
    }
    return m
  }

  function stats(windowMs?: number): FleetStats {
    const w = windowMs ?? config.windowMs
    const t = now()
    const st = computeStats(windowSessions(w), (id) => counterCache.get(id)?.value ?? null, toolStatsFor(w), ring.all(), w, t)
    const u = usage.fleetUsage(w)
    if (u) st.usage = u
    return st
  }

  function publishStatsIfChanged(): void {
    if (!statsDirty || !pub.ready) return
    statsDirty = false
    const s = stats()
    if (statsGate.changed(s, ['computedAt', 'asOf'])) pub.publish({ type: 'stats', stats: s })
  }

  /* ───────────────────────────── artifacts ───────────────────────────── */

  function artifactsFor(key: string, build: () => Artifact[]): Artifact[] {
    const t = now()
    const hit = artifactCache.get(key)
    if (hit && t - hit.at < ARTIFACT_TTL_MS) return hit.value
    let value: Artifact[] = []
    try {
      value = build()
    } catch (e) {
      log.debug('store: artifacts failed: %s', String(e))
    }
    artifactCache.set(key, { at: t, value })
    if (artifactCache.size > 100) artifactCache.delete(artifactCache.keys().next().value as string)
    return value
  }

  function scopedArtifacts(ids: string[]): Artifact[] {
    const events: ActivityEvent[] = []
    const changes: FileChange[] = []
    for (const [src, list] of groupByHarness(ids)) {
      events.push(...src.getActivity(list, { kinds: ['file-change', 'text', 'tool', 'mcp', 'prompt'], limit: 5000 }).events)
      changes.push(...src.getFileChanges(list))
    }
    return deriveArtifacts(events, changes, { rootOf })
  }

  function windowArtifacts(windowMs: number): Artifact[] {
    const since = now() - windowMs
    const ids = new Set(windowSessions(windowMs).map((s) => s.id))
    const events = ring.all().filter((e) => e.ts >= since && !!e.sessionId && ids.has(e.sessionId))
    const changes: FileChange[] = []
    for (const [src, list] of groupByHarness([...ids])) changes.push(...src.getFileChanges(list, since))
    return deriveArtifacts(events, changes, { rootOf }, 500)
  }

  /* ───────────────────────────── seeding ───────────────────────────── */

  function seedHarness(src: HarnessSource): void {
    const since = now() - config.windowMs
    try {
      for (const hs of src.listSessions(since)) ingestSession(hs)
    } catch (e) {
      log.warn('store: %s listSessions failed: %s', src.id, e instanceof Error ? e.message : String(e))
    }
  }

  function seedHarnessEvents(src: HarnessSource): void {
    const since = now() - config.windowMs
    try {
      for (const hs of [...sessions.values()]) if (hs.harness === src.harness) ensureAncestors(hs.id)
      ingestEvents(src.recentActivity({ sinceMs: since, limit: 3000 }))
    } catch (e) {
      log.warn('store: %s recentActivity failed: %s', src.id, e instanceof Error ? e.message : String(e))
    }
  }

  function seedOrchEvents(): void {
    const since = now() - config.windowMs
    const events: ActivityEvent[] = []
    for (const d of runDetails.values()) {
      for (const m of d.messages) if (m.type !== 'heartbeat' && (m.createdAt ?? 0) >= since) events.push(orchEvent(m))
    }
    ring.upsertMany(events)
  }

  /* ───────────────────────────── update handlers ───────────────────────────── */

  function onHarness(src: HarnessSource, u: HarnessUpdate): void {
    if (stopped) return
    try {
      switch (u.type) {
        case 'sessions': {
          const touched = new Set<string>()
          for (const hs of u.sessions) {
            ingestSession(hs)
            unknownIds.delete(hs.id)
            touched.add(hs.id)
            for (const a of ensureAncestors(hs.id)) touched.add(a)
            for (const a of ancestorIds(hs.id)) touched.add(a)
            if (!counterCache.has(hs.id)) noteActivity(hs.id)
          }
          if (started) usage.enqueue(touched)
          publishSessions(rebuild(touched))
          scheduleDerived()
          break
        }
        case 'activity': {
          const touched = new Set<string>()
          for (const e of u.events) {
            if (!e.sessionId) continue
            if (!sessions.has(e.sessionId)) {
              unknownIds.delete(e.sessionId)
              findSession(e.sessionId)
            }
            const hs = sessions.get(e.sessionId)
            if (!hs) continue
            const at = Math.max(e.ts, e.endTs ?? 0)
            if (at <= now() + 60_000 && (hs.lastActivityAt === null || at > hs.lastActivityAt)) sessions.set(hs.id, { ...hs, lastActivityAt: at })
            touched.add(e.sessionId)
            noteActivity(e.sessionId)
          }
          const stored = ingestEvents(u.events)
          if (stored.length) pub.publish({ type: 'activity', events: stored })
          const withAnc = new Set<string>()
          for (const id of touched) for (const a of [id, ...ancestorIds(id)]) withAnc.add(a)
          publishSessions(rebuild(withAnc))
          statsDirty = true
          scheduleDerived()
          break
        }
        case 'todos': {
          const s = rebuild([u.sessionId], true)
          publishSessions(s)
          break
        }
        case 'usage': {
          usage.ingestLive(u.samples, u.estimates)
          break
        }
        case 'reset': {
          log.info('store: %s reset (%s) — reseeding', src.id, u.reason)
          reseed(src)
          break
        }
      }
    } catch (e) {
      log.warn('store: %s update failed: %s', src.id, e instanceof Error ? e.message : String(e))
    }
  }

  function reseed(src: HarnessSource): void {
    const gone: string[] = []
    for (const [id, hs] of [...sessions]) {
      if (hs.harness !== src.harness) continue
      sessions.delete(id)
      children.delete(id)
      summaries.delete(id)
      counterCache.delete(id)
      extras.delete(id)
      gone.push(id)
      usage.removeSessions([id])
    }
    childrenLoaded.clear()
    unknownIds.clear()
    toolStatsCache.clear()
    artifactCache.clear()
    ring.removeWhere((e) => e.harness === src.harness && !isHookOrOrchEvent(e))
    seedHarness(src)
    seedHarnessEvents(src)
    const changed = rebuild(sessions.keys(), true)
    const removed = gone.filter((id) => !sessions.has(id))
    publishSessions(changed, removed)
    pub.publish({ type: 'meta', meta: meta() })
    scheduleDerived()
    backgroundCounters(changed.filter((s) => s.harness === src.harness).map((s) => s.id))
    usage.enqueue([...sessions.values()].filter((hs) => hs.harness === src.harness).map((hs) => hs.id))
  }

  function onCli(u: OrcaCliUpdate): void {
    if (stopped) return
    try {
      if (u.type === 'status') {
        pub.publish({ type: 'orca', orca: { status: u.status } })
        pub.publish({ type: 'meta', meta: meta() })
      } else {
        worktrees = u.worktrees
        terminals = u.terminals
        rebuildJoin()
        pub.publish({ type: 'orca', orca: { worktrees, terminals: join.terminalsWithSessions(terminals) } })
        rebuildAllAndPublish()
        maybePublishOrchestration([])
      }
    } catch (e) {
      log.warn('store: orca-cli update failed: %s', e instanceof Error ? e.message : String(e))
    }
  }

  function onHooks(u: { entries: HookEntry[]; transitions: ActivityEvent[] }): void {
    if (stopped) return
    try {
      hooks = u.entries
      rebuildJoin()
      const stored = ingestEvents(u.transitions)
      if (stored.length) pub.publish({ type: 'activity', events: stored })
      pub.publish({ type: 'orca', orca: { hooks, terminals: join.terminalsWithSessions(terminals) } })
      rebuildAllAndPublish()
      maybePublishOrchestration([])
    } catch (e) {
      log.warn('store: orca-hooks update failed: %s', e instanceof Error ? e.message : String(e))
    }
  }

  function onOrchestration(u: OrchestrationUpdate): void {
    if (stopped) return
    try {
      refreshRuns()
      rebuildJoin()
      const stored = ring.upsertMany(u.newMessages.filter((m) => m.type !== 'heartbeat').map(orchEvent))
      if (stored.length) pub.publish({ type: 'activity', events: stored })
      pub.publish({ type: 'orchestration', summary: orchestrationSummary(), changedRunIds: u.changedRunIds })
      orchGate.changed(orchestrationSummary())
      rebuildAllAndPublish()
    } catch (e) {
      log.warn('store: orchestration update failed: %s', e instanceof Error ? e.message : String(e))
    }
  }

  /* ───────────────────────────── clock ───────────────────────────── */

  function clockTick(): void {
    if (stopped) return
    try {
      const t = now()
      const since = t - config.windowMs
      const vis = visibleIds()
      const removed: string[] = []
      const parents: Array<[string, string | null | undefined]> = []
      for (const [id, hs] of [...sessions]) {
        if (extras.has(id) || vis.has(id) || hs.updatedAt >= since) continue
        if (summaries.get(id)?.live) continue
        parents.push([id, hs.parentId])
        sessions.delete(id)
        summaries.delete(id)
        counterCache.delete(id)
        observed.delete(id)
        stalled.delete(id)
        removed.push(id)
      }
      for (const [id, p] of parents) {
        if (p) children.get(p)?.delete(id)
        children.delete(id)
      }
      if (extras.size > MAX_EXTRAS) {
        for (const id of [...extras].slice(0, extras.size - MAX_EXTRAS)) {
          extras.delete(id)
          sessions.delete(id)
          summaries.delete(id)
        }
      }
      usage.tick()
      const changed = rebuild(sessions.keys(), false, true)
      publishSessions(changed, removed)
      recomputeAttention()
      statsDirty = true
    } catch (e) {
      log.warn('store: clock tick failed: %s', e instanceof Error ? e.message : String(e))
    }
  }

  /** Status-level digest: `detail` carries live counters (cursor, pane counts), so only non-ok details count. */
  function healthDigest(): unknown {
    return allHealth(sources).map((h) => ({ id: h.id, status: h.status, version: h.version, path: h.path, detail: h.status === 'ok' ? null : h.detail }))
  }

  function checkHealth(): void {
    if (stopped) return
    if (healthGate.changed(healthDigest())) pub.publish({ type: 'meta', meta: meta() })
  }

  /* ───────────────────────────── reader API ───────────────────────────── */

  function meta(): ServerMeta {
    return {
      app: 'orca-command-center',
      version: deps.version,
      bootId: deps.hub.bootId,
      startedAt,
      now: now(),
      host: config.host,
      port: config.port,
      readOnly: true,
      windowMs: config.windowMs,
      sources: allHealth(sources).map(withLedgerDetail),
      orca: orcaStatus(),
    }
  }

  function withLedgerDetail(h: SourceHealth): SourceHealth {
    const ls = usage.stats()
    if (ls.evictedSessions === 0 || (h.id !== 'opencode' && h.id !== 'copilot')) return h
    const note = `usage ledger evicted ${ls.evictedSessions} sessions (${ls.evictedSamples} samples)`
    return { ...h, detail: h.detail ? `${h.detail}; ${note}` : note }
  }

  function bootstrap(): BootstrapPayload {
    const vis = visibleIds()
    const list = [...vis].map((id) => summaries.get(id)).filter((s): s is SessionSummary => !!s)
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    let activity = ring.all().filter((e) => e.kind !== 'step').slice(-LIMITS.bootstrapActivity)
    const payload: BootstrapPayload = {
      meta: meta(),
      seq: deps.hub.seq,
      sessions: list,
      orca: orcaSnapshot(),
      attention: attentionItems,
      activity,
      orchestration: orchestrationSummary(),
      stats: stats(),
    }
    const size = JSON.stringify(payload).length
    if (size > MAX_BOOTSTRAP_BYTES && activity.length > 20) {
      // estimate per-event cost once, then drop the oldest events in a single pass
      const sizes = activity.map((e) => JSON.stringify(e).length + 1)
      let total = size
      let drop = 0
      while (total > MAX_BOOTSTRAP_BYTES && activity.length - drop > 20) {
        total -= sizes[drop++]!
      }
      activity = activity.slice(drop)
      payload.activity = activity
    }
    return payload
  }

  function listSessions(q: SessionQuery): SessionSummary[] {
    const since = now() - (q.windowMs ?? config.windowMs)
    const needle = q.q?.trim().toLowerCase()
    const out: SessionSummary[] = []
    for (const hs of sessions.values()) {
      if (hs.updatedAt < since) continue
      const s = summaries.get(hs.id)
      if (!s) continue
      if (q.harness && s.harness !== q.harness) continue
      if (q.state && s.state !== q.state) continue
      if (q.liveOnly && !s.live) continue
      if (needle) {
        const hay = [s.title, s.agent, s.directory, s.workspace?.name].filter(Boolean).join('\n').toLowerCase()
        if (!hay.includes(needle)) continue
      }
      out.push(s)
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out.slice(0, Math.min(q.limit ?? 2000, 2000))
  }

  function summaryOf(id: string): SessionSummary | null {
    if (!sessions.has(id) && !findSession(id)) return null
    if (!summaries.has(id)) rebuild([id, ...ancestorIds(id)])
    return summaries.get(id) ?? null
  }

  function sessionDetail(id: string): SessionDetail | null {
    const s0 = summaryOf(id)
    if (!s0) return null
    if (!counterCache.has(id)) {
      computeCounters(id)
      rebuild([id])
    }
    const s = summaries.get(id) ?? s0
    const src = srcOf(id)
    const anc = ancestorIds(id)
      .reverse()
      .map((a) => summaries.get(a))
      .filter((x): x is SessionSummary => !!x)
    const kids = s.childIds.map((c) => summaries.get(c)).filter((x): x is SessionSummary => !!x)
    let todos: SessionDetail['todos'] = []
    let fileChanges: FileChange[] = []
    try {
      todos = src?.getTodos(id) ?? []
    } catch (e) {
      log.debug('store: getTodos failed: %s', String(e))
    }
    try {
      fileChanges = (src?.getFileChanges([id]) ?? []).map((c) => ({ ...c, rootId: rootOf(c.sessionId) }))
    } catch (e) {
      log.debug('store: getFileChanges failed: %s', String(e))
    }
    const provenance: string[] = [s.harness === 'opencode' ? 'opencode.db · session' : s.harness === 'copilot' ? 'copilot session-state · events.jsonl' : `${s.harness} · session`]
    if (s.orca?.paneKey) provenance.push(`Orca hooks · pane ${s.orca.paneKey}`)
    if (s.orca?.terminalHandle) provenance.push(`orca terminal list · ${s.orca.terminalHandle}`)
    if (s.orca?.runId) provenance.push(`orchestration.db · run ${s.orca.runId}${s.orca.role ? ` (${s.orca.role})` : ''}`)
    if (s.spawn) provenance.push('parent tool call · spawn')
    return {
      session: s,
      ancestors: anc,
      children: kids,
      todos,
      fileChanges,
      artifacts: artifactsFor(`session:${id}`, () => scopedArtifacts([id])),
      provenance,
    }
  }

  function sessionTree(id: string): SessionTree | null {
    if (!summaryOf(id)) return null
    const rootId = rootOf(id)
    loadTree(rootId)
    const ids = descendantsKnown(rootId)
    const nodes = ids.map((n) => summaries.get(n)).filter((x): x is SessionSummary => !!x)
    const present = new Set(nodes.map((n) => n.id))
    const edges: SessionEdge[] = []
    for (const n of nodes) {
      if (!n.parentId || !present.has(n.parentId)) continue
      edges.push({ id: `edge:${n.parentId}:${n.id}`, from: n.parentId, to: n.id, label: n.spawn?.description ?? null, status: n.spawn?.status ?? null, activityId: n.spawn?.activityId ?? null })
    }
    const root = summaries.get(rootId)
    let orchestration: SessionTree['orchestration'] = null
    if (root?.orca?.role === 'coordinator' && root.orca.runId) {
      const d = runDetails.get(root.orca.runId)
      orchestration = { runId: root.orca.runId, taskIds: d ? d.tasks.map((t) => t.id) : [] }
    }
    return { rootId, nodes, edges, orchestration }
  }

  function transcript(id: string, options: { before?: string; limit: number }): TranscriptPage | null {
    if (!findSession(id)) return null
    try {
      return srcOf(id)?.getTranscript(id, options) ?? null
    } catch (e) {
      log.debug('store: transcript failed: %s', String(e))
      return null
    }
  }

  function activity(q: ActivityQuery): ActivityPage {
    const limit = Math.max(1, Math.min(q.limit, LIMITS.activityPageMax))
    const scopeRoot = q.sessionId ?? q.rootId
    if (!scopeRoot) return ring.query({ kinds: q.kinds, before: q.before, sinceMs: q.sinceMs, limit })
    if (!findSession(scopeRoot)) return { events: [], before: null, hasMore: false }
    const ids = q.sessionId ? [q.sessionId] : (loadTree(rootOf(scopeRoot)), descendantsKnown(rootOf(scopeRoot)))
    const pages: ActivityPage[] = []
    for (const [src, list] of groupByHarness(ids)) {
      try {
        pages.push(src.getActivity(list, { kinds: q.kinds, before: q.before, sinceMs: q.sinceMs, limit }))
      } catch (e) {
        log.debug('store: getActivity failed: %s', String(e))
      }
    }
    // Events older than the oldest event of any truncated page may be missing from that page.
    let cutoff = -Infinity
    for (const p of pages) if (p.hasMore && p.events.length) cutoff = Math.max(cutoff, p.events[0]!.ts)
    const extra = ring.query({ sessionIds: ids, kinds: q.kinds, before: q.before, sinceMs: Math.max(q.sinceMs ?? -Infinity, cutoff), limit, filter: isHookOrOrchEvent })
    const merged = new Map<string, ActivityEvent>()
    for (const e of [...pages.flatMap((p) => p.events), ...extra.events]) {
      const prev = merged.get(e.id)
      if (!prev || e.rev >= prev.rev) merged.set(e.id, e.rootId === null && e.sessionId ? withRoot(e) : e)
    }
    const all = [...merged.values()].sort(compareEvents)
    const anyMore = pages.some((p) => p.hasMore) || extra.hasMore
    const events = all.length > limit ? all.slice(all.length - limit) : all
    const hasMore = anyMore || all.length > limit
    return { events, before: hasMore && events.length ? cursorOf(events[0]!) : null, hasMore }
  }

  function routeHarnesses(id: string): HarnessSource[] {
    const i = id.indexOf(':')
    const prefix = i > 0 ? id.slice(0, i) : ''
    const direct = harnessByName.get(prefix as Harness)
    return direct ? [direct] : sources.harnesses
  }

  function part(id: string): PartDetail | null {
    for (const src of routeHarnesses(id)) {
      try {
        const p = src.getPart(id)
        if (p) return p
      } catch (e) {
        log.debug('store: getPart failed: %s', String(e))
      }
    }
    return null
  }

  function fileDiff(id: string): FileDiff | null {
    for (const src of routeHarnesses(id)) {
      try {
        const d = src.getDiff(id)
        if (d) return d
      } catch (e) {
        log.debug('store: getDiff failed: %s', String(e))
      }
    }
    return null
  }

  function fileChanges(q: { rootId?: string; sessionId?: string; windowMs?: number }): FileChange[] {
    const since = q.windowMs !== undefined ? now() - q.windowMs : undefined
    let ids: string[]
    if (q.sessionId) ids = findSession(q.sessionId) ? [q.sessionId] : []
    else if (q.rootId) {
      if (!findSession(q.rootId)) return []
      loadTree(rootOf(q.rootId))
      ids = descendantsKnown(rootOf(q.rootId))
    } else ids = windowSessions(q.windowMs ?? config.windowMs).map((s) => s.id)
    const out: FileChange[] = []
    for (const [src, list] of groupByHarness(ids)) {
      try {
        for (const c of src.getFileChanges(list, since ?? (q.rootId || q.sessionId ? undefined : now() - config.windowMs))) out.push({ ...c, rootId: rootOf(c.sessionId) })
      } catch (e) {
        log.debug('store: getFileChanges failed: %s', String(e))
      }
    }
    return out
  }

  function artifacts(q: { rootId?: string; windowMs?: number }): Artifact[] {
    if (q.rootId) {
      const root = q.rootId
      if (!findSession(root)) return []
      return artifactsFor(`root:${rootOf(root)}`, () => {
        loadTree(rootOf(root))
        return scopedArtifacts(descendantsKnown(rootOf(root)))
      })
    }
    const w = q.windowMs ?? config.windowMs
    return artifactsFor(`window:${w}`, () => windowArtifacts(w))
  }

  function orchestrationRun(id: string): OrchRunDetail | null {
    const d = sources.orch?.getRun(id) ?? null
    return d ? fillRun(d) : null
  }

  function orchestrationTask(id: string): OrchTaskDetail | null {
    const d = sources.orch?.getTask(id) ?? null
    if (!d) return null
    return { ...d, dispatches: d.dispatches.map((x) => ({ ...x, assigneeSessionId: sessionLinkOfHandle(x.assigneeHandle) })) }
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  async function start(): Promise<void> {
    if (started) return
    for (const src of sources.harnesses) unsubs.push(src.subscribe((u) => onHarness(src, u)))
    if (sources.cli) unsubs.push(sources.cli.subscribe(onCli))
    if (sources.hooks) unsubs.push(sources.hooks.subscribe(onHooks))
    if (sources.orch) unsubs.push(sources.orch.subscribe(onOrchestration))

    const results = await Promise.allSettled(sources.all.map((s) => s.start()))
    results.forEach((r, i) => {
      if (r.status === 'rejected') log.warn('store: source %s failed to start: %s', sources.all[i]!.id, r.reason instanceof Error ? r.reason.message : String(r.reason))
    })
    const guard = <T>(fn: () => T, fallback: T): T => {
      try {
        return fn()
      } catch (e) {
        log.warn('store: seed failed: %s', e instanceof Error ? e.message : String(e))
        return fallback
      }
    }
    worktrees = guard(() => sources.cli?.worktrees() ?? [], [])
    terminals = guard(() => sources.cli?.terminals() ?? [], [])
    hooks = guard(() => sources.hooks?.entries() ?? [], [])
    guard(() => refreshRuns(), undefined)
    rebuildJoin()
    for (const src of sources.harnesses) seedHarness(src)
    for (const src of sources.harnesses) seedHarnessEvents(src)
    seedOrchEvents()
    const all = rebuild(sessions.keys())
    const liveIds = all.filter((s) => s.live).map((s) => s.id)
    for (const id of liveIds) computeCounters(id)
    rebuild(liveIds)
    backgroundCounters(all.filter((s) => !s.live).map((s) => s.id))
    started = true
    recomputeAttention()
    statsGate.changed(stats(), ['computedAt', 'asOf'])
    orchGate.changed(orchestrationSummary())
    healthGate.changed(healthDigest())
    pub.ready = true
    {
      const wins = [...sessions.values()].filter((hs) => hs.updatedAt >= now() - config.windowMs).sort((a, b) => b.updatedAt - a.updatedAt)
      const isLiveId = (id: string) => summaries.get(id)?.live === true
      usage.startSeeding(
        wins.filter((hs) => isLiveId(hs.id)).map((hs) => hs.id),
        wins.filter((hs) => !isLiveId(hs.id)).map((hs) => hs.id),
      )
    }
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      timers.add(t)
    }
    every(CLOCK_TICK_MS, clockTick)
    every(STATS_PUBLISH_MS, publishStatsIfChanged)
    every(1000, checkHealth)
  }

  async function stop(): Promise<void> {
    stopped = true
    usage.stop()
    pub.ready = false
    for (const u of unsubs.splice(0)) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    for (const t of timers) clearInterval(t)
    timers.clear()
    if (counterTimer) clearTimeout(counterTimer)
    await Promise.allSettled(sources.all.map((s) => s.stop()))
  }

  return {
    start,
    stop,
    meta,
    bootstrap,
    listSessions,
    sessionDetail,
    sessionTree,
    transcript,
    activity,
    part,
    fileChanges,
    fileDiff,
    artifacts,
    attention: () => attentionItems,
    stats,
    orca: orcaSnapshot,
    orchestration: orchestrationSummary,
    orchestrationRun,
    orchestrationTask,
    usage: (q) => usage.report(q),
    usageCalls: (q) => usage.calls(q),
  }
}

