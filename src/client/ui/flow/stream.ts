import type { FlowKind, UsageBucket } from '../../../shared/contract'
import { BUCKET_EASE_MS } from './motion'

export type StreamUnits = 'tokens' | 'cost'

/** Linear scale with inverse. */
export interface Scale {
  (v: number): number
  invert(px: number): number
}

export function scaleLinear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0)
  const f = ((v: number) => r0 + (v - d0) * k) as Scale
  f.invert = (px: number) => (k === 0 ? d0 : d0 + (px - r0) / k)
  return f
}

/** Sliding live domain `[now - span, now]`. */
export function liveDomain(now: number, spanMs: number): [number, number] {
  return [now - spanMs, now]
}

/** Stack order away from the axis. */
export const INFLOW_STACK = ['input', 'cacheRead', 'cacheWrite'] as const
export const OUTFLOW_STACK = ['output', 'reasoning'] as const

export interface StackSegment {
  flow: FlowKind | 'cost'
  /** Cumulative start/end distance from the axis, in value units (always ≥ 0). */
  from: number
  to: number
}

export interface StackedBucket {
  up: StackSegment[]
  down: StackSegment[]
  upTotal: number
  downTotal: number
}

/** Stack a bucket: inflow above the axis, outflow below. Cost units: one `cost` series above the axis. `ease` scales heights (0..1). */
export function stackBucket(b: UsageBucket, units: StreamUnits, ease = 1): StackedBucket {
  const up: StackSegment[] = []
  const down: StackSegment[] = []
  let acc = 0
  if (units === 'cost') {
    const v = Math.max(0, b.cost) * ease
    if (v > 0) up.push({ flow: 'cost', from: 0, to: v })
    return { up, down, upTotal: v, downTotal: 0 }
  }
  for (const f of INFLOW_STACK) {
    const v = Math.max(0, b[f]) * ease
    up.push({ flow: f, from: acc, to: acc + v })
    acc += v
  }
  const upTotal = acc
  acc = 0
  for (const f of OUTFLOW_STACK) {
    const v = Math.max(0, b[f]) * ease
    down.push({ flow: f, from: acc, to: acc + v })
    acc += v
  }
  return { up, down, upTotal, downTotal: acc }
}

/** Symmetric y maximum: max over buckets of max(inflow, outflow); never 0. */
export function symmetricMax(buckets: UsageBucket[], units: StreamUnits): number {
  let m = 0
  for (const b of buckets) {
    const s = stackBucket(b, units)
    m = Math.max(m, s.upTotal, s.downTotal)
  }
  return m > 0 ? m : 1
}

/** Optional balanced (√) y transform. */
export function yValue(v: number, balanced: boolean): number {
  return balanced ? Math.sqrt(Math.max(0, v)) : Math.max(0, v)
}

/** "Nice" tick values in (0, max] (1/2/5 × 10ⁿ steps). */
export function niceTicks(max: number, count = 2): number[] {
  if (!(max > 0)) return []
  const raw = max / count
  const pow = 10 ** Math.floor(Math.log10(raw))
  const f = raw / pow
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow
  const out: number[] = []
  for (let v = step; v <= max * 1.0001; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

const TIME_STEPS = [1, 5, 10, 30, 60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400].map((s) => s * 1000)

/** Time ticks (epoch ms) inside `[from, to]`, roughly `target` of them, aligned to nice steps. */
export function timeTicks(from: number, to: number, target = 6): number[] {
  if (!(to > from)) return []
  const want = (to - from) / Math.max(1, target)
  const step = TIME_STEPS.find((s) => s >= want) ?? TIME_STEPS[TIME_STEPS.length - 1]
  const out: number[] = []
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t)
  return out
}

/** Brush pixels → time range, clamped to the domain and ordered. */
export function brushRange(px0: number, px1: number, domain: [number, number], width: number): [number, number] {
  const x = scaleLinear([0, width], domain)
  const clamp = (v: number) => Math.min(domain[1], Math.max(domain[0], v))
  const a = clamp(x(Math.min(px0, px1)))
  const b = clamp(x(Math.max(px0, px1)))
  return [Math.round(a), Math.round(b)]
}

/** Ease-out-cubic height factor for a bucket first seen at `seenAt`. */
export function bucketEase(seenAt: number, now: number): number {
  if (seenAt <= 0) return 1
  const t = Math.min(1, Math.max(0, (now - seenAt) / BUCKET_EASE_MS))
  return 1 - (1 - t) ** 3
}

/** Bucket containing time `t` (buckets are `bucketMs` wide, sorted or not). */
export function bucketAt(buckets: UsageBucket[], t: number, bucketMs: number): UsageBucket | null {
  for (const b of buckets) if (t >= b.t && t < b.t + bucketMs) return b
  return null
}
