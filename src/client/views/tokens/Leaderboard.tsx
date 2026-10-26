import { X } from 'lucide-react'
import { memo, useMemo } from 'react'
import type { SessionSummary, UsageReport } from '../../../shared/contract'
import { formatCost, formatTokens } from '../../lib/format'
import { AgentMonogram, SectionLabel, TabList } from '../../ui'
import { AnimatedBarList, type BarRow } from '../../ui/flow'
import { buildBoardRows, type BoardFilter, type BoardTab } from './model'

export interface LeaderboardProps {
  report: UsageReport
  units: 'tokens' | 'cost'
  tab: BoardTab
  filter: BoardFilter | null
  sessions: Record<string, SessionSummary>
  onTab(t: BoardTab): void
  onClearFilter(): void
  onSelectSession(id: string): void
}

export const Leaderboard = memo(function Leaderboard({ report, units, tab, filter, sessions, onTab, onClearFilter, onSelectSession }: LeaderboardProps) {
  const rows = useMemo<BarRow[]>(() => {
    const data = buildBoardRows(report, tab, filter, sessions)
    const value = (r: (typeof data)[number]) => (units === 'cost' ? r.cost : r.tokens)
    return [...data].sort((a, b) => value(b) - value(a) || (a.key < b.key ? -1 : 1)).slice(0, 12).map((r) => ({
      key: r.key,
      value: value(r),
      split: units === 'cost' ? [{ flow: 'cost' as const, value: r.cost }] : [{ flow: 'input' as const, value: r.inflow }, { flow: 'output' as const, value: r.outflow }],
      right: units === 'cost' ? (report.totals.costedCalls > 0 ? formatCost(r.cost) : '—') : formatTokens(r.tokens),
      label: (
        <span className="flex min-w-0 items-center gap-1.5" title={`${r.label} · ${Math.round(r.share * 100)}% of tokens`}>
          {tab === 'agent' && <AgentMonogram agent={r.key === 'unknown' ? null : r.key} size={17} />}
          <span className="truncate">{r.label}</span>
          <span className="text-muted-foreground shrink-0 tabular-nums" data-share>{Math.round(r.share * 100)}%</span>
        </span>
      ),
      onClick: tab === 'session' && r.sessionId ? () => onSelectSession(r.sessionId!) : undefined,
    }))
  }, [report, tab, filter, sessions, units, onSelectSession])

  return (
    <section className="panel bg-panel-solid flex min-w-0 flex-col gap-2 p-3" aria-label="Leaderboard" data-testid="tokens-leaderboard">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>LEADERBOARD</SectionLabel>
        <TabList<BoardTab>
          aria-label="Leaderboard grouping" idPrefix="tokboard" value={tab} onChange={onTab}
          tabs={[{ value: 'agent', label: 'Agents' }, { value: 'model', label: 'Models' }, { value: 'session', label: 'Sessions' }]}
        />
      </div>
      {filter && (
        <button type="button" onClick={onClearFilter} className="bg-muted hover:bg-accent focus-ring flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px]" data-testid="tokens-filter-chip">
          {filter.kind}: {filter.label}<X size={10} aria-label="Clear filter" />
        </button>
      )}
      {rows.length === 0 ? <p className="text-muted-foreground py-4 text-center text-[11px]">No rows.</p> : <AnimatedBarList rows={rows} />}
    </section>
  )
})
