/**
 * Token Flow — shared usage math. Pure, dependency-free; runs on server and client.
 * inflow = input + cacheRead + cacheWrite · outflow = output + reasoning.
 */
import type {
  EpochMs,
  FlowKind,
  ModelRef,
  SankeyLink,
  SankeyNode,
  TokenUsage,
  UsageBreakdownKind,
  UsageBreakdownRow,
  UsageBucket,
  UsageRates,
  UsageSample,
  UsageSankey,
  UsageTotals,
} from './contract.js'
import { LIMITS } from './contract.js'

export const ZERO_TOKENS: Readonly<TokenUsage> = Object.freeze({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

export function tokensOf(partial?: Partial<TokenUsage>): TokenUsage {
  return {
    input: num(partial?.input),
    output: num(partial?.output),
    reasoning: num(partial?.reasoning),
    cacheRead: num(partial?.cacheRead),
    cacheWrite: num(partial?.cacheWrite),
  }
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export function inflowOf(t: TokenUsage): number {
  return t.input + t.cacheRead + t.cacheWrite
}

export function outflowOf(t: TokenUsage): number {
  return t.output + t.reasoning
}

export function cacheHitRate(t: TokenUsage): number | null {
  const inflow = inflowOf(t)
  return inflow > 0 ? t.cacheRead / inflow : null
}

export function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    tokens: { ...ZERO_TOKENS },
    inflow: 0,
    outflow: 0,
    cost: 0,
    costedCalls: 0,
    aiu: 0,
    cacheHitRate: null,
    firstTs: null,
    lastTs: null,
  }
}

/** MUTATES and returns `totals`. */
export function addSample(totals: UsageTotals, s: UsageSample): UsageTotals {
  const t = tokensOf(s.tokens)
  totals.calls += 1
  totals.tokens.input += t.input
  totals.tokens.output += t.output
  totals.tokens.reasoning += t.reasoning
  totals.tokens.cacheRead += t.cacheRead
  totals.tokens.cacheWrite += t.cacheWrite
  totals.inflow = inflowOf(totals.tokens)
  totals.outflow = outflowOf(totals.tokens)
  if (isNum(s.cost)) {
    totals.cost += s.cost
    totals.costedCalls += 1
  }
  if (isNum(s.aiu)) totals.aiu += s.aiu
  totals.cacheHitRate = cacheHitRate(totals.tokens)
  totals.firstTs = totals.firstTs === null ? s.ts : Math.min(totals.firstTs, s.ts)
  totals.lastTs = totals.lastTs === null ? s.ts : Math.max(totals.lastTs, s.ts)
  return totals
}

export function totalsOf(samples: Iterable<UsageSample>): UsageTotals {
  const totals = emptyTotals()
  for (const s of samples) addSample(totals, s)
  return totals
}

export function mergeTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const tokens = addTokens(a.tokens, b.tokens)
  const firsts = [a.firstTs, b.firstTs].filter((x): x is number => x !== null)
  const lasts = [a.lastTs, b.lastTs].filter((x): x is number => x !== null)
  return {
    calls: a.calls + b.calls,
    tokens,
    inflow: inflowOf(tokens),
    outflow: outflowOf(tokens),
    cost: a.cost + b.cost,
    costedCalls: a.costedCalls + b.costedCalls,
    aiu: a.aiu + b.aiu,
    cacheHitRate: cacheHitRate(tokens),
    firstTs: firsts.length ? Math.min(...firsts) : null,
    lastTs: lasts.length ? Math.max(...lasts) : null,
  }
}

export function compareSamples(a: UsageSample, b: UsageSample): number {
  if (a.ts !== b.ts) return a.ts - b.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Binary insert keeping (ts, id) order; an existing element with the same id is replaced. Returns the index. */
export function insertSorted(arr: UsageSample[], s: UsageSample): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareSamples(arr[mid]!, s) < 0) lo = mid + 1
    else hi = mid
  }
  // Same id at the same position?
  if (lo < arr.length && arr[lo]!.id === s.id) {
    arr[lo] = s
    return lo
  }
  // Same id elsewhere (ts changed): remove it first.
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]!.id === s.id) {
      arr.splice(i, 1)
      if (i < lo) lo -= 1
      break
    }
  }
  arr.splice(lo, 0, s)
  return lo
}

