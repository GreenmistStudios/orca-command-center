/** Token flow — bounded usage ledger (Plan §7). Pure data structure; no I/O. */
import type { EpochMs, UsageEstimate, UsageSample, UsageTotals } from '../../shared/contract.js'
import { addSample, emptyTotals, insertSorted } from '../../shared/usage-math.js'

export const MAX_LEDGER_SAMPLES = 200_000
export const ESTIMATE_TTL_MS = 2 * 60_000
export const EVICT_IDLE_MS = 10 * 60_000

export interface LedgerOptions {
  now: () => EpochMs
  /** Root of a session id, or null when unknown. */
  rootOf: (sessionId: string) => string | null
  maxSamples?: number
  evictIdleMs?: number
}

export interface LedgerStats {
  samples: number
  sessions: number
  loaded: number
  seq: number
  evictedSessions: number
  evictedSamples: number
}

function sameSample(a: UsageSample, b: UsageSample): boolean {
  if (a.ts !== b.ts || a.sessionId !== b.sessionId || a.startTs !== b.startTs || a.cost !== b.cost || a.aiu !== b.aiu) return false
  if (a.agent !== b.agent || a.finish !== b.finish || a.source !== b.source || a.harness !== b.harness) return false
  if (a.ttftMs !== b.ttftMs || a.durationMs !== b.durationMs) return false
  const x = a.tokens
  const y = b.tokens
  if (x.input !== y.input || x.output !== y.output || x.reasoning !== y.reasoning || x.cacheRead !== y.cacheRead || x.cacheWrite !== y.cacheWrite) return false
  return a.model?.modelId === b.model?.modelId && a.model?.providerId === b.model?.providerId
}

export class UsageLedger {
  private readonly byId = new Map<string, UsageSample>()
  private readonly bySession = new Map<string, UsageSample[]>()
  private readonly loadedSet = new Set<string>()
  private readonly queried = new Map<string, EpochMs>()
  private readonly estimateMap = new Map<string, UsageEstimate>()
  private readonly versions = new Map<string, number>()
  private readonly totalsCache = new Map<string, { v: number; totals: UsageTotals }>()
  private seq = 0
  private evictedSessions = 0
  private evictedSamples = 0
  private readonly max: number
  private readonly idleMs: number

  constructor(private readonly opts: LedgerOptions) {
    this.max = opts.maxSamples ?? MAX_LEDGER_SAMPLES
    this.idleMs = opts.evictIdleMs ?? EVICT_IDLE_MS
  }

  get ledgerSeq(): number {
    return this.seq
  }
  get size(): number {
    return this.byId.size
  }

  private bump(sessionId: string): void {
    this.versions.set(sessionId, (this.versions.get(sessionId) ?? 0) + 1)
  }

  /** Upsert by id. Returns the accepted (new or changed) samples with ledgerSeq/rootId filled. */
  ingest(samples: readonly UsageSample[]): UsageSample[] {
    const accepted: UsageSample[] = []
    for (const s of samples) {
      const prev = this.byId.get(s.id)
      if (prev && sameSample(prev, s)) continue
      if (prev && prev.sessionId !== s.sessionId) this.removeFromSession(prev)
      const stored: UsageSample = { ...s, ledgerSeq: ++this.seq, rootId: this.opts.rootOf(s.sessionId) ?? s.sessionId }
      let arr = this.bySession.get(s.sessionId)
      if (!arr) this.bySession.set(s.sessionId, (arr = []))
      insertSorted(arr, stored)
      this.byId.set(s.id, stored)
      this.bump(s.sessionId)
      accepted.push(stored)
    }
    return accepted
  }

  private removeFromSession(s: UsageSample): void {
    const arr = this.bySession.get(s.sessionId)
    if (!arr) return
    const i = arr.findIndex((x) => x.id === s.id)
    if (i >= 0) arr.splice(i, 1)
    if (arr.length === 0) this.bySession.delete(s.sessionId)
    this.bump(s.sessionId)
  }

  /** Re-resolve `rootId` for every session with samples; returns the sessions whose root changed. */
  rerootAll(): string[] {
    const changed: string[] = []
    for (const [sid, arr] of this.bySession) {
      const root = this.opts.rootOf(sid) ?? sid
      if (arr.length === 0 || arr[0]!.rootId === root) continue
      for (let i = 0; i < arr.length; i++) {
        const next = { ...arr[i]!, rootId: root }
        arr[i] = next
        this.byId.set(next.id, next)
      }
      this.bump(sid)
      changed.push(sid)
    }
    return changed
  }

