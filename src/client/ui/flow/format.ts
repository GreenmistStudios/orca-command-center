import { formatCost, formatCount, formatTokens } from '../../lib/format'

export type FlowFormat = 'tokens' | 'cost' | 'int' | 'percent'

export interface FormattedValue {
  /** Display string, e.g. `113.5k`, `$0.42`, `83%`. */
  text: string
  /** Exact value for assistive tech, e.g. `20,483,274 tokens`. */
  aria: string
}

/** Format for Odometer / KPI values. `percent` takes 0..1. */
export function formatFlowValue(value: number, format: FlowFormat): FormattedValue {
  const v = Number.isFinite(value) ? value : 0
  switch (format) {
    case 'tokens':
      return { text: formatTokens(v), aria: `${formatCount(Math.round(v))} tokens` }
    case 'cost':
      return { text: formatCost(v), aria: `${v.toFixed(2)} US dollars` }
    case 'percent': {
      const p = Math.round(v * 100)
      return { text: `${p}%`, aria: `${p} percent` }
    }
    default:
      return { text: formatCount(Math.round(v)), aria: formatCount(Math.round(v)) }
  }
}

/** Compact signed delta chip text: `+12.4k`. */
export function formatDelta(tokens: number): string {
  return `${tokens < 0 ? '-' : '+'}${formatTokens(Math.abs(tokens))}`
}
