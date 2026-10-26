import { ArrowDown, ArrowUp } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { FleetStats, SessionSummary } from '../../../shared/contract'
import { cn } from '../../lib/cn'
import { formatCost, formatCount, formatTokens, shortModel } from '../../lib/format'
import { useOcc } from '../../state/store'
import { Duration, EmptyState, HarnessTile, Panel, SectionLabel, StateDot, ToolBadge, kindColorVar } from '../../ui'
import { Histogram, Sparkline } from './Histogram'

function windowLabel(ms: number | undefined): string {
  if (!ms) return ''
  const h = ms / 3_600_000
  return h >= 1 ? `Last ${Math.round(h)} h` : `Last ${Math.round(ms / 60_000)} min`
}

export function OverviewView() {
  const stats = useOcc((s) => s.stats)
  const meta = useOcc((s) => s.meta)
  const bootstrapped = useOcc((s) => s.bootstrapped)
  if (!stats) {
    return <EmptyState title={bootstrapped ? 'No statistics yet' : 'Loading…'} hint={bootstrapped ? 'Stats appear once sessions have activity.' : undefined} />
  }
  return (
    <div data-testid="overview" className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pr-1">
      <div className="flex items-baseline gap-2">
        <SectionLabel>OVERVIEW</SectionLabel>
        <span data-testid="overview-window" className="text-muted-foreground text-[11px]">{windowLabel(meta?.windowMs ?? stats.windowMs)}</span>
      </div>
      <Kpis stats={stats} />
      <Panel className="p-3">
        <SectionLabel>ACTIVITY · LAST 60 MIN</SectionLabel>
        <div className="mt-2"><Histogram buckets={stats.histogram} /></div>
      </Panel>
      <Tables stats={stats} />
      <Scoreboard />
    </div>
  )
}

/* ───────────── KPIs ───────────── */

function Kpi({ label, value, sub, spark, testid, title }: { label: string; value: ReactNode; sub?: ReactNode; spark?: ReactNode; testid: string; title?: string }) {
  return (
    <div data-testid={testid} title={title} className="bg-panel-solid border-panel-border flex min-w-0 flex-col gap-0.5 rounded-xl border px-3 py-2.5">
      <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">{label}</span>
      <span className="text-xl font-semibold tabular-nums" data-testid={`${testid}-value`}>{value}</span>
      <span className="text-muted-foreground truncate text-[11px]">{sub}</span>
      {spark}
    </div>
  )
}

function Kpis({ stats }: { stats: FleetStats }) {
  const { sessions: ss, activity: a, tokens: t } = stats
  const needs = ss.blocked + ss.waiting
  const idle = Math.max(0, ss.live - ss.working - needs)
  const hist = stats.histogram
  const total = t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" data-testid="kpis">
      <Kpi testid="kpi-live" label="Live agents" value={ss.live} sub={`${ss.working} working · ${needs} needs you · ${idle} idle`} />
      <Kpi testid="kpi-tools" label="Tool calls" value={formatCount(a.toolCalls)} sub={<span className={cn(a.toolErrors > 0 && 'text-status-failed-ink')}>{a.toolErrors} errors</span>} spark={<Sparkline values={hist.map((b) => b.tools)} color={kindColorVar('tool')} />} />
      <Kpi testid="kpi-mcp" label="MCP calls" value={formatCount(a.mcpCalls)} sub={`${stats.mcpServers.length} servers`} spark={<Sparkline values={hist.map((b) => b.mcp)} color={kindColorVar('mcp')} />} />
      <Kpi testid="kpi-files" label="Files changed" value={formatCount(a.filesTouched)} sub={`${a.fileChanges} changes`} spark={<Sparkline values={hist.map((b) => b.edits)} color={kindColorVar('file-change')} />} />
      <Kpi testid="kpi-tokens" label="Tokens" value={formatTokens(total)} sub={`${formatTokens(t.input)} in · ${formatTokens(t.output)} out`} title={`Input ${t.input.toLocaleString()} · Output ${t.output.toLocaleString()} · Reasoning ${t.reasoning.toLocaleString()} · Cache read ${t.cacheRead.toLocaleString()} · Cache write ${t.cacheWrite.toLocaleString()}`} />
      <Kpi testid="kpi-cost" label="Cost" value={formatCost(stats.cost)} sub={`${ss.total} sessions`} />
    </div>
  )
}

/* ───────────── Tables ───────────── */

