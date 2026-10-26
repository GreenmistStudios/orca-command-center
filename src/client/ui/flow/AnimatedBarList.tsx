import { motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FlowKind } from '../../../shared/contract'
import { cn } from '../../lib/cn'
import { formatTokens } from '../../lib/format'
import { FLOW_VAR } from './flows'
import { BAR_SPRING, RANK_FLASH_MS, useFlowMotion } from './motion'

export interface BarRow {
  key: string
  label: ReactNode
  value: number
  /** Flow-colored split of the bar; segment values are absolute (same unit as `value`). */
  split?: Array<{ flow: FlowKind | 'cost'; value: number }>
  /** Right-hand content (default: compact token count). */
  right?: ReactNode
  onClick?: () => void
}

export interface AnimatedBarListProps {
  rows: BarRow[]
  /** Bar scale maximum (default: largest row value). */
  max?: number
  className?: string
}

/** Pure: key → signed rank change (+ = moved up) between two orderings; unchanged/new rows are omitted. */
export function rankDeltas(prev: string[], next: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  const before = new Map(prev.map((k, i) => [k, i]))
  next.forEach((k, i) => {
    const p = before.get(k)
    if (p !== undefined && p !== i) out[k] = p - i
  })
  return out
}

/** Glyph for a rank delta: `▲2` / `▼1`. */
export function rankGlyph(d: number): string {
  return d > 0 ? `▲${d}` : `▼${-d}`
}

/** Leaderboard with FLIP reordering (`motion` layout), spring widths and rank-change flashes. Order is the `rows` order. */
export function AnimatedBarList({ rows, max, className }: AnimatedBarListProps) {
  const { reduced } = useFlowMotion()
  const scale = max ?? Math.max(1, ...rows.map((r) => r.value))
  const prevKeys = useRef<string[] | null>(null)
  const [deltas, setDeltas] = useState<Record<string, number>>({})
  const sig = rows.map((r) => r.key).join('\u0000')

  useEffect(() => {
    const keys = rows.map((r) => r.key)
    const prev = prevKeys.current
    prevKeys.current = keys
    if (!prev || reduced) return
    const d = rankDeltas(prev, keys)
    if (Object.keys(d).length === 0) return
    setDeltas(d)
    const t = setTimeout(() => setDeltas({}), RANK_FLASH_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, reduced])

  return (
    <ul className={cn('flex flex-col', className)} data-bar-list>
      {rows.map((r) => {
        const segs = r.split && r.split.length ? r.split : [{ flow: 'input' as const, value: r.value }]
        const d = deltas[r.key]
        const Row = r.onClick ? 'button' : 'div'
        return (
          <motion.li
            key={r.key}
            layout={reduced ? false : 'position'}
            transition={BAR_SPRING}
            data-row={r.key}
            className="h-7"
          >
            <Row
              {...(r.onClick ? { type: 'button' as const, onClick: r.onClick } : {})}
              className={cn('flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-[11px]', r.onClick && 'hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none')}
            >
              <span className="min-w-0 flex-[0_0_38%] truncate">{r.label}</span>
              <span className="bg-muted/60 relative h-2 min-w-0 flex-1 overflow-hidden rounded-full" aria-hidden="true">
                <span className="absolute inset-y-0 left-0 flex" style={{ width: '100%' }}>
                  {segs.map((s, i) => (
                    <motion.span
                      key={i}
                      data-seg={s.flow}
                      className="h-full"
                      initial={false}
                      animate={{ width: `${Math.max(0, Math.min(100, (s.value / scale) * 100))}%` }}
                      transition={reduced ? { duration: 0 } : BAR_SPRING}
                      style={{ background: FLOW_VAR[s.flow] }}
                    />
                  ))}
                </span>
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">{r.right ?? formatTokens(r.value)}</span>
              <span className="w-6 shrink-0 text-[10px] font-semibold tabular-nums" data-rank-delta={d ?? undefined} style={{ color: d && d > 0 ? 'var(--flow-output)' : 'var(--status-failed)' }}>
                {d ? rankGlyph(d) : ''}
              </span>
            </Row>
          </motion.li>
        )
      })}
    </ul>
  )
}
