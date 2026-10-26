import { cn } from '../../lib/cn'

export interface SparklineProps {
  values: number[]
  /** CSS color / var (default `var(--flow-input)`). */
  color?: string
  width?: number
  height?: number
  className?: string
}

/** Pure: points for the polyline in a w×h box (1px padding). */
export function sparklinePoints(values: number[], w: number, h: number): Array<[number, number]> {
  if (values.length === 0) return []
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const step = values.length > 1 ? w / (values.length - 1) : 0
  return values.map((v, i) => [values.length > 1 ? i * step : w / 2, h - 1 - ((v - min) / span) * (h - 2)])
}

/** SVG polyline + area, no animation. */
export function Sparkline({ values, color = 'var(--flow-input)', width = 120, height = 24, className }: SparklineProps) {
  const pts = sparklinePoints(values, width, height)
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = pts.length ? `${line} ${width},${height} 0,${height}` : ''
  return (
    <svg
      className={cn('block w-full', className)}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      height={height}
      aria-hidden="true"
      data-sparkline
    >
      {pts.length > 1 && <polygon points={area} fill={color} opacity={0.14} />}
      {pts.length > 1 && <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
    </svg>
  )
}
