import { motion } from 'motion/react'
import { ChevronDown, ChevronRight, Network, OctagonAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { HARNESS_META, type Harness, type OrchRun, type SessionSummary } from '../../shared/contract'
import { cn } from '../lib/cn'
import { formatCost, formatDuration, formatRelative, shortModel } from '../lib/format'
import { useNow } from '../hooks/useNow'
import { selectDescendants, selectWorkspaceGroups, type WorkspaceGroup } from '../state/selectors'
import { useOcc } from '../state/store'
import {
  AgentMonogram, EmptyState, HarnessTile, LiveDot, SectionLabel, Segmented, StateDot, StatusPill, Tooltip,
  kindColorVar, stateTone, useSpotlight, STATE_LABEL,
} from '../ui'

export const RAIL_SEARCH_ID = 'rail-search'

/** Focus the rail search input (bound to `/` by the shell hotkeys). */
export function focusRailSearch(): void {
  const el = document.getElementById(RAIL_SEARCH_ID) as HTMLInputElement | null
  el?.focus()
  el?.select()
}

const MICRO = { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const }
const CAST_COLLAPSE = 12
const needsYou = (s: SessionSummary) => s.state === 'blocked' || s.state === 'waiting'

/* ───────────── local selector: harnesses present in the data ───────────── */
function harnessesOf(sessions: Record<string, SessionSummary>): Harness[] {
  const set = new Set<Harness>()
  for (const s of Object.values(sessions)) set.add(s.harness)
  return [...set].sort()
}

/* ───────────────────────────── root row ───────────────────────────── */

function RootRow({
  s, selected, current, hovered, onHover, now,
}: { s: SessionSummary; selected: boolean; current: boolean; hovered: boolean; onHover: (id: string | null) => void; now: number }) {
  const selectSession = useOcc((o) => o.selectSession)
  const spot = useSpotlight<HTMLButtonElement>()
  const tools = s.counters?.tools
  const meta = [
    s.live ? formatDuration(now - s.createdAt) : formatRelative(s.lastActivityAt ?? s.updatedAt, now),
    s.descendantCount > 0 ? `${s.descendantCount} subagent${s.descendantCount === 1 ? '' : 's'}` : null,
    tools != null ? `${tools} tools` : null,
    formatCost(s.cost),
  ].filter(Boolean).join(' · ')
  const model = shortModel(s.model?.modelId)
  const sub = [s.agent, model].filter(Boolean).join(' · ')
  return (
    <button
      ref={spot.ref}
      onPointerMove={spot.onPointerMove}
      type="button"
      data-testid="rail-root-row"
      data-session-id={s.id}
      aria-current={current ? 'true' : undefined}
      aria-label={`${s.title}, ${STATE_LABEL[s.state]}, ${s.workspace?.name ?? 'no workspace'}`}
      onClick={() => selectSession(s.id)}
      onMouseEnter={() => onHover(s.id)}
      onMouseLeave={() => onHover(null)}
      className="focus-ring group relative w-full rounded-lg py-2 pr-2.5 pl-3 text-left"
    >
      <span className="orca-spotlight" />
      {hovered && !selected && (
        <motion.span layoutId="rail-hover" transition={MICRO} className="bg-accent/60 absolute inset-0 rounded-lg" />
      )}
      {selected && (
        <>
          <motion.span layoutId="rail-selected" transition={MICRO} className="bg-selection-soft/70 border-selection/25 absolute inset-0 rounded-lg border" />
          <span className="bg-selection absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full" />
        </>
      )}
      <span className="relative flex flex-col gap-0.5">
        <span className="flex items-center gap-2">
          {s.state === 'working' ? <LiveDot live size={8} /> : <StateDot state={s.state} />}
          <span className="truncate text-[13px] font-semibold">{s.title}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <HarnessTile harness={s.harness} size={17} />
            {needsYou(s) && <OctagonAlert size={14} className="text-status-gate" aria-hidden />}
          </span>
        </span>
        {sub && <span className="text-muted-foreground/80 truncate pl-4 font-mono text-[10.5px]">{sub}</span>}
        <span className="text-muted-foreground truncate pl-4 text-[11px]">{meta}</span>
        {s.live && s.current && (
          <span className="truncate pl-4 font-mono text-[10.5px]" style={{ color: kindColorVar(s.current.kind) }}>
            ▸ {s.current.label}{s.current.detail ? ` · ${s.current.detail}` : ''}
          </span>
        )}
      </span>
    </button>
  )
}

/* ───────────────────────────── the cast ───────────────────────────── */

function CastRow({ c, selected, now }: { c: SessionSummary; selected: boolean; now: number }) {
  const selectSession = useOcc((o) => o.selectSession)
  const showState = c.live || c.state === 'error' || c.state === 'blocked' || c.state === 'waiting'
  const tip = c.current ? `${c.current.label}${c.current.detail ? ` · ${c.current.detail}` : ''}` : (c.spawn?.description ?? null)
  return (
    <Tooltip content={tip} side="right">
      <button
        type="button"
        data-testid="rail-cast-row"
        data-session-id={c.id}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${c.agent ?? 'agent'}, ${c.title}, ${STATE_LABEL[c.state]}`}
        onClick={() => selectSession(c.id)}
        style={{ paddingLeft: 28 + Math.max(0, c.depth - 1) * 12 }}
        className={cn('focus-ring hover:bg-accent/60 relative flex w-full items-center gap-2 rounded-lg py-1.5 pr-9 text-left', selected && 'bg-selection-soft/70')}
      >
        <AgentMonogram agent={c.agent} size={20} />
        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          <span className="font-semibold">{c.agent ?? 'agent'}</span>
          <span className="text-muted-foreground"> · {c.title}</span>
        </span>
        {showState ? (
          <StatusPill tone={stateTone(c.state)} className="absolute right-2 shrink-0 rounded-full px-1.5 py-px text-[10px]">
            {STATE_LABEL[c.state]}
          </StatusPill>
        ) : (
          <StatusPill className="absolute right-2 shrink-0 rounded-full px-1.5 py-px text-[10px]">
            last seen {formatRelative(c.lastActivityAt ?? c.updatedAt, now)}
          </StatusPill>
        )}
      </button>
    </Tooltip>
  )
}

function Cast({ rootId, selectedId, now }: { rootId: string; selectedId: string | null; now: number }) {
  const cast = useOcc((o) => selectDescendants(o, rootId))
  const [expanded, setExpanded] = useState(false)
  if (cast.length === 0) return null
  const collapsed = cast.length > CAST_COLLAPSE && !expanded
  const shown = collapsed ? cast.slice(0, CAST_COLLAPSE) : cast
  return (
    <div data-testid="rail-cast" className="mt-0.5 mb-1.5">
      <div className="text-muted-foreground/60 px-3 pt-1 pb-0.5 text-[10px] font-semibold tracking-wider uppercase">The cast</div>
      {shown.map((c) => <CastRow key={c.id} c={c} selected={c.id === selectedId} now={now} />)}
      {cast.length > CAST_COLLAPSE && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring text-muted-foreground hover:text-foreground w-full py-1 pl-7 text-left text-[11px]">
          {collapsed ? `Show ${cast.length - CAST_COLLAPSE} more` : 'Show fewer'}
        </button>
      )}
    </div>
  )
}

/* ───────────────────────────── workspace group ───────────────────────────── */

function Group({ g, now }: { g: WorkspaceGroup; now: number }) {
  const collapsed = useOcc((o) => !!o.ui.collapsedWorkspaces[g.workspace.key])
  const toggle = useOcc((o) => o.toggleWorkspaceCollapsed)
  const selectedRootId = useOcc((o) => o.ui.selectedRootId)
  const selectedSessionId = useOcc((o) => o.ui.selectedSessionId)
  const [hover, setHover] = useState<string | null>(null)
  const Chev = collapsed ? ChevronRight : ChevronDown
  return (
    <section aria-label={g.workspace.name} className="mb-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => toggle(g.workspace.key)}
        className="focus-ring hover:bg-accent/40 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left"
      >
        <Chev size={12} className="text-muted-foreground/70 shrink-0" aria-hidden />
        <span className="text-muted-foreground/60 truncate text-[10px] font-semibold tracking-wider uppercase">{g.workspace.name}</span>
        {g.workspace.branch && <span className="text-muted-foreground/60 truncate font-mono text-[10px]">{g.workspace.branch}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {g.needsYou > 0 && (
            <span data-testid="needs-you-badge" className="bg-status-gate-soft text-status-gate-ink rounded-full px-1.5 text-[10px] font-semibold tabular-nums">{g.needsYou}</span>
          )}
          {g.liveCount > 0 && <span className="text-muted-foreground/70 text-[10px] tabular-nums">{g.liveCount} live</span>}
        </span>
      </button>
      {!collapsed && (
        <ul>
          {g.roots.map((r) => (
            <li key={r.id}>
              <RootRow
                s={r}
                selected={selectedRootId === r.id}
                current={selectedSessionId === r.id}
                hovered={hover === r.id}
                onHover={setHover}
                now={now}
              />
              {selectedRootId === r.id && <Cast rootId={r.id} selectedId={selectedSessionId} now={now} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ───────────────────────────── orchestrations ───────────────────────────── */

function runHealth(run: OrchRun, coordLive: boolean, now: number): 'active' | 'silent' | 'finished' {
  const done = (run.statusCounts.completed ?? 0) + (run.statusCounts.failed ?? 0)
  if (run.taskCount > 0 && done >= run.taskCount) return 'finished'
  if (coordLive) return 'active'
  const last = run.lastActivityAt ?? run.updatedAt
  return last != null && now - last < 5 * 60_000 ? 'active' : 'silent'
}

function RunRow({ run, now }: { run: OrchRun; now: number }) {
  const selectRun = useOcc((o) => o.selectRun)
  const setView = useOcc((o) => o.setView)
  const selected = useOcc((o) => o.ui.selectedRunId === run.id)
  const coordLive = useOcc((o) => (run.coordinatorSessionId ? !!o.sessions[run.coordinatorSessionId]?.live : false))
  const health = runHealth(run, coordLive, now)
  const done = run.statusCounts.completed ?? 0
  const failed = run.statusCounts.failed ?? 0
  const handle = run.coordinatorHandle ? (run.coordinatorHandle.length > 14 ? run.coordinatorHandle.slice(0, 14) : run.coordinatorHandle) : null
  return (
    <button
      type="button"
      data-testid="rail-run-row"
      data-run-id={run.id}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${run.objective}, ${health}${run.hasBlockingGate ? ', blocking gate' : ''}`}
      onClick={() => { selectRun(run.id); setView('dag') }}
      className={cn('focus-ring hover:bg-accent/60 relative w-full rounded-lg py-2 pr-2.5 pl-3 text-left', selected && 'bg-selection-soft/70 border-selection/25 border')}
    >
      <span className="flex items-center gap-2">
        {health === 'active' ? <LiveDot live size={8} /> : (
          <span data-testid="run-health" data-health={health} className={cn('inline-flex size-2 shrink-0 rounded-full', health === 'silent' ? 'bg-status-blocked' : 'bg-muted-foreground/40')} />
        )}
        <span className="truncate text-[13px] font-semibold">{run.objective}</span>
        {run.hasBlockingGate && <OctagonAlert size={14} className="text-status-gate ml-auto shrink-0" aria-label="Blocking gate" />}
      </span>
      {handle && <span className="text-muted-foreground/80 block truncate pl-4 font-mono text-[10.5px]">{handle}</span>}
      <span className="text-muted-foreground block truncate pl-4 text-[11px]">
        {run.taskCount} tasks · {done} done / {failed} failed
      </span>
    </button>
  )
}

