import type { FlowKind } from '../../../shared/contract'
import { cn } from '../../lib/cn'
import { FLOW_KINDS, FLOW_LABEL, FLOW_VAR } from './flows'

export interface FlowLegendProps {
  /** Subset/ordering of flows (default: all five). */
  flows?: FlowKind[]
  className?: string
}

/** Chips for the five token flows. */
export function FlowLegend({ flows = FLOW_KINDS, className }: FlowLegendProps) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-1.5', className)} aria-label="Token flow legend" data-flow-legend>
      {flows.map((f) => (
        <li
          key={f}
          data-flow={f}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ background: `color-mix(in oklch, ${FLOW_VAR[f]} 14%, transparent)` }}
        >
          <span className="size-1.5 rounded-full" style={{ background: FLOW_VAR[f] }} aria-hidden="true" />
          {FLOW_LABEL[f]}
        </li>
      ))}
    </ul>
  )
}
