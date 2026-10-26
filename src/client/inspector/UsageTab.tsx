import { motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary, UsageEstimate, UsageSample } from '../../shared/contract'
import { inflowOf, outflowOf, percentile, throughputTps } from '../../shared/usage-math'
import { cn } from '../lib/cn'
import { formatClock, formatCost, formatDuration, formatTokens, shortModel } from '../lib/format'
import { stableUsageScope } from '../state/selectors'
import { usageCallsKey, useOcc } from '../state/store'
import { useLiveUsage } from '../state/usage-live'
import { Button, Segmented } from '../ui'
import {
  AnimatedBarList, CostDisclaimer, FLOW_LABEL, FLOW_VAR, InFlightMeter, KpiTile, RadialGauge, Sparkline, type BarRow,
} from '../ui/flow'
import { ErrorBox, Section, Skeleton } from './common'

type Seg = 'agent' | 'workflow'
type Metric = 'tokens' | 'cost'

export const COMPACTION_DROP = 0.4
export const CHART_MAX_CALLS = 200
const ROW_H = 24
const VISIBLE_ROWS = 10
const OVERSCAN = 4

/** Indices whose inflow fell by more than 40% from the previous call (context compaction). */
export function compactionIndices(calls: readonly UsageSample[]): number[] {
  const out: number[] = []
  for (let i = 1; i < calls.length; i++) {
    const prev = inflowOf(calls[i - 1]!.tokens)
    if (prev > 0 && inflowOf(calls[i]!.tokens) < prev * (1 - COMPACTION_DROP)) out.push(i)
  }
  return out
}

/** Tab label: "Usage · $1.42", else compact tokens, else "Usage". */
export function usageTabLabel(s: SessionSummary): string {
  if (typeof s.cost === 'number' && s.cost > 0) return `Usage · ${formatCost(s.cost)}`
  const tokens = (s.usage?.inflow ?? 0) + (s.usage?.outflow ?? 0)
  return tokens > 0 ? `Usage · ${formatTokens(tokens)}` : 'Usage'
}

/* ───────────────────────────── context growth chart ───────────────────────────── */

const W = 600
const H = 120
const CTX_H = 82
const OUT_H = 30

