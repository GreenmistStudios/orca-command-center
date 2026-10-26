/**
 * Token flow — store-side usage service: ledger ownership, seeding/on-demand loads, live ingest,
 * rollups (SessionSummary.usage, FleetStats.usage), cached reports and the paged call ledger.
 */
import { performance } from 'node:perf_hooks'
import type {
  EpochMs,
  FleetStats,
  SessionUsage,
  UsageCallsPage,
  UsageCoverage,
  UsageEstimate,
  UsageOutput,
  UsageReport,
  UsageSample,
  UsageScope,
} from '../../shared/contract.js'
import { addSample, emptyTotals, lowerBoundTs, mergeTotals, ratesOf } from '../../shared/usage-math.js'
import type { Clock, HarnessSession, HarnessSource, Logger, UsageCallsQuery, UsageQuery } from '../types.js'
import { UsageLedger, type LedgerStats } from './usage-ledger.js'
import { buildUsageReport, mergeSessionSamples, pageCalls, RATE_WINDOW_MS } from './usage-report.js'

const REPORT_TTL_MS = 2_000
const MAX_ON_DEMAND = 300
const FLUSH_MIN_MS = 500
const CHUNK_MS = 25
const CHUNK_IDS = 1
const MAX_CACHE = 64

export interface UsageContext {
  log: Logger
  now: Clock
  windowMs: number
  harnesses: HarnessSource[]
  sessionOf(id: string): HarnessSession | null
  findSession(id: string): HarnessSession | null
  rootOf(id: string): string
  loadTree(rootId: string): void
  /** root + known descendants */
  treeIds(rootId: string): string[]
  windowSessionIds(windowMs: number): string[]
  isLive(id: string): boolean
  isProtected(id: string): boolean
  titleOf(id: string): string
  /** Sessions linked to a run (coordinator + dispatch assignees); null = unknown run. */
  runSessionIds(runId: string): string[] | null
  outputOf(kind: 'workflow' | 'session', id: string): UsageOutput | null
  publishUsage(samples: UsageSample[], estimates: UsageEstimate[]): void
  /** Rebuild + publish summaries for these sessions. */
  refreshSessions(ids: string[]): void
  markStatsDirty(): void
}

interface CacheEntry {
  at: number
  ids: Set<string>
  fleet: boolean
  report: UsageReport
}

export class UsageService {
  readonly ledger: UsageLedger
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private pumping = false
  private seedStarted = false
  private seedDone = false
  private stopped = false
  private rootsDirty = false
  private readonly dirty = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  private lastFlush = 0
  private readonly cache = new Map<string, CacheEntry>()
  private readonly mismatchLogged = new Set<string>()
  /** Expired estimates (sessionId → startedAt:tokens) whose identical re-emits are ignored. */
  private readonly staleEstimates = new Map<string, string>()
  private fleetCache: { key: string; value: NonNullable<FleetStats['usage']> | undefined } | null = null

  constructor(private readonly ctx: UsageContext) {
    this.ledger = new UsageLedger({
      now: ctx.now,
      rootOf: (id) => (ctx.sessionOf(id) ? ctx.rootOf(id) : null),
    })
  }

  stats(): LedgerStats {
    return this.ledger.stats()
  }
  isSeeded(): boolean {
    return this.seedDone
  }

  /* ───────────────────────────── loading ───────────────────────────── */

  /** Marks the root index stale (parent links changed). */
  invalidateRoots(): void {
    this.rootsDirty = true
  }

  private refreshRoots(): void {
    if (!this.rootsDirty) return
    this.rootsDirty = false
    const changed = this.ledger.rerootAll()
    if (changed.length) {
      this.cache.clear()
      this.markDirty(changed)
    }
  }

  private checkExact(id: string): void {
    const hs = this.ctx.sessionOf(id)
    if (!hs || hs.harness !== 'opencode' || this.mismatchLogged.has(id)) return
    const t = this.ledger.totalsOf(id)
    const a = t.tokens
    const b = hs.tokens
    const same =
      a.input === b.input && a.output === b.output && a.reasoning === b.reasoning && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite &&
      Math.abs(t.cost - hs.cost) < 1e-6
    if (same) return
    this.mismatchLogged.add(id)
    this.ctx.log.warn('usage: ledger totals differ from session totals for %s (calls=%d); keeping harness totals', id, t.calls)
  }

