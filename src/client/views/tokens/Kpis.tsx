import { memo, useMemo, useRef, type ReactNode } from 'react'
import type { FlowKind, UsageReport, UsageSample, UsageScope } from '../../../shared/contract'
import { formatCost, formatTokens } from '../../lib/format'
import { useInFlightMeters, useUsageBurst } from '../../state/usage-live'
import {
  CostDisclaimer, DeltaChips, FLOW_VAR, InFlightMeter, KpiTile, RadialGauge,
  type DeltaChipsHandle,
} from '../../ui/flow'
import { callStats, formatMs } from './model'

const Dot = ({ flow }: { flow: FlowKind }) => <span aria-hidden="true" className="mr-1 inline-block size-1.5 rounded-full align-middle" style={{ background: FLOW_VAR[flow] }} />

function Region({ label, children }: { label: string; children: ReactNode }) {
  return <div role="region" aria-label={label} className="min-w-0" data-testid={`kpi-${label.toLowerCase().replace(/\s+/g, '-')}`}>{children}</div>
}

/** Same chrome as KpiTile for tiles whose body is not an odometer. */
function Tile({ label, info, chipsRef, children }: { label: string; info?: ReactNode; chipsRef?: React.Ref<DeltaChipsHandle>; children: ReactNode }) {
  return (
    <div className="panel bg-panel-solid relative flex h-full min-w-0 flex-col gap-1 px-4 py-3" data-kpi={label}>
      <div className="text-muted-foreground flex items-center gap-1 text-[10px] font-medium tracking-[0.1em] uppercase"><span>{label}</span>{info}</div>
      {children}
      {chipsRef && <DeltaChips ref={chipsRef} className="absolute top-2 right-3" />}
    </div>
  )
}

function seriesOf(report: UsageReport, f: (b: UsageReport['series']['buckets'][number]) => number): number[] {
  return report.series.buckets.slice(-30).map(f)
}

export const Kpis = memo(function Kpis({ report, scope }: { report: UsageReport; scope: UsageScope }) {
  const inflowChips = useRef<DeltaChipsHandle>(null)
  const outflowChips = useRef<DeltaChipsHandle>(null)
  const costChips = useRef<DeltaChipsHandle>(null)
  useUsageBurst(scope, (x) => {
    if (!('ledgerSeq' in x)) return // estimates are never billed
    const s = x as UsageSample
    const inflow = s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite
    const outflow = s.tokens.output + s.tokens.reasoning
    if (inflow > 0) inflowChips.current?.push({ label: inflow, flow: 'input' })
    if (outflow > 0) outflowChips.current?.push({ label: outflow, flow: 'output' })
    if (s.cost != null && s.cost > 0) costChips.current?.push({ label: `+${formatCost(s.cost)}`, flow: 'cost' })
  })

  const { totals: t, rates: r } = report
  const stats = useMemo(() => callStats(report.recentCalls), [report.recentCalls])
  const costed = t.costedCalls > 0
  const burstTokens = r.inflowPerMin + r.outflowPerMin
  const sparkTokens = useMemo(() => seriesOf(report, (b) => b.input + b.cacheRead + b.cacheWrite + b.output + b.reasoning), [report.series.buckets]) // eslint-disable-line react-hooks/exhaustive-deps
  const sparkCost = useMemo(() => seriesOf(report, (b) => b.cost), [report.series.buckets]) // eslint-disable-line react-hooks/exhaustive-deps
  const meters = useInFlightMeters(scope)
  const est = meters.reduce((n, e) => n + e.estTokens, 0)
  const startedAt = meters.reduce((m, e) => Math.min(m, e.startedAt), Infinity)
  // Aggregate of live entries; once none stream, briefly show the completed calls' metered total (morph + check).
  const allDone = meters.length > 0 && meters.every((e) => e.done)
  const metered = allDone ? meters.reduce((n, e) => n + (e.metered ?? 0), 0) : null

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" data-testid="tokens-kpis">
      <Region label="Inflow">
        <KpiTile
          label="Inflow" value={t.inflow} format="tokens" chipsRef={inflowChips}
          sub={<span className="flex flex-wrap gap-x-2"><span><Dot flow="input" />fresh {formatTokens(t.tokens.input)}</span><span><Dot flow="cacheRead" />cache read {formatTokens(t.tokens.cacheRead)}</span><span><Dot flow="cacheWrite" />cache write {formatTokens(t.tokens.cacheWrite)}</span></span>}
        />
      </Region>
      <Region label="Outflow">
        <KpiTile
          label="Outflow" value={t.outflow} format="tokens" chipsRef={outflowChips}
          sub={meters.length > 0
            ? <InFlightMeter estTokens={est} startedAt={startedAt} metered={metered} />
            : <span className="flex flex-wrap gap-x-2"><span><Dot flow="output" />output {formatTokens(t.tokens.output)}</span><span><Dot flow="reasoning" />reasoning {formatTokens(t.tokens.reasoning)}</span></span>}
        />
      </Region>
      <Region label="Cost">
        {costed ? (
          <KpiTile
            label="Cost" value={t.cost} format="cost" chipsRef={costChips} info={<CostDisclaimer />}
            sub={<span>list price{t.aiu > 0 ? ` · ${t.aiu.toFixed(1)} AIU` : ''}</span>}
          />
        ) : (
          <Tile label="Cost" chipsRef={costChips} info={<CostDisclaimer />}>
            <div className="text-xl font-semibold" data-testid="kpi-cost-unreported">—</div>
            <div className="text-muted-foreground text-[11px]">not reported{t.aiu > 0 ? ` · ${t.aiu.toFixed(1)} AIU` : ''}</div>
          </Tile>
        )}
      </Region>
      <Region label="Burn">
        <KpiTile
          label="Burn" value={costed ? r.costPerHour : burstTokens} format={costed ? 'cost' : 'tokens'}
          sub={costed ? `/h · ${formatTokens(burstTokens)} tok/min` : 'tokens / min'}
          spark={costed ? sparkCost : sparkTokens} sparkColor={costed ? 'var(--flow-cost)' : 'var(--flow-input)'}
          info={costed ? <CostDisclaimer /> : undefined}
        />
      </Region>
      <Region label="Cache hit">
        <Tile label="Cache hit">
          <div className="flex items-center gap-3">
            <RadialGauge value={t.cacheHitRate} label="Cache hit rate" />
            <span className="text-muted-foreground text-[11px]">{t.cacheHitRate == null ? 'no input yet' : `${formatTokens(t.tokens.cacheRead)} of ${formatTokens(t.inflow)} input from cache`}</span>
          </div>
        </Tile>
      </Region>
      <Region label="Calls">
        <KpiTile
          label="Calls" value={t.calls} format="int"
          sub={`TTFT p50 ${stats.ttftP50 == null ? '—' : formatMs(stats.ttftP50)} · ${stats.tps == null ? '—' : `${Math.round(stats.tps)} tok/s`}`}
        />
      </Region>
    </div>
  )
})

export function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" data-testid="tokens-skeleton" aria-busy="true" aria-label="Loading token usage">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="panel bg-panel-solid flex h-[92px] flex-col gap-2 px-4 py-3"><div className="bg-muted h-2.5 w-14 rounded" /><div className="flow-shimmer-bar h-5 w-24" /><div className="bg-muted h-2 w-28 rounded" /></div>
      ))}
    </div>
  )
}
