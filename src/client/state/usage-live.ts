/**
 * Live usage: merges a fetched `UsageReport` baseline with samples streamed after it, using the
 * SAME math the server uses (src/shared/usage-math.ts), so a live view and a fresh report agree.
 * Protocol (Plan §7): apply only samples with `ledgerSeq > report.ledgerSeq`, exactly once; recompute
 * at ≤ 4 Hz; refetch every 60 s / on scope change / after > 1000 deltas.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { LIMITS, type Harness, type UsageEstimate, type UsageReport, type UsageSample, type UsageScope } from '../../shared/contract'
import {
  addSample, addToBreakdown, addToSankey, addToSeries, alignDown, bucketize, insertSorted, lowerBoundTs, outflowOf, ratesOf,
  sampleKeyOf, tokensOf, trimSeries,
} from '../../shared/usage-math'
import { usageReportKey, useOcc, type OccState } from './store'
import { estimateInScope, sampleInScope, type UsageScopeCtx } from './usage-scope'
import { usageBus } from './usage-bus'

export { estimateInScope, sampleInScope, type UsageScopeCtx } from './usage-scope'

export const LIVE_RECOMPUTE_MS = 250
export const LIVE_RECONCILE_MS = 60_000
export const LIVE_MAX_DELTAS = 1000

export interface LiveOpts { windowMs?: number | null; middle?: 'agent' | 'session' | 'model' | 'auto'; bucketMs?: number }

const billableKey = (s: UsageSample): string =>
  JSON.stringify([tokensOf(s.tokens), s.cost, s.aiu, s.ts, s.agent, s.model, s.harness, s.sessionId])

/** Subtract one call's billable values from `totals` (calls count is NOT touched: used for corrections). */
function subTotals(t: UsageReport['totals'], s: UsageSample): void {
  const k = tokensOf(s.tokens)
  t.tokens.input -= k.input; t.tokens.output -= k.output; t.tokens.reasoning -= k.reasoning
  t.tokens.cacheRead -= k.cacheRead; t.tokens.cacheWrite -= k.cacheWrite
  t.inflow = t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite
  t.outflow = t.tokens.output + t.tokens.reasoning
  // addSample counted the new call (+1 calls, +1 costed when costed); the old version is that same call.
  t.calls -= 1
  if (s.cost != null) { t.cost -= s.cost; t.costedCalls -= 1 }
  if (s.aiu != null) t.aiu -= s.aiu
  t.cacheHitRate = t.inflow > 0 ? t.tokens.cacheRead / t.inflow : null
}

/** Signed removal of a call's token flows from the sankey (after the new version was added). */
function subSankey(sk: UsageReport['sankey'], s: UsageSample): void {
  const key = sampleKeyOf(s, sk.middle)
  const midId = sk.nodes.some((n) => n.id === `mid:${key}`) ? `mid:${key}` : 'mid:other'
  const mid = sk.nodes.find((n) => n.id === midId)
  if (!mid) return
  if (s.cost != null && mid.cost != null) mid.cost -= s.cost
  const t = tokensOf(s.tokens)
  for (const f of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const) {
    const v = t[f]
    if (v <= 0) continue
    const sink = f === 'output' || f === 'reasoning'
    const end = sink ? `sink:${f}` : `src:${f}`
    const id = sink ? `${midId}→${end}` : `${end}→${midId}`
    const link = sk.links.find((l) => l.id === id)
    if (link) link.value -= v
    const en = sk.nodes.find((n) => n.id === end)
    if (en) en.value -= v
  }
  sk.links = sk.links.filter((l) => l.value > 0)
  mid.value = Math.max(
    sk.links.filter((l) => l.target === midId).reduce((a, l) => a + l.value, 0),
    sk.links.filter((l) => l.source === midId).reduce((a, l) => a + l.value, 0),
  )
}

