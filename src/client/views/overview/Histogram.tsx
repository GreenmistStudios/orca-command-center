import { useState } from 'react'
import type { ActivityKind, FleetStats } from '../../../shared/contract'
import { formatClock } from '../../lib/format'
import { kindColorVar } from '../../ui'

type Bucket = FleetStats['histogram'][number]
export const HIST_SERIES = [
  { key: 'thinking', label: 'Thinking', kind: 'thinking' },
  { key: 'tools', label: 'Tools', kind: 'tool' },
  { key: 'mcp', label: 'MCP', kind: 'mcp' },
  { key: 'edits', label: 'Edits', kind: 'file-change' },
  { key: 'errors', label: 'Errors', kind: 'error' },
] as const satisfies ReadonlyArray<{ key: keyof Bucket; label: string; kind: ActivityKind }>

const W = 600
const H = 120

export const bucketTotal = (b: Bucket) => b.thinking + b.tools + b.mcp + b.edits + b.errors

/** Stacked per-minute bars for the last hour. */
export function Histogram({ buckets }: { buckets: Bucket[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...buckets.map(bucketTotal))
  const bw = W / Math.max(1, buckets.length)
  const hb = hover != null ? buckets[hover] : null
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label="Activity per minute, last 60 minutes" data-testid="histogram">
        {buckets.map((b, i) => {
          let y = H
          return (
            <g key={b.t} data-testid="hist-bar" data-index={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              {HIST_SERIES.map((s) => {
                const h = (b[s.key] / max) * (H - 4)
                if (h <= 0) return null
                y -= h
                return <rect key={s.key} data-series={s.key} data-height={h.toFixed(2)} x={i * bw + 0.5} y={y} width={Math.max(1, bw - 1)} height={h} fill={kindColorVar(s.kind)} rx={1} />
              })}
            </g>
          )
        })}
      </svg>
      <div className="text-muted-foreground mt-1 flex justify-between font-mono text-[10px]">
        {buckets.length > 0 && [0, 15, 30, 45].map((i) => buckets[i] && <span key={i}>{formatClock(buckets[i].t)}</span>)}
        {buckets.length > 0 && <span>now</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
        {HIST_SERIES.map((s) => (
          <span key={s.key} className="text-muted-foreground inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: kindColorVar(s.kind) }} />{s.label}
          </span>
        ))}
      </div>
      {hb && (
        <div data-testid="hist-tooltip" className="panel pointer-events-none absolute top-0 right-0 z-10 px-2 py-1 text-[11px] shadow-lift-1">
          <div className="font-mono">{formatClock(hb.t)}</div>
          {HIST_SERIES.map((s) => <div key={s.key}>{s.label}: {hb[s.key]}</div>)}
        </div>
      )}
    </div>
  )
}

/** Tiny sparkline of one histogram series (or the total). */
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2 || values.every((v) => v === 0)) return <span className="h-5" />
  const max = Math.max(...values)
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(20 - (v / max) * 18).toFixed(1)}`).join(' ')
  return (
    <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="h-5 w-full" aria-hidden data-testid="sparkline">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
