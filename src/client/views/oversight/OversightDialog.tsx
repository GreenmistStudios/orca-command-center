import { Dialog } from 'radix-ui'
import { GitBranch, LayoutGrid, Network, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { OrchRun } from '../../../shared/contract'
import { cn } from '../../lib/cn'
import { formatCost, formatRelative, shortModel } from '../../lib/format'
import { useOcc } from '../../state/store'
import { EmptyState, HarnessTile, IconButton, Kbd, Segmented, StateDot, STATE_LABEL, stateTone, toneClasses } from '../../ui'
import { useClock } from '../timeline/useClock'
import { buildOversight, type OversightAgent, type OversightRepo, type OversightRun, type OversightWorktree } from './model'

type Scope = 'active' | 'all'

/** Birds-eye board of every repo, worktree and root agent (`ui.oversightOpen`, header button or `o`). */
export function OversightDialog() {
  const open = useOcc((s) => s.ui.oversightOpen)
  const setOpen = useOcc((s) => s.setOversightOpen)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="oversight"
          className="panel bg-panel-solid fixed inset-3 z-50 flex flex-col overflow-hidden outline-none sm:inset-6"
        >
          {open && <OversightBoard onClose={() => setOpen(false)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function OversightBoard({ onClose }: { onClose: () => void }) {
  const sessions = useOcc((s) => s.sessions)
  const worktrees = useOcc((s) => s.orca?.worktrees)
  const runs = useOcc((s) => s.orchestration?.runs)
  const attention = useOcc((s) => s.attention)
  const windowMs = useOcc((s) => s.meta?.windowMs ?? 24 * 3600_000)
  const harnessFilter = useOcc((s) => s.ui.harnessFilter)
  const selectRoot = useOcc((s) => s.selectRoot)
  const selectRun = useOcc((s) => s.selectRun)
  const setView = useOcc((s) => s.setView)
  const now = useClock(15_000)
  const [scope, setScope] = useState<Scope>('active')

  const o = useMemo(
    () => buildOversight(
      { sessions, worktrees: worktrees ?? [], runs: runs ?? [], attention, now, windowMs },
      { scope, harness: harnessFilter === 'all' ? null : harnessFilter },
    ),
    [sessions, worktrees, runs, attention, now, windowMs, scope, harnessFilter],
  )

  const openAgent = (id: string) => { selectRoot(id); setView('dag'); onClose() }
  const openRun = (id: string) => { selectRun(id); setView('dag'); onClose() }
  const t = o.totals

  return (
    <>
      <div className="border-panel-border/70 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
        <LayoutGrid size={16} className="text-muted-foreground" />
        <Dialog.Title className="text-sm font-semibold">Oversight</Dialog.Title>
        <div data-testid="oversight-totals" className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span><b className="text-foreground tabular-nums">{t.repos}</b> repos</span>
          <span><b className="text-foreground tabular-nums">{t.worktrees}</b> worktrees</span>
          <span><b className="text-foreground tabular-nums">{t.agents}</b> agents</span>
          <span className="opacity-40">·</span>
          <Count tone="dispatched" n={t.working} label="working" />
          <Count tone="gate" n={t.needsYou} label="needs you" strong={t.needsYou > 0} />
          <Count tone="failed" n={t.error} label="error" hideZero />
          <Count tone="pending" n={t.idle} label="idle" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {harnessFilter !== 'all' && <span className="text-muted-foreground flex items-center gap-1 text-[11px]"><HarnessTile harness={harnessFilter} />only</span>}
          <Segmented<Scope>
            aria-label="Oversight scope"
            layoutId="oversight-scope"
            value={scope}
            onChange={setScope}
            options={[{ value: 'active', label: 'Active', title: 'Live, recent or needing you' }, { value: 'all', label: 'All', title: 'Everything in the window' }]}
          />
          <span className="text-muted-foreground hidden items-center gap-1 text-[10px] md:flex"><Kbd>o</Kbd> toggle</span>
          <Dialog.Close asChild><IconButton aria-label="Close oversight"><X size={14} /></IconButton></Dialog.Close>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {o.repos.length === 0 ? (
          <EmptyState icon={<LayoutGrid size={20} />} title="No agents to show" hint={scope === 'active' ? 'Nothing live or recent. Switch to All to see everything in the window.' : 'No sessions in the window.'} />
        ) : (
          <div data-testid="oversight-grid" className="grid grid-cols-[repeat(auto-fill,minmax(22rem,1fr))] items-start gap-3">
            {o.repos.map((r) => <RepoCard key={r.id} repo={r} now={now} onAgent={openAgent} onRun={openRun} />)}
          </div>
        )}
      </div>
    </>
  )
}

function Count({ tone, n, label, strong, hideZero }: { tone: Parameters<typeof toneClasses>[0]; n: number; label: string; strong?: boolean; hideZero?: boolean }) {
  if (hideZero && n === 0) return null
  return (
    <span className={cn('flex items-center gap-1.5', strong && 'text-status-gate-ink font-medium')}>
      <span className={cn('size-1.5 rounded-full', toneClasses(tone).dot)} /><b className="tabular-nums">{n}</b> {label}
    </span>
  )
}

function RepoCard({ repo, now, onAgent, onRun }: { repo: OversightRepo; now: number; onAgent: (id: string) => void; onRun: (id: string) => void }) {
  const c = repo.counts
  const tone = c.needsYou > 0 ? 'gate' : stateTone(repo.state)
  return (
    <section
      data-testid="oversight-repo"
      data-repo={repo.name}
      aria-label={`Repository ${repo.name}`}
      className={cn('bg-panel border-panel-border flex flex-col overflow-hidden rounded-lg border', c.needsYou > 0 && toneClasses('gate').border)}
    >
      <header className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', toneClasses(tone).dot)} />
        <h3 className="min-w-0 truncate text-[13px] font-semibold" title={repo.name}>{repo.name}</h3>
        <div className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2 text-[10px] tabular-nums">
          {c.working > 0 && <span className={toneClasses('dispatched').text}>{c.working} working</span>}
          {c.needsYou > 0 && <span className="text-status-gate-ink font-medium">{c.needsYou} needs you</span>}
          <span>{repo.worktrees.length} wt</span>
        </div>
      </header>
      <ul className="flex flex-col">
        {repo.worktrees.map((w) => <WorktreeRow key={w.id} wt={w} now={now} onAgent={onAgent} onRun={onRun} />)}
      </ul>
    </section>
  )
}

function WorktreeRow({ wt, now, onAgent, onRun }: { wt: OversightWorktree; now: number; onAgent: (id: string) => void; onRun: (id: string) => void }) {
  const empty = wt.agents.length === 0 && wt.runs.length === 0
  return (
    <li data-testid="oversight-worktree" className="border-panel-border/60 border-t px-3 py-2">
      <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-[11px]">
        <GitBranch size={11} className="shrink-0" />
        <span className="text-foreground/90 min-w-0 truncate font-mono" title={wt.branch ?? wt.name}>{wt.branch ?? wt.name}</span>
        {wt.branch && wt.name !== wt.branch && <span className="min-w-0 truncate opacity-70">{wt.name}</span>}
        {wt.terminals > 0 && <span className="ml-auto shrink-0 tabular-nums">{wt.terminals} term</span>}
      </div>
      {empty ? (
        <div className="text-muted-foreground/70 text-[11px]">No agents</div>
      ) : (
        <div className="flex flex-col gap-1">
          {wt.agents.map((a) => <AgentChip key={a.session.id} a={a} now={now} onOpen={onAgent} />)}
          {wt.runs.map((r) => <RunChip key={r.run.id} r={r} onOpen={onRun} />)}
        </div>
      )}
    </li>
  )
}

function AgentChip({ a, now, onOpen }: { a: OversightAgent; now: number; onOpen: (id: string) => void }) {
  const s = a.session
  const meta = [s.agent, shortModel(s.model?.modelId)].filter(Boolean).join(' · ')
  const when = s.lastActivityAt ?? s.updatedAt
  return (
    <button
      type="button"
      data-testid="oversight-agent"
      data-session-id={s.id}
      data-state={s.state}
      onClick={() => onOpen(s.id)}
      title={`${s.title}\n${STATE_LABEL[s.state]}${meta ? ` · ${meta}` : ''}`}
      className={cn(
        'focus-ring hover:bg-accent/60 grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px]',
        a.needsYou && 'bg-status-gate-soft/60',
      )}
    >
      <StateDot state={s.state} />
      <HarnessTile harness={s.harness} />
      <span className="min-w-0">
        <span className="block truncate">{s.title || 'Untitled'}</span>
        <span className="text-muted-foreground block truncate font-mono text-[10px]">
          {meta || '—'}
          {a.workingDescendants > 0 && <span className={cn('font-sans', toneClasses('dispatched').text)}> · <Network size={9} className="inline" /> {a.workingDescendants} working</span>}
        </span>
      </span>
      <span className="text-muted-foreground flex flex-col items-end text-[10px] tabular-nums">
        <span className={cn(a.needsYou && 'text-status-gate-ink font-medium')}>{a.needsYou ? 'needs you' : STATE_LABEL[s.state]}</span>
        <span>{when ? formatRelative(when, now) : ''}{s.cost > 0 ? ` · ${formatCost(s.cost)}` : ''}</span>
      </span>
    </button>
  )
}

const TERMINAL = new Set(['done', 'completed', 'failed', 'cancelled'])

function runTone(run: OrchRun): Parameters<typeof toneClasses>[0] {
  const entries = Object.entries(run.statusCounts).filter(([, n]) => n > 0)
  if (run.hasBlockingGate) return 'gate'
  if (entries.some(([s]) => !TERMINAL.has(s.toLowerCase()))) return 'dispatched'
  if (entries.some(([s]) => s.toLowerCase() === 'failed')) return 'failed'
  return 'completed'
}

function RunChip({ r, onOpen }: { r: OversightRun; onOpen: (id: string) => void }) {
  const run = r.run
  const done = Object.entries(run.statusCounts).filter(([s]) => ['done', 'completed'].includes(s.toLowerCase())).reduce((n, [, x]) => n + x, 0)
  return (
    <button
      type="button"
      data-testid="oversight-run"
      data-run-id={run.id}
      onClick={() => onOpen(run.id)}
      title={run.objective}
      className={cn('focus-ring hover:bg-accent/60 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px]', r.needsYou && 'bg-status-gate-soft/60')}
    >
      <span className={cn('size-2 shrink-0 rounded-sm', toneClasses(runTone(run)).dot)} />
      <span className="text-muted-foreground text-[9px] font-semibold tracking-wide uppercase">Run</span>
      <span className="min-w-0 flex-1 truncate">{run.objective}</span>
      <span className={cn('text-muted-foreground shrink-0 text-[10px] tabular-nums', r.needsYou && 'text-status-gate-ink font-medium')}>
        {r.needsYou ? 'needs you' : `${done}/${run.taskCount} tasks`}
      </span>
    </button>
  )
}