  samplesOf(sessionId: string): readonly UsageSample[] {
    return this.bySession.get(sessionId) ?? []
  }
  has(sessionId: string): boolean {
    return this.bySession.has(sessionId) || this.loadedSet.has(sessionId)
  }
  get(id: string): UsageSample | undefined {
    return this.byId.get(id)
  }

  /** Cached per-session totals (own calls only). */
  totalsOf(sessionId: string): UsageTotals {
    const v = this.versions.get(sessionId) ?? 0
    const hit = this.totalsCache.get(sessionId)
    if (hit && hit.v === v) return hit.totals
    const totals = emptyTotals()
    for (const s of this.samplesOf(sessionId)) addSample(totals, s)
    this.totalsCache.set(sessionId, { v, totals })
    return totals
  }

  /* ───────────── loaded set ───────────── */

  isLoaded(sessionId: string): boolean {
    return this.loadedSet.has(sessionId)
  }
  markLoaded(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) this.loadedSet.add(id)
  }
  loadedCount(): number {
    return this.loadedSet.size
  }
  touch(sessionIds: Iterable<string>): void {
    const t = this.opts.now()
    for (const id of sessionIds) this.queried.set(id, t)
  }

  /** Forget everything about the given sessions (harness reset). */
  removeSessions(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) {
      for (const s of this.bySession.get(id) ?? []) this.byId.delete(s.id)
      this.bySession.delete(id)
      this.loadedSet.delete(id)
      this.queried.delete(id)
      this.estimateMap.delete(id)
      this.totalsCache.delete(id)
      this.versions.delete(id)
    }
  }

  /**
   * Evicts fully-loaded sessions not protected and idle ≥ evictIdleMs, least recently queried
   * first, while over the sample cap. Returns the evicted session ids.
   */
  evict(protect: (sessionId: string) => boolean): string[] {
    if (this.byId.size <= this.max) return []
    const t = this.opts.now()
    const candidates = [...this.loadedSet]
      .filter((id) => !protect(id) && t - (this.queried.get(id) ?? 0) >= this.idleMs && this.bySession.has(id))
      .sort((a, b) => (this.queried.get(a) ?? 0) - (this.queried.get(b) ?? 0))
    const out: string[] = []
    for (const id of candidates) {
      if (this.byId.size <= this.max) break
      this.evictedSamples += this.bySession.get(id)?.length ?? 0
      this.removeSessions([id])
      this.evictedSessions++
      out.push(id)
    }
    return out
  }

  /* ───────────── estimates ───────────── */

  setEstimate(e: UsageEstimate): void {
    if (!e.inFlight) this.estimateMap.delete(e.sessionId)
    else this.estimateMap.set(e.sessionId, e)
  }
  endEstimate(sessionId: string): UsageEstimate | null {
    const e = this.estimateMap.get(sessionId)
    if (!e) return null
    this.estimateMap.delete(sessionId)
    return { ...e, inFlight: false, updatedAt: this.opts.now() }
  }
  estimateOf(sessionId: string): UsageEstimate | null {
    const e = this.estimateMap.get(sessionId)
    if (!e) return null
    return this.opts.now() - e.updatedAt > ESTIMATE_TTL_MS ? null : e
  }
  estimates(): UsageEstimate[] {
    const t = this.opts.now()
    return [...this.estimateMap.values()].filter((e) => t - e.updatedAt <= ESTIMATE_TTL_MS)
  }
  /** Drops estimates without updates for 2 min; returns the end estimates to publish. */
  expireEstimates(): UsageEstimate[] {
    const t = this.opts.now()
    const ended: UsageEstimate[] = []
    for (const [id, e] of this.estimateMap) {
      if (t - e.updatedAt > ESTIMATE_TTL_MS) {
        this.estimateMap.delete(id)
        ended.push({ ...e, inFlight: false, updatedAt: t })
      }
    }
    return ended
  }

  sessionIds(): string[] {
    return [...this.bySession.keys()]
  }

  stats(): LedgerStats {
    return {
      samples: this.byId.size,
      sessions: this.bySession.size,
      loaded: this.loadedSet.size,
      seq: this.seq,
      evictedSessions: this.evictedSessions,
      evictedSamples: this.evictedSamples,
    }
  }
}