/** Structural-clone report + exactly-once application of newer in-scope samples. Framework-free (unit-testable). */
export class LiveUsageModel {
  private readonly r: UsageReport
  /** Applied (or baseline-superseded) samples by id: the version currently counted in the totals. */
  private readonly applied = new Map<string, UsageSample>()
  /** Baseline `recentCalls` by id (versions already counted in the baseline totals). */
  private readonly baseById = new Map<string, UsageSample>()
  /** Baseline recent calls + applied samples, ascending (for sliding-window rates). */
  private readonly sorted: UsageSample[]
  private readonly baseWatermark: number
  private inFlight: UsageEstimate[] = []
  private dirty = true
  /** Number of samples applied on top of the baseline. */
  deltas = 0
  lastSampleAt: number | null = null

  constructor(base: UsageReport, readonly scope: UsageScope, private ctx: UsageScopeCtx) {
    this.r = structuredClone(base)
    this.baseWatermark = base.ledgerSeq
    for (const c of base.recentCalls) this.baseById.set(c.id, c)
    this.sorted = [...base.recentCalls].sort((a, b) => a.ts - b.ts)
    this.inFlight = base.inFlight
  }

  get watermark(): number { return this.baseWatermark }

  setCtx(ctx: UsageScopeCtx): void { this.ctx = ctx }

  /** Apply in-scope samples newer than the baseline that were not applied yet. Returns how many were applied. */
  ingest(samples: Iterable<UsageSample>, asOf: number): number {
    const r = this.r
    const from = r.windowMs != null ? asOf - r.windowMs : null
    let n = 0
    for (const s of samples) {
      const prior = this.applied.get(s.id) ?? this.baseById.get(s.id)
      if (prior) {
        // Already counted (live or in the baseline): only a strictly newer re-emit with changed billable values matters.
        if (s.ledgerSeq <= prior.ledgerSeq || s.ledgerSeq <= this.baseWatermark) continue
        if (!sampleInScope(s, this.scope, this.ctx)) continue
        this.applied.set(s.id, s)
        if (billableKey(prior) === billableKey(s)) continue
        this.correct(prior, s)
        n++
        continue
      }
      if (s.ledgerSeq <= this.baseWatermark) continue
      if (!sampleInScope(s, this.scope, this.ctx)) continue
      this.applied.set(s.id, s)
      if (from != null && s.ts < from) continue
      this.apply(s)
      n++
    }
    if (n > 0) this.dirty = true
    return n
  }

  private apply(s: UsageSample): void {
    const r = this.r
    addSample(r.totals, s)
    if (r.series.buckets.length === 0) r.series.buckets = bucketize([], s.ts, s.ts, r.series.bucketMs)
    addToSeries(r.series, s)
    const tokens = r.totals.inflow + r.totals.outflow
    const sessionLabel = { session: (id: string) => this.ctx.sessions[id]?.title ?? id }
    addToBreakdown(r.byModel, s, 'model', tokens)
    addToBreakdown(r.byAgent, s, 'agent', tokens)
    addToBreakdown(r.bySession, s, 'session', tokens, sessionLabel)
    addToBreakdown(r.byHarness, s, 'harness', tokens)
    addToSankey(r.sankey, s, r.sankey.middle === 'session' ? { label: sessionLabel.session } : undefined)
    r.recentCalls.push(s)
    if (r.recentCalls.length > 1) r.recentCalls.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    if (r.recentCalls.length > LIMITS.usageReportCalls) r.recentCalls.splice(0, r.recentCalls.length - LIMITS.usageReportCalls)
    insertSorted(this.sorted, s)
    this.deltas++
    this.lastSampleAt = Math.max(this.lastSampleAt ?? 0, s.ts)
    // The call finished: its estimate no longer applies.
    this.inFlight = this.inFlight.filter((e) => e.sessionId !== s.sessionId)
  }