function Table({ title, testid, head, children, empty }: { title: string; testid: string; head: string[]; children: ReactNode; empty: boolean }) {
  return (
    <Panel className="flex max-h-64 min-w-0 flex-col overflow-hidden" data-testid={testid}>
      <div className="px-3 pt-2.5 pb-1"><SectionLabel>{title}</SectionLabel></div>
      {empty ? <div className="text-muted-foreground px-3 pb-3 text-xs">No data.</div> : (
        <div className="min-h-0 overflow-y-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-panel-solid sticky top-0 z-[1]">
              <tr className="text-muted-foreground text-left text-[10px] uppercase">
                {head.map((h, i) => <th key={h} className={cn('px-3 py-1 font-medium', i > 0 && 'text-right')}>{h}</th>)}
              </tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
const td = 'px-3 py-1 text-right tabular-nums'

function Tables({ stats }: { stats: FleetStats }) {
  const setStreamFilters = useOcc((s) => s.setStreamFilters)
  const setView = useOcc((s) => s.setView)
  const toStream = (name: string) => { setStreamFilters({ query: name, scope: 'all' }); setView('stream') }
  const maxRate = Math.max(0.0001, ...stats.topTools.map((t) => (t.calls ? t.errors / t.calls : 0)))
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
      <Table title="BY HARNESS" testid="table-harness" head={['Harness', 'Sessions', 'Live', 'Cost']} empty={!stats.byHarness.length}>
        {stats.byHarness.map((h) => (
          <tr key={h.harness}><td className="px-3 py-1"><span className="inline-flex items-center gap-1.5"><HarnessTile harness={h.harness} />{h.harness}</span></td>
            <td className={td}>{h.sessions}</td><td className={td}>{h.live}</td><td className={td}>{formatCost(h.cost)}</td></tr>
        ))}
      </Table>
      <Table title="BY MODEL" testid="table-model" head={['Model', 'Sessions', 'Tokens', 'Cost']} empty={!stats.byModel.length}>
        {stats.byModel.map((m) => (
          <tr key={m.model}><td className="px-3 py-1 font-mono text-[11px]" title={m.model}>{shortModel(m.model)}</td>
            <td className={td}>{m.sessions}</td><td className={td}>{formatTokens(m.tokens)}</td><td className={td}>{formatCost(m.cost)}</td></tr>
        ))}
      </Table>
      <Table title="BY AGENT" testid="table-agent" head={['Agent', 'Sessions', 'Cost']} empty={!stats.byAgent.length}>
        {stats.byAgent.map((a) => (
          <tr key={a.agent}><td className="px-3 py-1 font-mono text-[11px]">{a.agent}</td><td className={td}>{a.sessions}</td><td className={td}>{formatCost(a.cost)}</td></tr>
        ))}
      </Table>
      <Table title="TOP TOOLS" testid="table-tools" head={['Tool', 'Calls', 'Errors', 'Error rate']} empty={!stats.topTools.length}>
        {stats.topTools.map((t) => {
          const rate = t.calls ? t.errors / t.calls : 0
          return (
            <tr key={t.name} data-testid="tool-row" className="hover:bg-accent/50 cursor-pointer" onClick={() => toStream(t.name)}>
              <td className="max-w-[12rem] px-3 py-1">
                <button type="button" className="focus-ring max-w-full text-left" onClick={(e) => { e.stopPropagation(); toStream(t.name) }}>
                  <ToolBadge tool={{ name: t.name, displayName: t.mcpServer ? t.name.replace(`${t.mcpServer}_`, '') : t.name, category: t.category, mcpServer: t.mcpServer, callId: null, input: null, output: null } as never} />
                </button>
              </td>
              <td className={td}>{formatCount(t.calls)}</td>
              <td className={cn(td, t.errors > 0 && 'text-status-failed-ink')}>{t.errors}</td>
              <td className="w-20 px-3 py-1"><div className="bg-muted h-1.5 overflow-hidden rounded-full"><div className="bg-status-failed h-full" style={{ width: `${(rate / maxRate) * 100}%` }} title={`${(rate * 100).toFixed(1)}%`} /></div></td>
            </tr>
          )
        })}
      </Table>
      <Table title="MCP SERVERS" testid="table-mcp" head={['Server', 'Tools', 'Calls', 'Errors']} empty={!stats.mcpServers.length}>
        {stats.mcpServers.map((m) => (
          <tr key={m.server} data-testid="mcp-row" className="hover:bg-accent/50 cursor-pointer" onClick={() => toStream(m.server)}>
            <td className="px-3 py-1 font-mono text-[11px]" style={{ color: kindColorVar('mcp') }}>{m.server}</td>
            <td className={td}>{m.tools}</td><td className={td}>{formatCount(m.calls)}</td>
            <td className={cn(td, m.errors > 0 && 'text-status-failed-ink')}>{m.errors}</td>
          </tr>
        ))}
      </Table>
    </div>
  )
}

/* ───────────── Scoreboard ───────────── */

export type SortKey = 'default' | 'title' | 'workspace' | 'harness' | 'agent' | 'elapsed' | 'subagents' | 'tools' | 'errors' | 'files' | 'tokens' | 'cost'
const tokensOf = (s: SessionSummary) => s.tokens.input + s.tokens.output + s.tokens.reasoning
const elapsedOf = (s: SessionSummary, now: number) => (s.live ? now : s.updatedAt) - s.createdAt
const VALUE: Record<Exclude<SortKey, 'default'>, (s: SessionSummary, now: number) => string | number> = {
  title: (s) => s.title.toLowerCase(), workspace: (s) => s.workspace?.name.toLowerCase() ?? '', harness: (s) => s.harness,
  agent: (s) => s.agent?.toLowerCase() ?? '', elapsed: elapsedOf, subagents: (s) => s.descendantCount,
  tools: (s) => s.counters?.tools ?? -1, errors: (s) => s.counters?.toolErrors ?? -1, files: (s) => s.counters?.filesTouched ?? -1,
  tokens: tokensOf, cost: (s) => s.cost,
}

/** Sort root sessions. `default`: live first, then cost desc. */
export function sortScoreboard(rows: SessionSummary[], key: SortKey, dir: 'asc' | 'desc', now = Date.now()): SessionSummary[] {
  const out = [...rows]
  if (key === 'default') return out.sort((a, b) => Number(b.live) - Number(a.live) || b.cost - a.cost || a.id.localeCompare(b.id))
  const f = VALUE[key]
  const m = dir === 'asc' ? 1 : -1
  return out.sort((a, b) => {
    const x = f(a, now), y = f(b, now)
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return c * m || a.id.localeCompare(b.id)
  })
}

const COLS: Array<{ key: Exclude<SortKey, 'default'>; label: string; num?: boolean }> = [
  { key: 'title', label: 'Session' }, { key: 'workspace', label: 'Workspace' }, { key: 'harness', label: 'Harness' }, { key: 'agent', label: 'Agent' },
  { key: 'elapsed', label: 'Elapsed', num: true }, { key: 'subagents', label: 'Subagents', num: true }, { key: 'tools', label: 'Tools', num: true },
  { key: 'errors', label: 'Errors', num: true }, { key: 'files', label: 'Files', num: true }, { key: 'tokens', label: 'Tokens', num: true }, { key: 'cost', label: 'Cost', num: true },
]

function Scoreboard() {
  const sessions = useOcc((s) => s.sessions)
  const selectSession = useOcc((s) => s.selectSession)
  const selected = useOcc((s) => s.ui.selectedSessionId)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'default', dir: 'desc' })
  const rows = useMemo(
    () => sortScoreboard(Object.values(sessions).filter((s) => s.parentId == null), sort.key, sort.dir),
    [sessions, sort],
  )
  const click = (key: Exclude<SortKey, 'default'>) =>
    setSort((p) => (p.key === key ? { key, dir: p.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'title' || key === 'workspace' || key === 'harness' || key === 'agent' ? 'asc' : 'desc' }))
  const dash = (n: number | undefined) => (n == null ? '–' : formatCount(n))
  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden" data-testid="scoreboard">
      <div className="flex items-baseline gap-2 px-3 pt-2.5 pb-1"><SectionLabel>SCOREBOARD</SectionLabel><span className="text-muted-foreground/70 text-[11px]">{rows.length} root sessions</span></div>
      {rows.length === 0 ? <div className="text-muted-foreground px-3 pb-3 text-xs">No sessions in this window.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-panel-solid sticky top-0 z-[1]">
              <tr className="text-muted-foreground text-[10px] uppercase">
                {COLS.map((c) => (
                  <th key={c.key} className={cn('px-3 py-1 font-medium', c.num ? 'text-right' : 'text-left')} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" data-testid={`sort-${c.key}`} onClick={() => click(c.key)} className="focus-ring inline-flex items-center gap-0.5 uppercase">
                      {c.label}{sort.key === c.key && (sort.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} data-testid="score-row" data-id={s.id} aria-selected={selected === s.id} onClick={() => selectSession(s.id)}
                  className={cn('hover:bg-accent/50 cursor-pointer', selected === s.id && 'bg-selection-soft/70')}>
                  <td className="max-w-[16rem] px-3 py-1"><span className="flex items-center gap-2"><StateDot state={s.state} /><span className="truncate font-semibold">{s.title}</span></span></td>
                  <td className="text-muted-foreground px-3 py-1">{s.workspace?.name ?? '–'}</td>
                  <td className="px-3 py-1"><HarnessTile harness={s.harness} /></td>
                  <td className="px-3 py-1 font-mono text-[11px]">{s.agent ?? '–'}</td>
                  <td className={td}><Duration start={s.createdAt} end={s.live ? null : s.updatedAt} /></td>
                  <td className={td}>{s.descendantCount}</td>
                  <td className={td}>{dash(s.counters?.tools)}</td>
                  <td className={cn(td, (s.counters?.toolErrors ?? 0) > 0 && 'text-status-failed-ink')}>{dash(s.counters?.toolErrors)}</td>
                  <td className={td}>{dash(s.counters?.filesTouched)}</td>
                  <td className={td}>{formatTokens(tokensOf(s))}</td>
                  <td className={td}>{formatCost(s.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