/** First index with s.ts >= ts. */
export function lowerBoundTs(arr: readonly UsageSample[], ts: EpochMs): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]!.ts < ts) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Window (asOf − windowMs, asOf]; `sorted` ascending by ts. */
export function ratesOf(sorted: readonly UsageSample[], asOf: EpochMs, windowMs: number): UsageRates {
  const lo = lowerBoundTs(sorted, asOf - windowMs + 1)
  const hi = lowerBoundTs(sorted, asOf + 1)
  let inflow = 0
  let outflow = 0
  let cost = 0
  for (let i = lo; i < hi; i++) {
    const s = sorted[i]!
    inflow += inflowOf(s.tokens)
    outflow += outflowOf(s.tokens)
    if (isNum(s.cost)) cost += s.cost
  }
  const perMin = windowMs > 0 ? 60_000 / windowMs : 0
  const perHour = windowMs > 0 ? 3_600_000 / windowMs : 0
  return {
    windowMs,
    asOf,
    inflowPerMin: inflow * perMin,
    outflowPerMin: outflow * perMin,
    costPerHour: cost * perHour,
    callsPerMin: Math.max(0, hi - lo) * perMin,
  }
}

const S = 1000
const M = 60 * S
const H = 60 * M
export const NICE_BUCKETS_MS: readonly number[] = [
  S, 2 * S, 5 * S, 10 * S, 15 * S, 30 * S,
  M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M,
  H, 2 * H, 3 * H, 6 * H, 12 * H, 24 * H,
]

export function chooseBucketMs(spanMs: number, maxBuckets: number = LIMITS.usageSeriesMaxBuckets): number {
  const span = Math.max(0, spanMs)
  for (const step of NICE_BUCKETS_MS) {
    if (Math.ceil(span / step) <= maxBuckets) return step
  }
  return NICE_BUCKETS_MS[NICE_BUCKETS_MS.length - 1]!
}

export function alignDown(ts: EpochMs, bucketMs: number): EpochMs {
  return Math.floor(ts / bucketMs) * bucketMs
}

function emptyBucket(t: EpochMs): UsageBucket {
  return { t, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, aiu: 0, calls: 0 }
}

function fillBucket(b: UsageBucket, s: UsageSample): void {
  const t = tokensOf(s.tokens)
  b.input += t.input
  b.cacheRead += t.cacheRead
  b.cacheWrite += t.cacheWrite
  b.output += t.output
  b.reasoning += t.reasoning
  if (isNum(s.cost)) b.cost += s.cost
  if (isNum(s.aiu)) b.aiu += s.aiu
  b.calls += 1
}

/** Contiguous aligned buckets covering [alignDown(fromTs), alignDown(toTs)]; samples outside [fromTs, toTs] are ignored. */
export function bucketize(
  samples: Iterable<UsageSample>,
  fromTs: EpochMs,
  toTs: EpochMs,
  bucketMs: number,
): UsageBucket[] {
  const start = alignDown(fromTs, bucketMs)
  const end = alignDown(toTs, bucketMs)
  const buckets: UsageBucket[] = []
  for (let t = start; t <= end; t += bucketMs) buckets.push(emptyBucket(t))
  for (const s of samples) {
    if (s.ts < fromTs || s.ts > toTs) continue
    const b = buckets[Math.floor((alignDown(s.ts, bucketMs) - start) / bucketMs)]
    if (b) fillBucket(b, s)
  }
  return buckets
}

/** In place; appends empty buckets up to the sample's bucket; ignores samples older than the first bucket. */
export function addToSeries(series: { bucketMs: number; buckets: UsageBucket[] }, s: UsageSample): void {
  const { bucketMs, buckets } = series
  const first = buckets[0]
  if (!first) return
  const t = alignDown(s.ts, bucketMs)
  if (t < first.t) return
  let last = buckets[buckets.length - 1]!
  while (last.t < t) {
    last = emptyBucket(last.t + bucketMs)
    buckets.push(last)
  }
  const b = buckets[Math.round((t - first.t) / bucketMs)]
  if (b) fillBucket(b, s)
}

/** Drop buckets that end at or before `fromTs`. */
export function trimSeries(series: { bucketMs: number; buckets: UsageBucket[] }, fromTs: EpochMs): void {
  let n = 0
  while (n < series.buckets.length && series.buckets[n]!.t + series.bucketMs <= fromTs) n++
  if (n > 0) series.buckets.splice(0, n)
}