  /** Replace the counted version `old` of a call by `nw` (calls unchanged): apply only the difference. */
  private correct(old: UsageSample, nw: UsageSample): void {
    const r = this.r
    // Add the new version, then subtract the old one (signed), so a changed key/bucket works too.
    addSample(r.totals, nw)
    subTotals(r.totals, old)
    r.totals.firstTs = old.ts === r.totals.firstTs ? Math.min(old.ts, nw.ts) : r.totals.firstTs
    if (r.series.buckets.length > 0) {
      addToSeries(r.series, nw)
      const first = r.series.buckets[0]!
      const b = r.series.buckets[Math.round((alignDown(old.ts, r.series.bucketMs) - first.t) / r.series.bucketMs)]
      if (b && alignDown(old.ts, r.series.bucketMs) >= first.t) {
        const t = tokensOf(old.tokens)
        b.input -= t.input; b.cacheRead -= t.cacheRead; b.cacheWrite -= t.cacheWrite; b.output -= t.output; b.reasoning -= t.reasoning
        if (old.cost != null) b.cost -= old.cost
        if (old.aiu != null) b.aiu -= old.aiu
        b.calls -= 1
      }
    }
    const tokens = r.totals.inflow + r.totals.outflow
    const sessionLabel = { session: (id: string) => this.ctx.sessions[id]?.title ?? id }
    const rowsOf: Array<[typeof r.byModel, 'model' | 'agent' | 'session' | 'harness', typeof sessionLabel | undefined]> = [
      [r.byModel, 'model', undefined], [r.byAgent, 'agent', undefined], [r.bySession, 'session', sessionLabel], [r.byHarness, 'harness', undefined],
    ]
    for (const [rows, kind, labels] of rowsOf) {
      addToBreakdown(rows, nw, kind, 0, labels)
      const row = rows.find((x) => x.key === sampleKeyOf(old, kind))
      if (row) subTotals(row.totals, old)
      const sum = tokens > 0 ? tokens : rows.reduce((a, x) => a + x.totals.inflow + x.totals.outflow, 0)
      for (const x of rows) x.share = sum > 0 ? (x.totals.inflow + x.totals.outflow) / sum : 0
      rows.sort((a, b) => (b.totals.inflow + b.totals.outflow) - (a.totals.inflow + a.totals.outflow) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    }
    addToSankey(r.sankey, nw, r.sankey.middle === 'session' ? { label: sessionLabel.session } : undefined)
    subSankey(r.sankey, old)
    const ri = r.recentCalls.findIndex((c) => c.id === old.id)
    if (ri >= 0) r.recentCalls[ri] = nw
    const si = this.sorted.findIndex((c) => c.id === old.id)
    if (si >= 0) this.sorted.splice(si, 1)
    insertSorted(this.sorted, nw)
    this.lastSampleAt = Math.max(this.lastSampleAt ?? 0, nw.ts)
  }

  setInFlight(estimates: UsageEstimate[]): void {
    const same = estimates.length === this.inFlight.length && estimates.every((e, i) => e === this.inFlight[i])
    if (same) return
    this.inFlight = estimates
    this.dirty = true
  }

  get isDirty(): boolean { return this.dirty }

  /** A fresh, immutable report (new identity) at `asOf`: window slid, rates recomputed, in-flight attached. */
  snapshot(asOf: number): UsageReport {
    const r = this.r
    if (r.windowMs != null) trimSeries(r.series, asOf - r.windowMs)
    const W = r.rates.windowMs
    const lo = lowerBoundTs(this.sorted, asOf - W + 1)
    // recentCalls is capped; only trust it for the rate window when it provably covers it.
    const covers = r.recentCalls.length < LIMITS.usageReportCalls || (this.sorted[0] !== undefined && this.sorted[0].ts <= asOf - W) || lo > 0
    r.rates = covers && this.sorted.length > 0 ? ratesOf(this.sorted, asOf, W) : { ...r.rates, asOf: Math.max(r.rates.asOf, asOf) }
    r.inFlight = this.inFlight
    this.dirty = false
    return structuredClone(r)
  }
}

/* ───────────────────────────── hooks ───────────────────────────── */

export interface LiveUsage {
  report: UsageReport | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  refresh(): void
  lastSampleAt: number | null
}

const ctxOf = (s: OccState): UsageScopeCtx => ({ sessions: s.sessions, orchestration: s.orchestration })

function scopeEstimates(s: OccState, scope: UsageScope): UsageEstimate[] {
  const ctx = ctxOf(s)
  return Object.values(s.usage.estimates).filter((e) => estimateInScope(e, scope, ctx))
}

export function useLiveUsage(scope: UsageScope | null, opts: LiveOpts = {}): LiveUsage {
  const kind = scope?.kind ?? null
  const id = scope?.id ?? null
  const windowMs = opts.windowMs ?? null
  const middle = opts.middle
  const bucketMs = opts.bucketMs
  const normMiddle = middle && middle !== 'auto' ? middle : undefined
  const key = kind ? usageReportKey({ kind, id }, windowMs, normMiddle) : ''
  const loadable = useOcc((s) => (key ? s.usageReports[key] : undefined))
  const baseline = loadable?.data ?? null

  const [view, setView] = useState<{ report: UsageReport | null; lastSampleAt: number | null }>({ report: null, lastSampleAt: null })
  const modelRef = useRef<LiveUsageModel | null>(null)
  const lastRunRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => {
    if (!kind) return
    void useOcc.getState().fetchUsageReport({ kind, id }, { windowMs, bucketMs, middle, force: true })
  }, [kind, id, windowMs, bucketMs, middle])

