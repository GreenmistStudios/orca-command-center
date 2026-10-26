/** Token flow — report builder (pure; all arithmetic through src/shared/usage-math.ts). */
import type {
  EpochMs,
  UsageCallsPage,
  UsageCoverage,
  UsageEstimate,
  UsageOutput,
  UsageReport,
  UsageSample,
  UsageScope,
} from '../../shared/contract.js'
import { LIMITS } from '../../shared/contract.js'
import {
  breakdown,
  bucketize,
  buildSankey,
  chooseBucketMs,
  compareSamples,
  lowerBoundTs,
  ratesOf,
  totalsOf,
} from '../../shared/usage-math.js'

export const RATE_WINDOW_MS = 5 * 60_000
const MAX_SERIES_BUCKETS_HARD = 5000

export interface ReportInput {
  scope: UsageScope
  /** Window applied to calls (null = all time). */
  windowMs: number | null
  bucketMs?: number
  middle?: 'agent' | 'session' | 'model'
  now: EpochMs
  ledgerSeq: number
  /** Scope samples, ascending by (ts, id), already window-filtered. */
  samples: UsageSample[]
  /** All scope samples, ascending, regardless of window (rates). */
  allSamples: UsageSample[]
  estimates: UsageEstimate[]
  output: UsageOutput | null
  coverage: UsageCoverage
  sessionLabel: (id: string) => string
}

export function defaultMiddle(kind: UsageScope['kind']): 'agent' | 'session' | 'model' {
  return kind === 'fleet' ? 'agent' : kind === 'session' ? 'model' : 'session'
}

/** Merge per-session ascending arrays into one ascending array, keeping ts >= sinceTs. */
export function mergeSessionSamples(lists: ReadonlyArray<readonly UsageSample[]>, sinceTs?: EpochMs): UsageSample[] {
  const out: UsageSample[] = []
  for (const l of lists) {
    const from = sinceTs === undefined ? 0 : lowerBoundTs(l, sinceTs)
    for (let i = from; i < l.length; i++) out.push(l[i]!)
  }
  out.sort(compareSamples)
  return out
}

export function buildUsageReport(inp: ReportInput): UsageReport {
  const { samples, now } = inp
  const totals = totalsOf(samples)
  const first = samples[0]?.ts ?? null
  const last = samples.length ? samples[samples.length - 1]!.ts : null
  const from = inp.windowMs !== null ? now - inp.windowMs : (first ?? now)
  const to = inp.windowMs !== null ? now : inp.estimates.length > 0 ? Math.max(now, last ?? now) : (last ?? now)
  let bucketMs = inp.bucketMs ?? chooseBucketMs(to - from)
  if (inp.bucketMs !== undefined && (to - from) / bucketMs > MAX_SERIES_BUCKETS_HARD) {
    bucketMs = chooseBucketMs(to - from, MAX_SERIES_BUCKETS_HARD)
  }
  const buckets = bucketize(samples, from, Math.max(to, from), bucketMs)
  const middle = inp.middle ?? defaultMiddle(inp.scope.kind)
  const labels = { session: inp.sessionLabel }
  const modelLabel = (key: string): string => {
    const i = key.indexOf('/')
    return i >= 0 ? key.slice(i + 1) : key
  }
  return {
    scope: inp.scope,
    windowMs: inp.windowMs,
    generatedAt: now,
    ledgerSeq: inp.ledgerSeq,
    totals,
    rates: ratesOf(inp.allSamples, now, RATE_WINDOW_MS),
    series: { bucketMs, buckets },
    byModel: breakdown(samples, 'model', { ...labels, model: modelLabel }),
    byAgent: breakdown(samples, 'agent', labels),
    bySession: breakdown(samples, 'session', labels),
    byHarness: breakdown(samples, 'harness', labels),
    sankey: buildSankey(samples, middle, {
      label: (key) => (middle === 'session' ? inp.sessionLabel(key) : middle === 'model' ? modelLabel(key) : key),
    }),
    recentCalls: samples.slice(-LIMITS.usageReportCalls),
    inFlight: inp.estimates,
    output: inp.output,
    coverage: inp.coverage,
  }
}

export const cursorOfSample = (s: UsageSample): string => `${s.ts}:${s.id}`

function parseCursor(raw: string | undefined): { ts: number; id: string } | null {
  if (!raw) return null
  const i = raw.indexOf(':')
  if (i <= 0) return null
  const ts = Number(raw.slice(0, i))
  return Number.isFinite(ts) ? { ts, id: raw.slice(i + 1) } : null
}

/** Newest-first paging over an ascending sample list; each page is ordered oldest → newest. */
export function pageCalls(all: readonly UsageSample[], before: string | undefined, limit: number): UsageCallsPage {
  const cur = parseCursor(before)
  let end = all.length
  if (cur) {
    let lo = 0
    let hi = all.length
    const probe = { ts: cur.ts, id: cur.id } as UsageSample
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareSamples(all[mid]!, probe) < 0) lo = mid + 1
      else hi = mid
    }
    end = lo
  }
  const start = Math.max(0, end - limit)
  const calls = all.slice(start, end)
  const hasMore = start > 0
  return { calls, before: hasMore && calls.length ? cursorOfSample(calls[0]!) : null, hasMore }
}
