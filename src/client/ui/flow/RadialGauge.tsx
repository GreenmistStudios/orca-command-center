import { motion, useSpring, useTransform } from 'motion/react'
import { useEffect } from 'react'
import { cn } from '../../lib/cn'
import { GAUGE_SPRING, useFlowMotion } from './motion'

export interface GaugeThresholds {
  /** Below this fraction → failed color (default 0.4). */
  low: number
  /** Below this fraction → cost color (default 0.7). */
  mid: number
}

export interface RadialGaugeProps {
  /** 0..1, or null for "no data". */
  value: number | null
  label: string
  thresholds?: GaugeThresholds
  className?: string
}

export const DEFAULT_THRESHOLDS: GaugeThresholds = { low: 0.4, mid: 0.7 }

/** Pure: arc color for a value (design-system §15.3). */
export function gaugeColor(value: number | null, t: GaugeThresholds = DEFAULT_THRESHOLDS): string {
  if (value === null) return 'var(--muted)'
  if (value < t.low) return 'var(--status-failed)'
  if (value < t.mid) return 'var(--flow-cost)'
  return 'var(--flow-cache-read)'
}

const R = 25
const C = 2 * Math.PI * R

/** 56px radial gauge, 6px stroke; arc springs to the value (snaps in reduced motion). */
export function RadialGauge({ value, label, thresholds, className }: RadialGaugeProps) {
  const { reduced } = useFlowMotion()
  const v = value === null ? 0 : Math.max(0, Math.min(1, value))
  const spring = useSpring(reduced ? v : 0, GAUGE_SPRING)
  useEffect(() => {
    if (reduced) spring.jump(v)
    else spring.set(v)
  }, [v, reduced, spring])
  const offset = useTransform(spring, (x) => C * (1 - x))
  const color = gaugeColor(value, thresholds)
  const pct = value === null ? '—' : `${Math.round(v * 100)}%`
  return (
    <div
      className={cn('relative inline-flex h-14 w-14 shrink-0 items-center justify-center', className)}
      role="img"
      aria-label={`${label}: ${value === null ? 'no data' : pct}`}
      data-gauge
      data-color={color}
    >
      <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true" className="-rotate-90">
        <circle cx="28" cy="28" r={R} fill="none" stroke="var(--muted)" strokeWidth="6" />
        <motion.circle
          cx="28" cy="28" r={R} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={C}
          style={{ strokeDashoffset: offset }}
        />
      </svg>
      <span className="absolute text-[13px] font-semibold tabular-nums" aria-hidden="true">{pct}</span>
    </div>
  )
}