  // Baseline fetch on scope/option change + 60 s reconcile.
  useEffect(() => {
    if (!kind) return
    refresh()
    const t = setInterval(refresh, LIVE_RECONCILE_MS)
    return () => clearInterval(t)
  }, [kind, refresh])

  // Rebuild the model when the baseline changes; drive live recomputes at ≤ 4 Hz.
  useEffect(() => {
    modelRef.current = null
    if (!kind || !baseline) { setView({ report: null, lastSampleAt: null }); return }
    const scopeObj: UsageScope = { kind, id }
    const model = new LiveUsageModel(baseline, scopeObj, ctxOf(useOcc.getState()))
    modelRef.current = model

    const run = () => {
      timerRef.current = null
      lastRunRef.current = Date.now()
      const st = useOcc.getState()
      model.setCtx(ctxOf(st))
      const asOf = Date.now()
      const ring = st.usage.samples
      const fresh: UsageSample[] = []
      for (const sid of ring.order) {
        const x = ring.byId[sid]
        if (x && x.ledgerSeq > model.watermark) fresh.push(x)
      }
      model.ingest(fresh, asOf)
      model.setInFlight(scopeEstimates(st, scopeObj))
      if (model.deltas > LIVE_MAX_DELTAS) { refresh(); return }
      setView({ report: model.snapshot(asOf), lastSampleAt: model.lastSampleAt })
    }
    const schedule = () => {
      if (timerRef.current) return
      const wait = Math.max(0, LIVE_RECOMPUTE_MS - (Date.now() - lastRunRef.current))
      timerRef.current = setTimeout(run, wait)
    }
    run()
    const unsubVersion = useOcc.subscribe((s) => s.usage.samples.version, schedule)
    const unsubEst = useOcc.subscribe((s) => s.usage.estimates, schedule)
    const unsubSessions = useOcc.subscribe((s) => s.sessions, () => model.setCtx(ctxOf(useOcc.getState())))
    return () => {
      unsubVersion(); unsubEst(); unsubSessions()
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline, kind, id])

  return {
    report: kind ? view.report : null,
    status: kind ? (loadable?.status ?? 'idle') : 'idle',
    error: loadable?.error ?? null,
    refresh,
    lastSampleAt: kind ? view.lastSampleAt : null,
  }
}

/** Subscribe to live calls/estimates inside `scope` for animations — never touches React state. */
export function useUsageBurst(scope: UsageScope | null, cb: (item: UsageSample | UsageEstimate) => void): void {
  const cbRef = useRef(cb)
  cbRef.current = cb
  const kind = scope?.kind ?? null
  const id = scope?.id ?? null
  useEffect(() => {
    if (!kind) return
    const scopeObj: UsageScope = { kind, id }
    return usageBus.subscribe((ev) => {
      const ctx = ctxOf(useOcc.getState())
      for (const s of ev.samples) if (sampleInScope(s, scopeObj, ctx)) cbRef.current(s)
      for (const e of ev.estimates) if (estimateInScope(e, scopeObj, ctx)) cbRef.current(e)
    })
  }, [kind, id])
}


/* ───────────────────────── in-flight → metered morph ───────────────────────── */

export interface InFlightMeterEntry { sessionId: string; rootId: string | null; harness: Harness; estTokens: number; startedAt: number; metered: number | null; done: boolean }
/** How long a completed entry (done:true, metered set) stays before it is dropped. */
export const METER_HOLD_MS = 1800
/** An ended estimate waits this long for its metering sample (and vice versa) before being dropped. */
export const METER_MATCH_MS = 5000
const METER_RENDER_MS = 250

interface MeterTrack { est: UsageEstimate; ended: boolean; endedAt: number; metered: number | null; holdUntil: number }

/** In-scope live estimates (`done:false`) plus just-completed calls (`done:true`, `metered` = outflow) held for METER_HOLD_MS. */
export function useInFlightMeters(scope: UsageScope | null): InFlightMeterEntry[] {
  const kind = scope?.kind ?? null
  const id = scope?.id ?? null
  const [entries, setEntries] = useState<InFlightMeterEntry[]>([])

  useEffect(() => {
    if (!kind) { setEntries([]); return }
    const scopeObj: UsageScope = { kind, id }
    const tracks = new Map<string, MeterTrack>()
    /** Recent in-scope samples by session (for sample-before-estimate-end ordering). */
    const recent = new Map<string, UsageSample>()
    let sig = ''
    let current: InFlightMeterEntry[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastRun = 0

    const recompute = () => {
      timer = null
      lastRun = Date.now()
      const now = lastRun
      const st = useOcc.getState()
      const ctx = ctxOf(st)
      for (const [sid, tr] of tracks) {
        if (!tr.ended) {
          const live = st.usage.estimates[sid]
          if (live && live.inFlight) { tr.est = live; continue }
          tr.ended = true; tr.endedAt = now
          const smp = recent.get(sid)
          if (smp && smp.ts >= tr.est.startedAt) { tr.metered = outflowOf(smp.tokens); tr.holdUntil = now + METER_HOLD_MS }
        }
        if (tr.metered != null) { if (now >= tr.holdUntil) tracks.delete(sid) }
        else if (now - tr.endedAt >= METER_MATCH_MS) tracks.delete(sid)
      }
      for (const [sid, e] of Object.entries(st.usage.estimates)) {
        if (!tracks.has(sid) && e.inFlight && estimateInScope(e, scopeObj, ctx)) tracks.set(sid, { est: e, ended: false, endedAt: 0, metered: null, holdUntil: 0 })
      }
      for (const [sid, smp] of recent) if (now - smp.ts > METER_MATCH_MS * 2 && !tracks.has(sid)) recent.delete(sid)
      const next: InFlightMeterEntry[] = []
      for (const tr of tracks.values()) {
        next.push({
          sessionId: tr.est.sessionId, rootId: tr.est.rootId, harness: tr.est.harness, estTokens: tr.est.estOutputTokens,
          startedAt: tr.est.startedAt, metered: tr.metered, done: tr.metered != null,
        })
      }
      const nsig = JSON.stringify(next)
      if (nsig !== sig) { sig = nsig; current = next; setEntries(next) }
      // Keep ticking while anything is pending expiry.
      if (tracks.size > 0 && [...tracks.values()].some((t) => t.ended)) schedule(METER_RENDER_MS)
    }
    const schedule = (minWait = 0) => {
      if (timer) return
      timer = setTimeout(recompute, Math.max(minWait, METER_RENDER_MS - (Date.now() - lastRun)))
    }

    const onSamples = (samples: UsageSample[]) => {
      const ctx = ctxOf(useOcc.getState())
      const now = Date.now()
      for (const smp of samples) {
        if (!sampleInScope(smp, scopeObj, ctx)) continue
        recent.set(smp.sessionId, smp)
        const tr = tracks.get(smp.sessionId)
        if (tr && tr.ended && tr.metered == null && smp.ts >= tr.est.startedAt && now - tr.endedAt <= METER_MATCH_MS) {
          tr.metered = outflowOf(smp.tokens); tr.holdUntil = now + METER_HOLD_MS
        }
      }
    }
    const unsubBus = usageBus.subscribe((ev) => { onSamples(ev.samples); schedule() })
    const unsubEst = useOcc.subscribe((s) => s.usage.estimates, () => schedule())
    recompute()
    return () => {
      unsubBus(); unsubEst()
      if (timer) clearTimeout(timer)
    }
  }, [kind, id])

  return entries
}
