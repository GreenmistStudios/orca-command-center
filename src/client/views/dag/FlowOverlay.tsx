import { Coins } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageEstimate, UsageSample } from '../../../shared/contract'
import { cn } from '../../lib/cn'
import { stableUsageScope } from '../../state/selectors'
import { useInFlightMeters, useUsageBurst } from '../../state/usage-live'
import {
  CostDisclaimer, DeltaChips, formatFlowValue, FLOW_VAR, InFlightMeter, Odometer, useFlowMotion, type DeltaChipsHandle,
} from '../../ui/flow'
import { CostOrAiu, type CostDisplay } from './cost-display'
import { particleCount, particleDuration, ringArcs, type EdgeFlowData, type NodeFlowData } from './overlay'
import type { SessionSummary } from '../../../shared/contract'

const BURST_MS = 1500

/** Dual-tone static stroke (reduced motion) + animateMotion particles along the edge path. */
export function EdgeParticles({ path, flow, reduced }: { path: string; flow: EdgeFlowData; reduced: boolean }) {
  const [burstUntil, setBurstUntil] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useUsageBurst(reduced || !flow.live ? null : stableUsageScope('session', flow.childId), (item) => {
    if (!('ledgerSeq' in item)) return
    setBurstUntil(Date.now() + BURST_MS)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setBurstUntil(0), BURST_MS)
  })
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (reduced) {
    return (
      <g data-testid="edge-flow-static" aria-hidden>
        <path d={path} fill="none" stroke={FLOW_VAR.input} strokeWidth={1.5} strokeOpacity={0.5} strokeDasharray="4 4" />
        <path d={path} fill="none" stroke={FLOW_VAR.output} strokeWidth={1.5} strokeOpacity={0.5} strokeDasharray="4 4" strokeDashoffset={4} />
      </g>
    )
  }
  const bursting = burstUntil > 0
  const down = particleCount(flow.inflowPerMin, flow.live)
  const up = particleCount(flow.outflowPerMin, flow.live)
  if (!bursting && down === 0 && up === 0) return null
  const extra = bursting ? 2 : 0
  const dots = (n: number, perMin: number, kind: 'input' | 'output') => {
    const total = n + (n > 0 || bursting ? extra : 0)
    const dur = particleDuration(perMin)
    return Array.from({ length: total }, (_, i) => (
      <circle key={`${kind}${i}`} r={2.6} fill={FLOW_VAR[kind]} data-particle={kind} data-dur={dur}>
        <animateMotion
          dur={`${dur}s`}
          begin={`${(-(i * dur) / total).toFixed(2)}s`}
          repeatCount="indefinite"
          path={path}
          {...(kind === 'output' ? { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' } : {})}
        />
      </circle>
    ))
  }
  return (
    <g data-testid="edge-flow" aria-hidden pointerEvents="none">
      {dots(down, flow.inflowPerMin, 'input')}
      {dots(up, flow.outflowPerMin, 'output')}
    </g>
  )
}

/** In/out ring, pulse + delta chips on completed calls, in-flight shimmer. Rendered only while the overlay is on. */
export function NodeFlowOverlay({ s, shares }: { s: SessionSummary; shares: NodeFlowData }) {
  const { reduced } = useFlowMotion()
  const chips = useRef<DeltaChipsHandle>(null)
  const [pulse, setPulse] = useState(0)
  const onBurst = useCallback((item: UsageSample | UsageEstimate) => {
    if (!('ledgerSeq' in item)) return
    setPulse((p) => p + 1)
    const out = item.tokens.output
    if (out > 0) chips.current?.push({ label: out, flow: 'output' })
    if (item.cost) chips.current?.push({ label: `+$${item.cost.toFixed(2)}`, flow: 'cost' })
  }, [])
  useUsageBurst(stableUsageScope('session', s.id), onBurst)
  const { inArc, outArc } = ringArcs(shares)
  const f = s.usage?.inFlight
  const entry = useInFlightMeters(stableUsageScope('workflow', s.rootId ?? s.id)).find((e) => e.sessionId === s.id)
  return (
    <>
      <svg aria-hidden className="pointer-events-none absolute -inset-[6px] h-[calc(100%+12px)] w-[calc(100%+12px)] overflow-visible" data-testid="flow-ring">
        <rect x={0} y={0} width="100%" height="100%" rx={18} fill="none" pathLength={1} stroke={FLOW_VAR.input} strokeWidth={2.5} strokeLinecap="round"
          strokeDasharray={`${inArc} 1`} data-arc="in" data-length={inArc} />
        <rect x={0} y={0} width="100%" height="100%" rx={18} fill="none" pathLength={1} stroke={FLOW_VAR.output} strokeWidth={2.5} strokeLinecap="round"
          strokeDasharray={`${outArc} 1`} strokeDashoffset={-(1 - outArc)} data-arc="out" data-length={outArc} />
      </svg>
      {pulse > 0 && !reduced && (
        <span key={pulse} aria-hidden data-testid="flow-pulse" className="pointer-events-none absolute -inset-[3px] rounded-[17px]"
          style={{ animation: 'orca-pulse 1s ease-out 1', ['--orca-pulse' as string]: FLOW_VAR.output }} />
      )}
      <DeltaChips ref={chips} className="pointer-events-none absolute top-0 right-2" />
      {entry ? (
        <InFlightMeter className="pointer-events-none absolute right-3 left-4 top-[34px] scale-y-[.6]" estTokens={entry.estTokens} startedAt={entry.startedAt} metered={entry.metered} />
      ) : f && f.inFlight && (
        <InFlightMeter className="pointer-events-none absolute right-3 left-4 top-[34px] scale-y-[.6]" estTokens={f.estOutputTokens} startedAt={f.startedAt} />
      )}
    </>
  )
}

export function CostTicker({ d, prefix, className }: { d: CostDisplay; prefix?: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-baseline gap-1', className)} data-testid="cost-ticker">
      {prefix && <span className="truncate">{prefix}</span>}
      <CostOrAiu d={d} />
    </span>
  )
}

export function OverlayToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="panel pointer-events-auto flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-muted-foreground"
      aria-pressed={on} onClick={onToggle} data-testid="flow-toggle">
      <Coins size={13} /> Token flow
    </button>
  )
}

