/**
 * Live usage: merges a fetched `UsageReport` baseline with samples streamed after it, using the
 * SAME math the server uses (src/shared/usage-math.ts), so a live view and a fresh report agree.
 * Protocol (Plan §7): apply only samples with `ledgerSeq > report.ledgerSeq`, exactly once; recompute
 * at ≤ 4 Hz; refetch every 60 s / on scope change / after > 1000 deltas.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { LIMITS, type UsageEstimate, type UsageReport, type UsageSample, type UsageScope } from '../../shared/contract'
import {
  addSample, addToBreakdown, addToSankey, addToSeries, bucketize, insertSorted, lowerBoundTs, ratesOf, trimSeries,
} from '../../shared/usage-math'
import { usageReportKey, useOcc, type OccState } from './store'
import { estimateInScope, sampleInScope, type UsageScopeCtx } from './usage-scope'
import { usageBus } from './usage-bus'

export { estimateInScope, sampleInScope, type UsageScopeCtx } from './usage-scope'

export const LIVE_RECOMPUTE_MS = 250
export const LIVE_RECONCILE_MS = 60_000
export const LIVE_MAX_DELTAS = 1000

export interface LiveOpts { windowMs?: number | null; middle?: 'agent' | 'session' | 'model' | 'auto'; bucketMs?: number }

/** Structural-clone report + exactly-once application of newer in-scope samples. Framework-free (unit-testable). */
export class LiveUsageModel {
  private readonly r: UsageReport
  private readonly applied = new Set<string>()
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
      if (s.ledgerSeq <= this.baseWatermark || this.applied.has(s.id)) continue
      if (!sampleInScope(s, this.scope, this.ctx)) continue
      this.applied.add(s.id)
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