  /** Loads every unloaded session's full history (≤ `cap`). Returns the number of sessions skipped by the cap. */
  loadSessions(ids: readonly string[], cap = Infinity): number {
    const todo = ids.filter((id) => !this.ledger.isLoaded(id) && this.ctx.sessionOf(id))
    const take = todo.slice(0, cap)
    const byHarness = new Map<HarnessSource, string[]>()
    for (const id of take) {
      const hs = this.ctx.sessionOf(id)!
      const src = this.ctx.harnesses.find((h) => h.harness === hs.harness)
      if (!src) {
        this.ledger.markLoaded([id])
        continue
      }
      const l = byHarness.get(src) ?? []
      l.push(id)
      byHarness.set(src, l)
    }
    const touched: string[] = []
    for (const [src, list] of byHarness) {
      let samples: UsageSample[] = []
      try {
        samples = src.getUsageSamples?.(list) ?? []
      } catch (e) {
        this.ctx.log.debug('usage: getUsageSamples failed: %s', String(e))
      }
      const accepted = this.ledger.ingest(samples)
      for (const s of accepted) touched.push(s.sessionId)
      this.ledger.markLoaded(list)
      touched.push(...list)
      for (const id of list) this.checkExact(id)
    }
    if (touched.length) {
      this.cache.clear()
      this.markDirty(touched)
    }
    return todo.length - take.length
  }

  enqueue(ids: Iterable<string>, front = false): void {
    const add: string[] = []
    for (const id of ids) if (!this.queued.has(id) && !this.ledger.isLoaded(id)) add.push(id)
    for (const id of add) this.queued.add(id)
    if (front) this.queue.unshift(...add)
    else this.queue.push(...add)
    if (add.length) this.pump()
  }

  /** Begin background seeding: live sessions first, then the rest of the window (newest first). */
  startSeeding(liveFirst: string[], rest: string[]): void {
    this.seedStarted = true
    this.enqueue(liveFirst)
    this.enqueue(rest)
    if (!this.pumping && this.queue.length === 0) this.finishSeed()
  }

  private finishSeed(): void {
    if (this.seedDone || !this.seedStarted) return
    this.seedDone = true
    this.fleetCache = null
    this.ctx.markStatsDirty()
  }

  private pump(): void {
    if (this.pumping || this.stopped) return
    this.pumping = true
    setImmediate(() => this.step())
  }

  private step(): void {
    if (this.stopped) return
    const t0 = performance.now()
    try {
      do {
        const batch = this.queue.splice(0, CHUNK_IDS)
        for (const id of batch) this.queued.delete(id)
        this.loadSessions(batch)
      } while (this.queue.length && performance.now() - t0 < CHUNK_MS)
    } catch (e) {
      this.ctx.log.warn('usage: seeding failed: %s', e instanceof Error ? e.message : String(e))
    }
    if (this.queue.length) setImmediate(() => this.step())
    else {
      this.pumping = false
      this.finishSeed()
    }
  }

  /* ───────────────────────────── live ingest ───────────────────────────── */

  ingestLive(samples: UsageSample[], estimates: UsageEstimate[]): void {
    for (const s of samples) if (!this.ctx.sessionOf(s.sessionId)) this.ctx.findSession(s.sessionId)
    this.refreshRoots()
    const accepted = this.ledger.ingest(samples)
    const est: UsageEstimate[] = []
    for (const s of accepted) this.staleEstimates.delete(s.sessionId)
    for (const e of estimates) {
      const sig = `${e.startedAt}:${e.estOutputTokens}`
      if (e.inFlight) {
        // Adapters re-emit unchanged estimates every poll: only changes are news.
        const cur = this.ledger.estimateOf(e.sessionId)
        if (cur && cur.startedAt === e.startedAt && cur.estOutputTokens === e.estOutputTokens) continue
        if (this.staleEstimates.get(e.sessionId) === sig) continue
      } else this.staleEstimates.delete(e.sessionId)
      if (!this.ctx.sessionOf(e.sessionId)) this.ctx.findSession(e.sessionId)
      const filled: UsageEstimate = { ...e, rootId: this.ctx.sessionOf(e.sessionId) ? this.ctx.rootOf(e.sessionId) : e.rootId }
      this.ledger.setEstimate(filled)
      est.push(filled)
    }
    if (accepted.length === 0 && est.length === 0) return
    const touched = [...accepted.map((s) => s.sessionId), ...est.map((e) => e.sessionId)]
    this.invalidate(touched)
    if (accepted.length) {
      this.fleetCache = null
      const unloaded = new Set<string>()
      for (const s of accepted) if (!this.ledger.isLoaded(s.sessionId)) unloaded.add(s.sessionId)
      if (unloaded.size) this.enqueue(unloaded, true)
    }
    this.ctx.publishUsage(accepted, est)
    this.markDirty(touched)
  }

