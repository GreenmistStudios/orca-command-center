import { memo } from 'react'
import type { UsageReport } from '../../../shared/contract'
import { formatCost, formatCount, formatTokens } from '../../lib/format'
import { SectionLabel } from '../../ui'

export const Yield = memo(function Yield({ report, onOpen }: { report: UsageReport; onOpen(): void }) {
  const o = report.output
  if (!o) return null
  const t = report.totals
  const tokens = t.inflow + t.outflow
  const items: Array<[string, string]> = [
    ['Files changed', formatCount(o.fileChanges)], ['Files touched', formatCount(o.filesTouched)],
    ['Lines', `+${formatCount(o.additions)} / −${formatCount(o.deletions)}`],
    ['Artifacts', formatCount(o.artifacts)], ['PRs', formatCount(o.pullRequests)],
  ]
  if (t.costedCalls > 0 && o.fileChanges > 0) items.push(['$ / file changed', formatCost(t.cost / o.fileChanges)])
  if (o.additions > 0 && tokens > 0) items.push(['tokens / +line', formatTokens(tokens / o.additions)])
  return (
    <button type="button" onClick={onOpen} className="panel bg-panel-solid focus-ring hover:bg-accent/40 flex min-w-0 flex-col gap-2 p-3 text-left" data-testid="tokens-yield" aria-label="Yield — open Changes view">
      <SectionLabel>YIELD</SectionLabel>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-3 xl:grid-cols-4">
        {items.map(([k, v]) => (<div key={k} className="min-w-0"><dt className="text-muted-foreground truncate">{k}</dt><dd className="text-[13px] font-semibold tabular-nums">{v}</dd></div>))}
      </dl>
    </button>
  )
})