function Orchestrations({ now }: { now: number }) {
  const orch = useOcc((o) => o.orchestration)
  const [open, setOpen] = useState(true)
  if (!orch?.available || orch.runs.length === 0) return null
  const Chev = open ? ChevronDown : ChevronRight
  return (
    <section aria-label="Orchestrations" className="border-panel-border/60 border-t p-1.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="focus-ring flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left">
        <Chev size={12} className="text-muted-foreground/70" aria-hidden />
        <SectionLabel>Orchestrations</SectionLabel>
        <span className="text-muted-foreground/70 ml-auto text-[11px] tabular-nums">{orch.runs.length}</span>
      </button>
      {open && (
        <ul className="max-h-60 overflow-y-auto">
          {orch.runs.map((r) => <li key={r.id}><RunRow run={r} now={now} /></li>)}
        </ul>
      )}
    </section>
  )
}

/* ───────────────────────────── rail ───────────────────────────── */

export function Rail() {
  const groups = useOcc(selectWorkspaceGroups)
  const sessions = useOcc((s) => s.sessions)
  const liveOnly = useOcc((s) => s.ui.liveOnly)
  const harness = useOcc((s) => s.ui.harnessFilter)
  const query = useOcc((s) => s.ui.railQuery)
  const setLiveOnly = useOcc((s) => s.setLiveOnly)
  const setHarness = useOcc((s) => s.setHarnessFilter)
  const setQuery = useOcc((s) => s.setRailQuery)
  const now = useNow(10_000)
  const harnesses = useMemo(() => harnessesOf(sessions), [sessions])
  const total = useMemo(() => groups.reduce((n, g) => n + g.roots.length, 0), [groups])
  const hasAnyRoot = useMemo(() => Object.values(sessions).some((s) => s.parentId == null), [sessions])

  const clearFilters = () => { setLiveOnly(false); setHarness('all'); setQuery('') }

  let empty: React.ReactNode = null
  if (total === 0) {
    if (!hasAnyRoot) empty = <EmptyState title="No agent sessions in the last 24 h." />
    else if (query.trim()) empty = <EmptyState title="No sessions match your search.">
      <button type="button" className="focus-ring text-selection text-[11px] underline" onClick={() => setQuery('')}>Clear search</button>
    </EmptyState>
    else if (liveOnly) empty = <EmptyState title="Nothing live right now.">
      <button type="button" className="focus-ring text-selection text-[11px] underline" onClick={() => setLiveOnly(false)}>Show all</button>
    </EmptyState>
    else empty = <EmptyState title="No sessions match the filters.">
      <button type="button" className="focus-ring text-selection text-[11px] underline" onClick={clearFilters}>Clear filters</button>
    </EmptyState>
  }

  return (
    <motion.nav
      aria-label="Fleet"
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="panel flex h-full w-full flex-col overflow-hidden"
    >
      <div className="panel-header flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SectionLabel>Fleet</SectionLabel>
            <span data-testid="rail-count" className="text-muted-foreground/70 text-[11px] tabular-nums">{total}</span>
          </div>
          <FleetViewButton />
        </div>
        <input
          id={RAIL_SEARCH_ID}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur() } }}
          placeholder="Search sessions…"
          aria-label="Search sessions"
          className="focus-ring border-panel-border/70 h-7 rounded-md border bg-transparent px-2 text-[11px]"
        />
        <Segmented
          aria-label="Live filter"
          layoutId="rail-live-seg"
          value={liveOnly ? 'live' : 'all'}
          onChange={(v) => setLiveOnly(v === 'live')}
          options={[{ value: 'all', label: 'All' }, { value: 'live', label: 'Live' }]}
        />
        {harnesses.length > 0 && (
          <div role="group" aria-label="Harness filter" className="flex flex-wrap gap-1">
            {(['all', ...harnesses] as const).map((h) => (
              <button
                key={h}
                type="button"
                aria-pressed={harness === h}
                onClick={() => setHarness(h)}
                className={cn(
                  'focus-ring text-muted-foreground flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]',
                  harness === h ? 'bg-selection-soft/70 border-selection/40 text-foreground' : 'border-panel-border/70 hover:bg-accent/60',
                )}
              >
                {h !== 'all' && <HarnessTile harness={h} size={17} className="!size-3.5 !text-[7px]" />}
                {h === 'all' ? 'All' : HARNESS_META[h].label}
              </button>
            ))}
          </div>
        )}
      </div>
      {empty ? (
        <div className="min-h-0 flex-1">{empty}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {groups.map((g) => <Group key={g.workspace.key} g={g} now={now} />)}
        </div>
      )}
      <Orchestrations now={now} />
    </motion.nav>
  )
}

/** Opens the Fleet DAG view; lives in the rail header instead of the center view tabs. */
function FleetViewButton() {
  const active = useOcc((s) => s.ui.view === 'fleet')
  const setView = useOcc((s) => s.setView)
  return (
    <button
      type="button"
      data-testid="rail-fleet-view"
      aria-pressed={active}
      title="Fleet view (1)"
      onClick={() => setView('fleet')}
      className={cn(
        'focus-ring flex h-6 items-center gap-1 rounded-md border px-2 text-[11px]',
        active ? 'border-selection/60 bg-selection/15 text-foreground' : 'border-panel-border/70 text-muted-foreground hover:text-foreground',
      )}
    >
      <Network size={12} /> Fleet view
    </button>
  )
}