export function modelKey(m: ModelRef | null): string {
  if (!m || !m.modelId) return 'unknown'
  return m.providerId ? `${m.providerId}/${m.modelId}` : m.modelId
}

export function sampleKeyOf(s: UsageSample, kind: UsageBreakdownKind): string {
  switch (kind) {
    case 'session':
      return s.sessionId
    case 'agent':
      return s.agent ?? 'unknown'
    case 'model':
      return modelKey(s.model)
    case 'harness':
      return s.harness
  }
}

type Labels = {
  session?: (id: string) => string
  model?: (key: string) => string
  agent?: (name: string) => string
}

function labelFor(s: UsageSample, kind: UsageBreakdownKind, key: string, labels?: Labels): string {
  switch (kind) {
    case 'session':
      return labels?.session?.(key) ?? key
    case 'agent':
      return labels?.agent?.(key) ?? key
    case 'model':
      return labels?.model?.(key) ?? (s.model?.modelId || 'unknown')
    case 'harness':
      return key
  }
}

const rowTokens = (r: UsageBreakdownRow): number => r.totals.inflow + r.totals.outflow

function finalizeRows(rows: UsageBreakdownRow[], scopeTokens: number): void {
  let sum = scopeTokens
  if (!(sum > 0)) sum = rows.reduce((a, r) => a + rowTokens(r), 0)
  for (const r of rows) r.share = sum > 0 ? rowTokens(r) / sum : 0
  rows.sort((a, b) => rowTokens(b) - rowTokens(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

function applyToRow(rows: UsageBreakdownRow[], s: UsageSample, kind: UsageBreakdownKind, labels?: Labels): void {
  const key = sampleKeyOf(s, kind)
  let row = rows.find((r) => r.key === key)
  if (!row) {
    row = {
      key,
      label: labelFor(s, kind, key, labels),
      kind,
      sessionId: kind === 'session' ? key : null,
      harness: s.harness,
      totals: emptyTotals(),
      share: 0,
    }
    rows.push(row)
  } else if (row.harness !== null && row.harness !== s.harness) {
    row.harness = null
  }
  addSample(row.totals, s)
}

export function breakdown(
  samples: Iterable<UsageSample>,
  kind: UsageBreakdownKind,
  labels?: Labels,
): UsageBreakdownRow[] {
  const map = new Map<string, UsageBreakdownRow>()
  const rows: UsageBreakdownRow[] = []
  for (const s of samples) {
    const key = sampleKeyOf(s, kind)
    let row = map.get(key)
    if (!row) {
      row = {
        key,
        label: labelFor(s, kind, key, labels),
        kind,
        sessionId: kind === 'session' ? key : null,
        harness: s.harness,
        totals: emptyTotals(),
        share: 0,
      }
      map.set(key, row)
      rows.push(row)
    } else if (row.harness !== null && row.harness !== s.harness) {
      row.harness = null
    }
    addSample(row.totals, s)
  }
  finalizeRows(rows, 0)
  return rows
}

/**
 * In place. `scopeTokens` = the scope's total tokens (inflow + outflow) INCLUDING `s`;
 * pass 0 to use the sum of the rows. Rows are re-sorted and shares recomputed.
 */
export function addToBreakdown(
  rows: UsageBreakdownRow[],
  s: UsageSample,
  kind: UsageBreakdownKind,
  scopeTokens: number,
  labels?: Labels,
): void {
  applyToRow(rows, s, kind, labels)
  finalizeRows(rows, scopeTokens)
}

/* ───────────────────────────────── Sankey ───────────────────────────────── */

const SOURCES: ReadonlyArray<{ flow: FlowKind; label: string }> = [
  { flow: 'input', label: 'Fresh input' },
  { flow: 'cacheRead', label: 'Cache read' },
  { flow: 'cacheWrite', label: 'Cache write' },
]
const SINKS: ReadonlyArray<{ flow: FlowKind; label: string }> = [
  { flow: 'output', label: 'Output' },
  { flow: 'reasoning', label: 'Reasoning' },
]
const SINK_FLOWS = new Set<FlowKind>(['output', 'reasoning'])
const FLOW_ORDER: FlowKind[] = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning']

type SankeyOpts = { maxMiddle?: number; label?: (key: string) => string }

/** Keys merged into "Other", per sankey, so the "Other (N)" label stays exact incrementally. */
const otherKeys = new WeakMap<UsageSankey, Set<string>>()

function otherLabel(n: number): string {
  return `Other (${n})`
}

function sankeyKeyOf(s: UsageSample, middle: UsageSankey['middle']): string {
  return sampleKeyOf(s, middle)
}

interface Group {
  tokens: number
  flows: Record<FlowKind, number>
  cost: number
  costed: boolean
}

function newGroup(): Group {
  return { tokens: 0, flows: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, cost: 0, costed: false }
}

function addToGroup(g: Group, s: UsageSample): void {
  const t = tokensOf(s.tokens)
  for (const f of FLOW_ORDER) g.flows[f] += t[f]
  g.tokens += inflowOf(t) + outflowOf(t)
  if (isNum(s.cost)) {
    g.cost += s.cost
    g.costed = true
  }
}

function colOf(id: string): 0 | 1 | 2 {
  return id.startsWith('src:') ? 0 : id.startsWith('sink:') ? 2 : 1
}

export function buildSankey(
  samples: Iterable<UsageSample>,
  middle: 'agent' | 'session' | 'model',
  opts?: SankeyOpts,
): UsageSankey {
  const max = opts?.maxMiddle ?? LIMITS.usageSankeyMaxMiddle
  const groups = new Map<string, Group>()
  for (const s of samples) {
    const key = sankeyKeyOf(s, middle)
    let g = groups.get(key)
    if (!g) groups.set(key, (g = newGroup()))
    addToGroup(g, s)
  }
  const ranked = [...groups.entries()].sort(
    (a, b) => b[1].tokens - a[1].tokens || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )
  const kept = ranked.slice(0, max)
  const rest = ranked.slice(max)
  const mids: Array<{ id: string; label: string; sessionId: string | null; g: Group }> = kept.map(([key, g]) => ({
    id: `mid:${key}`,
    label: opts?.label?.(key) ?? key,
    sessionId: middle === 'session' ? key : null,
    g,
  }))
  const sankey: UsageSankey = { middle, nodes: [], links: [] }
  if (rest.length > 0) {
    const g = newGroup()
    for (const [, r] of rest) {
      for (const f of FLOW_ORDER) g.flows[f] += r.flows[f]
      g.tokens += r.tokens
      g.cost += r.cost
      g.costed = g.costed || r.costed
    }
    mids.push({ id: 'mid:other', label: otherLabel(rest.length), sessionId: null, g })
    otherKeys.set(sankey, new Set(rest.map(([k]) => k)))
  }

  const linkValues = new Map<string, SankeyLink>()
  for (const m of mids) {
    for (const f of FLOW_ORDER) {
      const v = m.g.flows[f]
      if (v <= 0) continue
      const [source, target] = SINK_FLOWS.has(f) ? [m.id, `sink:${f}`] : [`src:${f}`, m.id]
      const id = `${source}→${target}`
      linkValues.set(id, { id, source, target, flow: f, value: v })
    }
  }
  sankey.links = [...linkValues.values()]
  for (const src of SOURCES) {
    const value = sumLinks(sankey.links, (l) => l.source === `src:${src.flow}`)
    if (value > 0) sankey.nodes.push(sourceSinkNode(`src:${src.flow}`, src.label, 0, 'source', src.flow, value))
  }
  for (const m of mids) {
    sankey.nodes.push({
      id: m.id,
      label: m.label,
      column: 1,
      kind: 'middle',
      flow: null,
      sessionId: m.sessionId,
      value: Math.max(sumLinks(sankey.links, (l) => l.target === m.id), sumLinks(sankey.links, (l) => l.source === m.id)),
      cost: m.g.costed ? m.g.cost : null,
    })
  }
  for (const snk of SINKS) {
    const value = sumLinks(sankey.links, (l) => l.target === `sink:${snk.flow}`)
    if (value > 0) sankey.nodes.push(sourceSinkNode(`sink:${snk.flow}`, snk.label, 2, 'sink', snk.flow, value))
  }
  return sankey
}

function sumLinks(links: SankeyLink[], pred: (l: SankeyLink) => boolean): number {
  let n = 0
  for (const l of links) if (pred(l)) n += l.value
  return n
}

function sourceSinkNode(
  id: string,
  label: string,
  column: 0 | 2,
  kind: 'source' | 'sink',
  flow: FlowKind,
  value: number,
): SankeyNode {
  return { id, label, column, kind, flow, sessionId: null, value, cost: null }
}

/**
 * In place. Equivalent to a rebuild while top-N membership is stable. A key not already a middle
 * node joins the top N only while there is room and no "Other" exists; otherwise it goes to
 * "Other" (stable until the next full report).
 */
export function addToSankey(sankey: UsageSankey, s: UsageSample, opts?: SankeyOpts): void {
  const max = opts?.maxMiddle ?? LIMITS.usageSankeyMaxMiddle
  const key = sankeyKeyOf(s, sankey.middle)
  const nodeById = new Map(sankey.nodes.map((n) => [n.id, n]))
  const named = sankey.nodes.filter((n) => n.kind === 'middle' && n.id !== 'mid:other').length
  const hasOther = nodeById.has('mid:other')

  let midId = `mid:${key}`
  if (!nodeById.has(midId) && (hasOther || named >= max)) midId = 'mid:other'

  let mid = nodeById.get(midId)
  if (!mid) {
    mid = {
      id: midId,
      label: opts?.label?.(key) ?? key,
      column: 1,
      kind: 'middle',
      flow: null,
      sessionId: sankey.middle === 'session' ? key : null,
      value: 0,
      cost: null,
    }
    sankey.nodes.push(mid)
    nodeById.set(midId, mid)
    if (midId === 'mid:other') otherKeys.set(sankey, new Set())
  }
  if (midId === 'mid:other') {
    const set = otherKeys.get(sankey)
    if (set) {
      set.add(key)
      mid.label = otherLabel(set.size)
    } else {
      // Deserialized sankey: membership unknown; count each call's key once per call (upper bound).
      const m = /\((\d+)\)$/.exec(mid.label)
      mid.label = otherLabel((m ? Number(m[1]) : 0) + 1)
    }
  }
  if (isNum(s.cost)) mid.cost = (mid.cost ?? 0) + s.cost

  const t = tokensOf(s.tokens)
  const linkById = new Map(sankey.links.map((l) => [l.id, l]))
  for (const f of FLOW_ORDER) {
    const v = t[f]
    if (v <= 0) continue
    const isSink = SINK_FLOWS.has(f)
    const edgeEnd = isSink ? `sink:${f}` : `src:${f}`
    if (!nodeById.has(edgeEnd)) {
      const def = (isSink ? SINKS : SOURCES).find((d) => d.flow === f)!
      const n = sourceSinkNode(edgeEnd, def.label, isSink ? 2 : 0, isSink ? 'sink' : 'source', f, 0)
      sankey.nodes.push(n)
      nodeById.set(edgeEnd, n)
    }
    const [source, target] = isSink ? [midId, edgeEnd] : [edgeEnd, midId]
    const id = `${source}→${target}`
    let link = linkById.get(id)
    if (!link) {
      link = { id, source, target, flow: f, value: 0 }
      sankey.links.push(link)
      linkById.set(id, link)
    }
    link.value += v
    nodeById.get(edgeEnd)!.value += v
  }
  mid.value = Math.max(
    sumLinks(sankey.links, (l) => l.target === midId),
    sumLinks(sankey.links, (l) => l.source === midId),
  )
  // Keep column order (stable): sources, middle, sinks.
  sankey.nodes.sort((a, b) => colOf(a.id) - colOf(b.id))
}

/* ───────────────────────────── Throughput & stats ───────────────────────────── */

export function throughputTps(s: UsageSample): number | null {
  if (!isNum(s.durationMs)) return null
  const gen = s.durationMs - (isNum(s.ttftMs) ? s.ttftMs : 0)
  if (!(gen > 0)) return null
  return outflowOf(tokensOf(s.tokens)) / (gen / 1000)
}

export function percentile(values: readonly number[], p: number): number | null {
  const v = values.filter(isNum).sort((a, b) => a - b)
  if (v.length === 0) return null
  const q = Math.min(1, Math.max(0, p))
  const pos = q * (v.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo)
}

export function ttftStats(samples: Iterable<UsageSample>): { p50: number | null; p95: number | null; n: number } {
  const vals: number[] = []
  for (const s of samples) if (isNum(s.ttftMs)) vals.push(s.ttftMs)
  return { p50: percentile(vals, 0.5), p95: percentile(vals, 0.95), n: vals.length }
}

export function estimateTokensFromChars(chars: number): number {
  return isNum(chars) && chars > 0 ? Math.ceil(chars / 4) : 0
}
