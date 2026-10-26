import type { SessionSummary } from '../../../shared/contract'

/** Pure helpers for the token-flow overlay (Plan §5.2). */

export interface EdgeFlowData {
  /** Child session id (burst scope). */
  childId: string
  live: boolean
  inflowPerMin: number
  outflowPerMin: number
}

export interface NodeFlowData {
  /** Share (0..1) of the workflow's inflow / outflow this node accounts for. */
  inShare: number
  outShare: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Log-mapped 0..1 intensity: 10 tok/min → 0, 100k tok/min → 1. */
export function rateIntensity(perMin: number): number {
  if (!(perMin > 0)) return 0
  return clamp((Math.log10(perMin) - 1) / 4, 0, 1)
}

/** Dot count 0–4 (0 when the rate is 0 or the child isn't live). */
export function particleCount(perMin: number, live: boolean): number {
  if (!live || !(perMin > 0)) return 0
  return 1 + Math.round(rateIntensity(perMin) * 3)
}

/** Seconds per traversal, 0.8–3 s (faster for higher rates). */
export function particleDuration(perMin: number): number {
  return Number((3 - rateIntensity(perMin) * 2.2).toFixed(2))
}

export function edgeFlowFor(s: SessionSummary | undefined): EdgeFlowData | null {
  if (!s) return null
  const r = s.usage?.rates
  return { childId: s.id, live: s.live, inflowPerMin: r?.inflowPerMin ?? 0, outflowPerMin: r?.outflowPerMin ?? 0 }
}

export function nodeShares(s: SessionSummary, tree: { inflow: number; outflow: number } | null | undefined): NodeFlowData {
  const u = s.usage
  const share = (v: number, total: number) => (total > 0 ? clamp(v / total, 0, 1) : 0)
  return { inShare: share(u?.inflow ?? 0, tree?.inflow ?? 0), outShare: share(u?.outflow ?? 0, tree?.outflow ?? 0) }
}

/** Arc lengths as fractions of the ring perimeter (each arc gets at most half). */
export function ringArcs(d: NodeFlowData): { inArc: number; outArc: number } {
  return { inArc: Number((d.inShare * 0.5).toFixed(4)), outArc: Number((d.outShare * 0.5).toFixed(4)) }
}

export function workflowBurn(nodes: SessionSummary[]): { tokensPerMin: number; costPerHour: number } {
  let tokensPerMin = 0
  let costPerHour = 0
  for (const n of nodes) {
    if (!n.live || !n.usage?.rates) continue
    tokensPerMin += n.usage.rates.inflowPerMin + n.usage.rates.outflowPerMin
    costPerHour += n.usage.rates.costPerHour
  }
  return { tokensPerMin, costPerHour }
}