export function WorkflowPill({ tree, burn, onOpen }: {
  tree: { inflow: number; outflow: number; cost: number; costedCalls: number; aiu: number }
  burn: { tokensPerMin: number; costPerHour: number }
  onOpen: () => void
}) {
  return (
    <div data-testid="workflow-pill"
      className="panel pointer-events-auto absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full px-3 py-1 text-xs">
      <button type="button" onClick={onOpen} aria-label="Open workflow in Tokens view" className="flex items-center gap-3">
        <span className="flex items-center gap-1" style={{ color: FLOW_VAR.input }}>↓ <Odometer value={tree.inflow} format="tokens" size="sm" /></span>
        <span className="flex items-center gap-1" style={{ color: FLOW_VAR.output }}>↑ <Odometer value={tree.outflow} format="tokens" size="sm" /></span>
        <span className="flex items-center gap-1" style={{ color: FLOW_VAR.cost }}><CostOrAiu d={tree.costedCalls > 0 ? { kind: 'cost', cost: tree.cost } : tree.aiu > 0 ? { kind: 'aiu', aiu: tree.aiu } : { kind: 'none' }} /></span>
        <span className="text-muted-foreground font-mono text-[10px]" data-testid="workflow-burn">
          burn {formatFlowValue(burn.tokensPerMin, 'tokens').text}/min · ${burn.costPerHour.toFixed(2)}/h
        </span>
      </button>
      <CostDisclaimer />
    </div>
  )
}
