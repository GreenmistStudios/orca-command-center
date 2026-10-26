import type { FlowKind } from '../../../shared/contract'

export const FLOW_KINDS: FlowKind[] = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning']
export const INFLOW_KINDS: FlowKind[] = ['input', 'cacheRead', 'cacheWrite']
export const OUTFLOW_KINDS: FlowKind[] = ['output', 'reasoning']

/** CSS custom property per flow (theme.css `--flow-*`). */
export const FLOW_VAR: Record<FlowKind | 'cost', string> = {
  input: 'var(--flow-input)',
  cacheRead: 'var(--flow-cache-read)',
  cacheWrite: 'var(--flow-cache-write)',
  output: 'var(--flow-output)',
  reasoning: 'var(--flow-reasoning)',
  cost: 'var(--flow-cost)',
}

export const FLOW_LABEL: Record<FlowKind, string> = {
  input: 'Input',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
  output: 'Output',
  reasoning: 'Reasoning',
}

/** Short chip suffix, e.g. `+12.4k in`. */
export const FLOW_SHORT: Record<FlowKind, string> = {
  input: 'in',
  cacheRead: 'cache',
  cacheWrite: 'write',
  output: 'out',
  reasoning: 'reason',
}

const RESOLVED_FALLBACK: Record<FlowKind, [string, string]> = {
  input: ['#0284c7', '#38bdf8'],
  cacheRead: ['#0891b2', '#67e8f9'],
  cacheWrite: ['#4f46e5', '#a5b4fc'],
  output: ['#059669', '#34d399'],
  reasoning: ['#7c3aed', '#c4b5fd'],
}
const COST_FALLBACK: [string, string] = ['#d97706', '#fbbf24']

/** Concrete color for canvas drawing (canvas can't read `var()`); reads computed style with fallback. */
export function resolveFlowColor(flow: FlowKind | 'cost'): string {
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const fb = flow === 'cost' ? COST_FALLBACK : RESOLVED_FALLBACK[flow]
  const name = flow === 'cost' ? '--flow-cost'
    : flow === 'cacheRead' ? '--flow-cache-read'
    : flow === 'cacheWrite' ? '--flow-cache-write'
    : `--flow-${flow}`
  if (typeof document !== 'undefined') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (v) return v
  }
  return fb[dark ? 1 : 0]
}
