import { memo, useMemo } from 'react'
import type { UsageReport } from '../../../shared/contract'
import { formatTokens } from '../../lib/format'
import { SectionLabel } from '../../ui'
import { MirroredStreamChart } from '../../ui/flow'

export interface StreamPanelProps {
  report: UsageReport
  windowMs: number | null
  units: 'tokens' | 'cost'
  scale: 'balanced' | 'linear'
  zoom: [number, number] | null
  onBrush(range: [number, number]): void
  onResetZoom(): void
}

export const StreamPanel = memo(function StreamPanel({ report, windowMs, units, scale, zoom, onBrush, onResetZoom }: StreamPanelProps) {
  const rolling = windowMs != null
  const b = report.series.buckets
  const span: [number, number] = useMemo(() => {
    const from = report.totals.firstTs ?? b[0]?.t ?? report.generatedAt - 60_000
    const to = report.totals.lastTs ?? (b.length ? b[b.length - 1].t + report.series.bucketMs : report.generatedAt)
    return [from, Math.max(to, from + report.series.bucketMs)]
  }, [report.totals.firstTs, report.totals.lastTs, report.generatedAt, report.series.bucketMs, b])
  const domain: [number, number] | 'live' = zoom ?? (rolling ? 'live' : span)
  const markers = useMemo(() => report.recentCalls.map((c) => c.ts), [report.recentCalls])
  const peak = useMemo(() => b.reduce((m, x) => Math.max(m, x.input + x.cacheRead + x.cacheWrite + x.output + x.reasoning), 0), [b])

  return (
    <section className="panel bg-panel-solid flex min-w-0 flex-col gap-2 p-3" aria-label="Token stream" data-testid="tokens-stream">
      <div className="flex items-center gap-2">
        <SectionLabel>STREAM</SectionLabel>
        {zoom && <button type="button" onClick={onResetZoom} className="bg-muted hover:bg-accent focus-ring rounded-full px-2 py-0.5 text-[10px]" data-testid="tokens-reset-zoom">Reset zoom</button>}
      </div>
      <p className="sr-only">{`Traffic over time: ${b.length} buckets, ${report.totals.calls} calls, peak ${formatTokens(peak)} tokens per bucket.`}</p>
      <MirroredStreamChart
        buckets={b} bucketMs={report.series.bucketMs} domain={domain} spanMs={rolling && !zoom ? windowMs : undefined}
        units={units} markers={markers} balanced={scale === 'balanced'} onBrush={onBrush} height={220}
      />
    </section>
  )
})
