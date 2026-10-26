import { Info } from 'lucide-react'
import { cn } from '../../lib/cn'

export const COST_DISCLAIMER =
  'Estimated by the harness at public list prices. GitHub Copilot bills by subscription/premium requests.'

/** `info` icon with the cost caveat tooltip (design-system §15.3). Place next to every cost. */
export function CostDisclaimer({ className }: { className?: string }) {
  return (
    <span className={cn('group relative inline-flex align-middle', className)} data-cost-disclaimer>
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground inline-flex rounded-full focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label="About cost estimates"
        aria-describedby="occ-cost-disclaimer-tip"
        title={COST_DISCLAIMER}
      >
        <Info size={12} aria-hidden="true" />
      </button>
      <span
        id="occ-cost-disclaimer-tip"
        role="tooltip"
        className="panel pointer-events-none invisible absolute top-full right-0 z-30 mt-1 w-56 px-2 py-1.5 text-[11px] leading-snug font-normal opacity-0 transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        {COST_DISCLAIMER}
      </span>
    </span>
  )
}