  /** Periodic housekeeping (expire estimates, evict). */
  tick(): void {
    const ended = this.ledger.expireEstimates()
    if (ended.length) {
      for (const e of ended) this.staleEstimates.set(e.sessionId, `${e.startedAt}:${e.estOutputTokens}`)
      this.invalidate(ended.map((e) => e.sessionId))
      this.ctx.publishUsage([], ended)
      this.markDirty(ended.map((e) => e.sessionId))
    }
    const evicted = this.ledger.evict((id) => this.ctx.isProtected(id) || this.ctx.isLive(id))
    if (evicted.length) {
      this.cache.clear()
      this.fleetCache = null
      this.ctx.log.info('usage: evicted %d idle sessions from the ledger (%d samples left)', evicted.length, this.ledger.size)
    }
  }

  removeSessions(ids: string[]): void {
    this.ledger.removeSessions(ids)
    for (const id of ids) this.queued.delete(id)
    this.cache.clear()
    this.fleetCache = null
  }

  private invalidate(sessionIds: Iterable<string>): void {
    const set = new Set(sessionIds)
    for (const [k, e] of this.cache) {
      if (e.fleet) this.cache.delete(k)
      else for (const id of set) if (e.ids.has(id)) { this.cache.delete(k); break }
    }
  }

  /* ───────────────────── summary publication (≤ 2 Hz) ───────────────────── */

  markDirty(ids: Iterable<string>): void {
    for (const id of ids) {
      if (!this.ctx.sessionOf(id)) continue
      this.dirty.add(id)
      this.dirty.add(this.ctx.rootOf(id))
    }
    if (this.dirty.size === 0 || this.flushTimer || this.stopped) return
    const wait = Math.max(0, FLUSH_MIN_MS - (this.ctx.now() - this.lastFlush))
    this.flushTimer = setTimeout(() => this.flush(), wait)
    this.flushTimer.unref?.()
  }

  private flush(): void {
    this.flushTimer = null
    if (this.stopped) return
    this.lastFlush = this.ctx.now()
    const ids = [...this.dirty]
    this.dirty.clear()
    if (ids.length) this.ctx.refreshSessions(ids)
  }