export function ContextChart({ calls, highlightId, onSelect }: { calls: UsageSample[]; highlightId: string | null; onSelect: (id: string) => void }) {
  const [hover, setHover] = useState<number | null>(null)
  const n = calls.length
  const drops = useMemo(() => new Set(compactionIndices(calls)), [calls])
  if (n === 0) return null
  const pad = 6
  const step = n > 1 ? (W - 2 * pad) / (n - 1) : 12
  const xOf = (i: number) => (n > 1 ? pad + i * step : W / 2)
  const maxIn = Math.max(1, ...calls.map((c) => inflowOf(c.tokens)))
  const maxOut = Math.max(1, ...calls.map((c) => outflowOf(c.tokens)))
  const yIn = (v: number) => CTX_H - (v / maxIn) * (CTX_H - 8)
  const idx = n > 1 ? calls.map((_, i) => i) : [0, 0]
  const xs = n > 1 ? idx.map(xOf) : [W / 2 - 6, W / 2 + 6]
  const layers = [
    { flow: 'input' as const, get: (c: UsageSample) => c.tokens.input },
    { flow: 'cacheRead' as const, get: (c: UsageSample) => c.tokens.cacheRead },
    { flow: 'cacheWrite' as const, get: (c: UsageSample) => c.tokens.cacheWrite },
  ]
  const cum: number[][] = []
  let prev = idx.map(() => 0)
  const polys = layers.map((l) => {
    const top = idx.map((ci, k) => prev[k]! + l.get(calls[ci]!))
    const pts = [...xs.map((x, k) => `${x.toFixed(1)},${yIn(top[k]!).toFixed(1)}`), ...xs.map((x, k) => `${x.toFixed(1)},${yIn(prev[k]!).toFixed(1)}`).reverse()].join(' ')
    cum.push(top)
    prev = top
    return { flow: l.flow, pts }
  })
  const bw = Math.max(1, Math.min(10, step * 0.6))
  const h = hover !== null ? calls[hover] : null
  return (
    <div className="relative" data-testid="context-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H} role="img" aria-label="Context size per call">
        <line x1={0} x2={W} y1={CTX_H + 1} y2={CTX_H + 1} stroke="var(--panel-border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {polys.map((p) => <polygon key={p.flow} data-layer={p.flow} points={p.pts} fill={FLOW_VAR[p.flow]} opacity={0.55} />)}
        {calls.map((c, i) => {
          const hgt = (outflowOf(c.tokens) / maxOut) * (OUT_H - 2)
          const rh = (c.tokens.reasoning / maxOut) * (OUT_H - 2)
          return (
            <g key={c.id} data-out={c.id}>
              <rect x={xOf(i) - bw / 2} y={CTX_H + 4} width={bw} height={Math.max(0, hgt - rh)} fill={FLOW_VAR.output} />
              {rh > 0 && <rect x={xOf(i) - bw / 2} y={CTX_H + 4 + hgt - rh} width={bw} height={rh} fill={FLOW_VAR.reasoning} />}
            </g>
          )
        })}
        {[...drops].map((i) => (
          <g key={`d${i}`} data-compaction={calls[i]!.id}>
            <title>Context compacted</title>
            <line x1={xOf(i)} x2={xOf(i)} y1={2} y2={CTX_H} stroke="var(--status-failed)" strokeDasharray="2 2" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <polygon points={`${xOf(i) - 4},2 ${xOf(i) + 4},2 ${xOf(i)},9`} fill="var(--status-failed)" />
          </g>
        ))}
        {highlightId && calls.some((c) => c.id === highlightId) && (
          <line data-highlight x1={xOf(calls.findIndex((c) => c.id === highlightId))} x2={xOf(calls.findIndex((c) => c.id === highlightId))} y1={0} y2={H} stroke="var(--foreground)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
        {calls.map((c, i) => (
          <rect
            key={c.id}
            data-point={c.id}
            x={xOf(i) - Math.max(2, step / 2)}
            y={0}
            width={Math.max(4, step)}
            height={H}
            fill="transparent"
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((x) => (x === i ? null : x))}
            onClick={() => onSelect(c.id)}
          />
        ))}
      </svg>
      {h && hover !== null && (
        <div className="panel pointer-events-none absolute top-0 z-10 px-2 py-1 text-[10px] leading-snug" style={{ left: `${Math.min(70, Math.max(0, (xOf(hover) / W) * 100 - 15))}%` }} data-testid="context-tooltip">
          <div className="font-medium">{formatClock(h.ts)} · {shortModel(h.model?.modelId)}</div>
          <div className="tabular-nums">context {formatTokens(inflowOf(h.tokens))} · out {formatTokens(outflowOf(h.tokens))}</div>
          <div className="text-muted-foreground tabular-nums">fresh {formatTokens(h.tokens.input)} · read {formatTokens(h.tokens.cacheRead)} · write {formatTokens(h.tokens.cacheWrite)}</div>
          {drops.has(hover) && <div className="text-status-failed-ink">Context compacted</div>}
        </div>
      )}
    </div>
  )
}

/* ───────────────────────────── calls table ───────────────────────────── */

const COLS = '56px 1fr 52px 52px 52px 52px 52px 52px 52px 52px 52px 64px'
const HEAD = ['Time', 'Model', 'Fresh in', 'Cache rd', 'Cache wr', 'Out', 'Reason', 'Cost', 'TTFT', 'Dur', 'tok/s', 'Finish']

function CallRow({ c, highlighted, isNew }: { c: UsageSample; highlighted: boolean; isNew: boolean }) {
  const tps = throughputTps(c)
  const cells: string[] = [
    formatClock(c.ts), shortModel(c.model?.modelId), formatTokens(c.tokens.input), formatTokens(c.tokens.cacheRead), formatTokens(c.tokens.cacheWrite),
    formatTokens(c.tokens.output), formatTokens(c.tokens.reasoning),
    c.cost !== null ? formatCost(c.cost) : c.aiu !== null ? `${c.aiu.toFixed(2)} AIU` : '—',
    c.ttftMs !== null ? formatDuration(c.ttftMs) : '—', c.durationMs !== null ? formatDuration(c.durationMs) : '—',
    tps !== null ? tps.toFixed(0) : '—', c.finish ?? '—',
  ]
  return (
    <motion.div
      data-call={c.id}
      data-highlighted={highlighted || undefined}
      initial={isNew ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn('grid items-center gap-1 px-1 text-[10px] tabular-nums', highlighted && 'bg-muted')}
      style={{ gridTemplateColumns: COLS, height: ROW_H }}
    >
      {cells.map((t, i) => <span key={i} className={cn('truncate', i === 1 && 'font-mono', i > 1 && i < 11 && 'text-right')}>{t}</span>)}
    </motion.div>
  )
}

function CallsTable({
  calls, inFlight, highlightId, onHighlight, canLoadOlder, onLoadOlder, loadingOlder, live, titleOf, scrollToId,
}: {
  calls: UsageSample[]; inFlight: UsageEstimate[]; highlightId: string | null; onHighlight: (id: string | null) => void
  canLoadOlder: boolean; onLoadOlder: () => void; loadingOlder: boolean; live: boolean; titleOf: (id: string) => string; scrollToId: string | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [scrollStart, setScrollStart] = useState(0)
  const seen = useRef<Set<string> | null>(null)
  const n = calls.length
  const start = Math.max(0, (follow ? n - VISIBLE_ROWS : scrollStart) - OVERSCAN)
  const end = Math.min(n, start + VISIBLE_ROWS + 2 * OVERSCAN)

  const fresh = useMemo(() => {
    const prev = seen.current
    return new Set(prev ? calls.filter((c) => !prev.has(c.id)).map((c) => c.id) : [])
  }, [calls])
  useEffect(() => { seen.current = new Set(calls.map((c) => c.id)) }, [calls])

  useEffect(() => {
    const el = ref.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [n, follow, inFlight.length])

  useEffect(() => {
    if (!scrollToId) return
    const i = calls.findIndex((c) => c.id === scrollToId)
    if (i < 0) return
    setFollow(false)
    setScrollStart(Math.max(0, i - 2))
    if (ref.current) ref.current.scrollTop = Math.max(0, i - 2) * ROW_H
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToId])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2
    setFollow((f) => (f === nearBottom ? f : nearBottom))
    const i = Math.floor(el.scrollTop / ROW_H)
    setScrollStart((s) => (s === i ? s : i))
  }

  return (
    <div data-testid="calls-table" className="overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="text-muted-foreground grid gap-1 px-1 text-[9px] font-semibold tracking-wide uppercase" style={{ gridTemplateColumns: COLS }}>
          {HEAD.map((h, i) => <span key={h} className={cn(i > 1 && i < 11 && 'text-right')}>{h}</span>)}
        </div>
        {canLoadOlder && (
          <div className="py-1 text-center">
            <Button variant="subtle" onClick={onLoadOlder} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load older'}</Button>
          </div>
        )}
        <div ref={ref} onScroll={onScroll} className="overflow-y-auto" style={{ maxHeight: ROW_H * VISIBLE_ROWS }} data-testid="calls-scroll">
          <div style={{ height: n * ROW_H, position: 'relative' }}>
            <div style={{ position: 'absolute', top: start * ROW_H, left: 0, right: 0 }}>
              {calls.slice(start, end).map((c) => (
                <div key={c.id} onClick={() => onHighlight(c.id === highlightId ? null : c.id)} className="cursor-pointer">
                  <CallRow c={c} highlighted={c.id === highlightId} isNew={fresh.has(c.id)} />
                </div>
              ))}
            </div>
          </div>
        </div>
        {inFlight.map((e) => (
          <div key={e.sessionId} data-testid="inflight-row" className="grid items-center gap-1 px-1 text-[10px]" style={{ gridTemplateColumns: COLS, minHeight: ROW_H }}>
            <span className="tabular-nums">{live ? 'now' : formatClock(e.startedAt)}</span>
            <span className="truncate font-mono">{titleOf(e.sessionId)}</span>
            <span style={{ gridColumn: '3 / span 6' }}><InFlightMeter estTokens={e.estOutputTokens} startedAt={e.startedAt} /></span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ───────────────────────────── tab ───────────────────────────── */

const tile = 'px-2.5 py-2'

export function UsageTab({ session }: { session: SessionSummary }) {
  const isRoot = session.depth === 0
  const [seg, setSeg] = useState<Seg>('agent')
  const [metric, setMetric] = useState<Metric>('tokens')
  const [highlight, setHighlight] = useState<string | null>(null)
  const [scrollTo, setScrollTo] = useState<string | null>(null)
  const workflow = isRoot && seg === 'workflow'
  const scope = stableUsageScope(workflow ? 'workflow' : 'session', session.id)
  const { report, status, error, refresh } = useLiveUsage(scope)
  const sessions = useOcc((s) => s.sessions)
  const selectSession = useOcc((s) => s.selectSession)
  const fetchUsageCalls = useOcc((s) => s.fetchUsageCalls)
  const olderEntry = useOcc((s) => s.usageCalls[usageCallsKey(scope)])
  const [olderRequested, setOlderRequested] = useState(false)
  useEffect(() => { setOlderRequested(false); setHighlight(null) }, [scope])

  const calls = useMemo(() => {
    if (!report) return []
    const map = new Map<string, UsageSample>()
    for (const c of olderEntry?.data?.calls ?? []) map.set(c.id, c)
    for (const c of report.recentCalls) map.set(c.id, c)
    return [...map.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  }, [report, olderEntry?.data])

  const loadOlder = () => {
    setOlderRequested(true)
    void (async () => {
      if (!olderEntry?.data) await fetchUsageCalls(scope)
      await fetchUsageCalls(scope, { older: true })
    })()
  }
  const hasMore = olderEntry?.data ? olderEntry.data.hasMore : (report?.totals.calls ?? 0) > calls.length
  const titleOf = (id: string) => sessions[id]?.title ?? id

  if (!report) {
    if (status === 'error') return <ErrorBox message={error ?? 'Failed to load usage'} onRetry={refresh} />
    return <Skeleton lines={8} />
  }

  const t = report.totals
  if (t.calls === 0 && report.inFlight.length === 0) {
    const coverage = session.facts.some((f) => f.label === 'Token usage')
    return (
      <div className="text-muted-foreground p-4 text-center text-[12px]" data-testid="usage-empty" data-coverage={coverage || undefined}>
        {coverage ? 'Token usage is reported when the session ends.' : 'No metered calls for this session yet.'}
        {status === 'error' && <ErrorBox message={error ?? 'Failed to refresh usage'} onRetry={refresh} />}
      </div>
    )
  }

  const chartCalls = calls.slice(-CHART_MAX_CALLS)
  const ttft = percentile(calls.flatMap((c) => (c.ttftMs !== null ? [c.ttftMs] : [])), 0.5)
  const tps = percentile(calls.flatMap((c) => { const v = throughputTps(c); return v === null ? [] : [v] }), 0.5)
  const costed = t.costedCalls > 0
  let acc = 0
  const costSeries = calls.map((c) => (acc += c.cost ?? 0))
  const burn = session.live && report.rates.costPerHour > 0 ? report.rates.costPerHour : null
  const rows: BarRow[] = report.bySession
    .map((r) => ({ r, v: metric === 'cost' ? r.totals.cost : r.totals.inflow + r.totals.outflow }))
    .sort((a, b) => b.v - a.v)
    .map(({ r, v }) => ({
      key: r.key,
      label: sessions[r.key]?.title ?? r.label,
      value: v,
      right: metric === 'cost' ? formatCost(v) : formatTokens(v),
      split: metric === 'tokens' ? [
        { flow: 'input' as const, value: r.totals.tokens.input }, { flow: 'cacheRead' as const, value: r.totals.tokens.cacheRead },
        { flow: 'cacheWrite' as const, value: r.totals.tokens.cacheWrite }, { flow: 'output' as const, value: r.totals.tokens.output },
        { flow: 'reasoning' as const, value: r.totals.tokens.reasoning },
      ] : [{ flow: 'cost' as const, value: v }],
      onClick: sessions[r.key] ? () => selectSession(r.key) : undefined,
    }))

  return (
    <div data-testid="usage-tab">
      {isRoot && (
        <div className="px-3 pt-1">
          <Segmented<Seg> aria-label="Usage scope" layoutId="usage-scope" className="w-full" value={seg} onChange={setSeg}
            options={[{ value: 'agent', label: 'This agent' }, { value: 'workflow', label: 'Workflow' }]} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 px-3 py-2" data-testid="usage-kpis">
        <KpiTile className={tile} label="Inflow" value={t.inflow} format="tokens" sub={<span>{formatTokens(t.tokens.input)} fresh · {formatTokens(t.tokens.cacheRead)} cached</span>} />
        <KpiTile className={tile} label="Outflow" value={t.outflow} format="tokens" sub={<span>{formatTokens(t.tokens.output)} out · {formatTokens(t.tokens.reasoning)} reasoning</span>} />
        {costed || t.aiu === 0
          ? <KpiTile className={tile} label="Cost" value={t.cost} format="cost" info={<CostDisclaimer />} sub={costed ? undefined : 'not reported'} />
          : <KpiTile className={tile} label="AI units" value={t.aiu} format="int" info={<CostDisclaimer />} sub="Copilot AIU" />}
        <div className={cn('panel bg-panel-solid flex items-center gap-2', tile)} data-kpi="Cache hit">
          <div className="origin-left scale-[0.7] -mr-4 -my-2"><RadialGauge value={t.cacheHitRate} label="Cache hit" /></div>
          <div className="text-muted-foreground text-[10px] font-medium tracking-[0.1em] uppercase">Cache hit</div>
        </div>
        <KpiTile className={tile} label="Calls" value={t.calls} format="int" />
        <div className={cn('panel bg-panel-solid flex flex-col gap-1', tile)} data-kpi="TTFT">
          <div className="text-muted-foreground text-[10px] font-medium tracking-[0.1em] uppercase">TTFT p50 · tok/s</div>
          <div className="text-[15px] font-semibold tabular-nums">{ttft !== null ? formatDuration(ttft) : '—'} · {tps !== null ? tps.toFixed(0) : '—'}</div>
        </div>
      </div>

      <Section title="Context growth" right={<span className="flex gap-2 text-[9px]">{(['input', 'cacheRead', 'cacheWrite', 'output'] as const).map((f) => <span key={f} className="inline-flex items-center gap-1"><i className="inline-block size-2 rounded-sm" style={{ background: FLOW_VAR[f] }} />{FLOW_LABEL[f]}</span>)}</span>}>
        <ContextChart calls={chartCalls} highlightId={highlight} onSelect={(id) => { setHighlight(id); setScrollTo(id) }} />
      </Section>

      {costed && (
        <Section title="Cumulative cost" right={<CostDisclaimer />}>
          <Sparkline values={costSeries} color="var(--flow-cost)" height={32} />
          <div className="text-muted-foreground mt-1 flex justify-between text-[10px] tabular-nums">
            <span>{formatCost(t.cost)} total</span>
            {burn !== null && <span data-testid="burn-rate">{formatCost(burn)}/h burn</span>}
          </div>
        </Section>
      )}

      {workflow && rows.length > 0 && (
        <Section title="Workflow breakdown" right={
          <Segmented<Metric> aria-label="Breakdown metric" layoutId="usage-metric" value={metric} onChange={setMetric}
            options={[{ value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' }]} />
        }>
          <AnimatedBarList rows={rows} />
        </Section>
      )}

      <Section title="Calls">
        <CallsTable
          calls={calls} inFlight={report.inFlight} highlightId={highlight}
          onHighlight={setHighlight} scrollToId={scrollTo}
          canLoadOlder={hasMore} onLoadOlder={loadOlder}
          loadingOlder={olderRequested && olderEntry?.status === 'loading'} live={session.live} titleOf={titleOf}
        />
      </Section>
    </div>
  )
}
