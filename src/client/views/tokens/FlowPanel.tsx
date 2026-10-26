import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { SankeyNode, UsageReport, UsageSample, UsageScope } from '../../../shared/contract'
import { formatCost, formatTokens } from '../../lib/format'
import { SectionLabel } from '../../ui'
import { FlowLegend, SankeyChart, type BurstEmitter } from '../../ui/flow'
import { useUsageBurst } from '../../state/usage-live'
import { linkIdsFor, RateTracker } from './model'

const PUBLISH_MS = 500

export interface FlowPanelProps {
  report: UsageReport
  scope: UsageScope
  windowMs: number | null
  units: 'tokens' | 'cost'
  scale: 'balanced' | 'linear'
  selectedNodeId: string | null
  onNodeClick(node: SankeyNode): void
}

/** Sankey with per-link EWMA rates (kept in a ref, published at 2 Hz) and a burst per in-scope call. */
const isMiddleNode = (n: SankeyNode): boolean => n.kind === 'middle' && n.id !== 'mid:other'

export const FlowPanel = memo(function FlowPanel({ report, scope, windowMs, units, scale, selectedNodeId, onNodeClick }: FlowPanelProps) {
  const tracker = useRef(new RateTracker())
  const sankeyRef = useRef(report.sankey)
  sankeyRef.current = report.sankey
  const reportRef = useRef(report)
  reportRef.current = report
  const [rates, setRates] = useState<Record<string, number>>({})

  const emitter = useMemo(() => {
    const fns = new Set<(id: string, tokens: number) => void>()
    return {
      subscribe(fn) { fns.add(fn); return () => { fns.delete(fn) } },
      emit(id: string, tokens: number) { for (const f of fns) f(id, tokens) },
    } satisfies BurstEmitter & { emit(id: string, tokens: number): void }
  }, [])

  useUsageBurst(scope, (x) => {
    if (!('ledgerSeq' in x)) return
    const now = Date.now()
    for (const [id, tokens] of linkIdsFor(x as UsageSample, sankeyRef.current)) {
      tracker.current.add(id, tokens, now)
      emitter.emit(id, tokens)
    }
  })

  // Seed from the baseline sustained rate whenever the scope/window/middle changes.
  const seedKey = `${scope.kind}:${scope.id ?? ''}:${windowMs ?? 'all'}:${report.sankey.middle}`
  useEffect(() => {
    const r = reportRef.current
    tracker.current.seed(r.sankey, r.rates.inflowPerMin, r.rates.outflowPerMin)
    setRates(tracker.current.snapshot(Date.now()))
  }, [seedKey])

  useEffect(() => {
    let had = false
    const t = setInterval(() => {
      const active = tracker.current.active
      if (!active && !had) return
      had = active
      setRates(tracker.current.snapshot(Date.now()))
    }, PUBLISH_MS)
    return () => clearInterval(t)
  }, [])

  const mids = report.sankey.nodes.filter((n) => n.kind === 'middle')
  const top = mids.slice().sort((a, b) => b.value - a.value)[0]
  const summary = `Token flow: ${formatTokens(report.totals.inflow)} inflow and ${formatTokens(report.totals.outflow)} outflow across ${mids.length} ${report.sankey.middle} node${mids.length === 1 ? '' : 's'}${top ? `; largest is ${top.label} with ${units === 'cost' && top.cost != null ? formatCost(top.cost) : `${formatTokens(top.value)} tokens`}` : ''}.`

  return (
    <section className="panel bg-panel-solid flex min-w-0 flex-col gap-2 p-3" aria-label="Token flow" data-testid="tokens-flow">
      <div className="flex items-center justify-between gap-2"><SectionLabel>FLOW</SectionLabel><FlowLegend /></div>
      <p className="sr-only" data-testid="tokens-flow-summary">{summary}</p>
      <SankeyChart
        sankey={report.sankey} scale={scale} units={units} rates={rates} burstEmitter={emitter}
        selectedNodeId={selectedNodeId} onNodeClick={onNodeClick} isNodeInteractive={isMiddleNode} height={320}
      />
    </section>
  )
})