  stop(): void {
    this.stopped = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  /* ───────────────────────────── rollups ───────────────────────────── */

  usageOf(id: string, live: boolean, isRoot: boolean): SessionUsage | undefined {
    if (!this.ledger.has(id)) return undefined
    const own = this.ledger.totalsOf(id)
    let tree: SessionUsage['tree'] = null
    if (isRoot) {
      const ids = this.ctx.treeIds(id)
      let acc = emptyTotals()
      for (const sid of ids) acc = mergeTotals(acc, this.ledger.totalsOf(sid))
      tree = {
        sessions: ids.length,
        calls: acc.calls,
        tokens: acc.tokens,
        inflow: acc.inflow,
        outflow: acc.outflow,
        cost: acc.cost,
        costedCalls: acc.costedCalls,
        aiu: acc.aiu,
      }
    }
    return {
      calls: own.calls,
      inflow: own.inflow,
      outflow: own.outflow,
      aiu: own.aiu,
      cacheHitRate: own.cacheHitRate,
      tree,
      rates: live ? ratesOf(this.ledger.samplesOf(id), this.ctx.now(), RATE_WINDOW_MS) : null,
      inFlight: this.ledger.estimateOf(id),
    }
  }

  fleetUsage(windowMs: number): FleetStats['usage'] {
    const ids = this.ctx.windowSessionIds(windowMs)
    if (!this.seedDone || ids.some((id) => !this.ledger.isLoaded(id))) return undefined
    const t = this.ctx.now()
    const key = `${windowMs}:${this.ledger.ledgerSeq}:${Math.floor(t / 1000)}:${ids.length}`
    if (this.fleetCache?.key === key) return this.fleetCache.value
    const since = t - windowMs
    const totals = emptyTotals()
    const lists: Array<readonly UsageSample[]> = []
    for (const id of ids) {
      const arr = this.ledger.samplesOf(id)
      for (let i = lowerBoundTs(arr, since); i < arr.length; i++) addSample(totals, arr[i]!)
      lists.push(arr)
    }
    // rates need only the last RATE_WINDOW_MS (clamped to the window): merge those slices
    const recent = mergeSessionSamples(lists, Math.max(since, t - RATE_WINDOW_MS + 1))
    const value = { totals, rates: ratesOf(recent, t, RATE_WINDOW_MS) }
    this.fleetCache = { key, value }
    return value
  }

  /* ───────────────────────────── reports ───────────────────────────── */

  private resolve(scope: UsageScope, windowMs: number): { scope: UsageScope; ids: string[]; notes: string[] } | null {
    switch (scope.kind) {
      case 'fleet':
        return { scope: { kind: 'fleet', id: null }, ids: this.ctx.windowSessionIds(windowMs), notes: [] }
      case 'session': {
        if (!scope.id || !this.ctx.findSession(scope.id)) return null
        return { scope: { kind: 'session', id: scope.id }, ids: [scope.id], notes: [] }
      }
      case 'workflow': {
        if (!scope.id || !this.ctx.findSession(scope.id)) return null
        const root = this.ctx.rootOf(scope.id)
        this.ctx.loadTree(root)
        return { scope: { kind: 'workflow', id: root }, ids: this.ctx.treeIds(root), notes: [] }
      }
      case 'run': {
        const linked = scope.id ? this.ctx.runSessionIds(scope.id) : null
        if (!linked) return null
        const ids = new Set<string>()
        for (const sid of linked) {
          if (!this.ctx.findSession(sid)) continue
          this.ctx.loadTree(sid)
          for (const x of this.ctx.treeIds(sid)) ids.add(x)
        }
        return {
          scope: { kind: 'run', id: scope.id },
          ids: [...ids],
          notes: ids.size === 0 ? ['No sessions are linked to this run.'] : [],
        }
      }
    }
  }

  private prepare(ids: string[]): { skipped: number } {
    this.refreshRoots()
    this.ledger.touch(ids)
    // newest sessions first so a capped load keeps the most relevant ones
    const skipped = this.loadSessions(ids, MAX_ON_DEMAND)
    return { skipped }
  }

  report(query: UsageQuery): UsageReport | null {
    const t = this.ctx.now()
    const windowMs = query.windowMs === undefined ? (query.scope.kind === 'fleet' ? this.ctx.windowMs : null) : query.windowMs
    const key = JSON.stringify([query.scope.kind, query.scope.id, windowMs, query.bucketMs ?? null, query.middle ?? null])
    const hit = this.cache.get(key)
    if (hit && t - hit.at < REPORT_TTL_MS) return hit.report
    const resolved = this.resolve(query.scope, windowMs ?? this.ctx.windowMs)
    if (!resolved) return null
    const { skipped } = this.prepare(resolved.ids)
    const since = windowMs === null ? undefined : t - windowMs
    const lists = resolved.ids.map((id) => this.ledger.samplesOf(id))
    const samples = mergeSessionSamples(lists, since)
    // only the 5-minute rate window is needed; slice per session instead of merging all-time samples
    const allSamples = mergeSessionSamples(lists, t - RATE_WINDOW_MS + 1)
    const idSet = new Set(resolved.ids)
    const estimates = this.ledger.estimates().filter((e) => idSet.has(e.sessionId))
    const withUsage = new Set(samples.map((s) => s.sessionId))
    const coverage: UsageCoverage = {
      sessions: resolved.ids.length,
      sessionsWithUsage: withUsage.size,
      notes: [...resolved.notes],
    }
    let copilotNoSummary = 0
    for (const id of resolved.ids) {
      if (this.ctx.sessionOf(id)?.harness !== 'copilot') continue
      if (!this.ledger.samplesOf(id).some((s) => s.source === 'copilot.session-summary')) copilotNoSummary++
    }
    if (copilotNoSummary > 0) {
      coverage.notes.push(
        `${copilotNoSummary} Copilot CLI session${copilotNoSummary === 1 ? '' : 's'} report token totals only when they end.`,
      )
    }
    if (skipped > 0) coverage.notes.push(`Usage for ${skipped} sessions was not loaded (limit ${MAX_ON_DEMAND} per request).`)
    let output: UsageOutput | null = null
    if (resolved.scope.kind === 'workflow' || resolved.scope.kind === 'session') {
      try {
        output = this.ctx.outputOf(resolved.scope.kind, resolved.scope.id!)
      } catch (e) {
        this.ctx.log.debug('usage: output failed: %s', String(e))
      }
    }
    const report = buildUsageReport({
      scope: resolved.scope,
      windowMs,
      bucketMs: query.bucketMs,
      middle: query.middle,
      now: t,
      ledgerSeq: this.ledger.ledgerSeq,
      samples,
      allSamples,
      estimates,
      output,
      coverage,
      sessionLabel: (id) => this.ctx.titleOf(id) || id.slice(0, 12),
    })
    this.cache.set(key, { at: t, ids: idSet, fleet: resolved.scope.kind === 'fleet', report })
    while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string)
    return report
  }

  calls(query: UsageCallsQuery): UsageCallsPage | null {
    const t = this.ctx.now()
    const resolved = this.resolve(query.scope, this.ctx.windowMs)
    if (!resolved) return null
    this.prepare(resolved.ids)
    const since = resolved.scope.kind === 'fleet' ? t - this.ctx.windowMs : undefined
    const all = mergeSessionSamples(resolved.ids.map((id) => this.ledger.samplesOf(id)), since)
    return pageCalls(all, query.before, query.limit)
  }
}
