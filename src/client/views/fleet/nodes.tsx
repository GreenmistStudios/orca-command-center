import { Handle, Position, type NodeProps } from '@xyflow/react'
import { GitBranch, Network } from 'lucide-react'
import { memo, type KeyboardEvent, type ReactNode } from 'react'
import { HARNESS_META } from '../../../shared/contract'
import { cn } from '../../lib/cn'
import { formatCost, formatRelative, shortModel } from '../../lib/format'
import { agentColorVar, HarnessTile, IconButton, orchStatusTone, StateDot, STATE_LABEL, stateTone, toneClasses } from '../../ui'
import type { Direction } from '../dag/model'
import type { FleetCounts, FleetNodeData } from './model'

export interface FleetRenderData extends Record<string, unknown> {
  d: FleetNodeData
  selected: boolean
  direction: Direction
  now: number
  onActivate: (id: string) => void
  onOpen: (id: string) => void
}

function Handles({ direction }: { direction: Direction }) {
  const [t, s] = direction === 'RIGHT' ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom]
  return (
    <>
      <Handle type="target" position={t} isConnectable={false} className="!opacity-0" />
      <Handle type="source" position={s} isConnectable={false} className="!opacity-0" />
    </>
  )
}

const ring = 'outline-2 outline-offset-2 outline-[var(--status-gate)]'

interface ShellProps {
  kind: string
  data: FleetRenderData
  label: string
  needsYou: boolean
  className?: string
  tone?: string
  style?: React.CSSProperties
  children: ReactNode
}
function Shell({ kind, data, label, needsYou, className, style, children }: ShellProps) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); data.onActivate(data.d.id) }
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      data-testid={`fleet-node-${kind}`}
      data-node-id={data.d.id}
      data-needs-you={needsYou || undefined}
      data-selected={data.selected || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        'relative flex flex-col gap-1 rounded-xl border py-2 pr-2.5 pl-3 text-[11px]',
        needsYou && ring,
        data.selected && 'outline-selection outline-2 outline-offset-2',
        className,
      )}
      style={{ boxShadow: 'inset 0 1px 0 0 var(--sheen), var(--lift-2)', ...style }}
    >
      <Handles direction={data.direction} />
      {children}
    </div>
  )
}

function Chips({ c }: { c: FleetCounts }) {
  return (
    <div className="flex gap-1.5 text-[9.5px] tabular-nums">
      {c.working > 0 && <span className="text-status-dispatched-ink">{c.working} working</span>}
      {c.needsYou > 0 && <span className="text-status-gate-ink font-semibold">{c.needsYou} needs you</span>}
      {c.error > 0 && <span className="text-status-failed-ink">{c.error} error</span>}
      <span className="opacity-70">{c.live} live</span>
    </div>
  )
}

function ProjectNodeImpl({ data }: NodeProps) {
  const r = data as FleetRenderData
  const d = r.d as Extract<FleetNodeData, { kind: 'project' }>
  const tc = toneClasses(stateTone(d.state))
  return (
    <Shell kind="project" data={r} needsYou={d.counts.needsYou > 0} label={`Project ${d.name}, ${d.worktreeCount} worktrees, ${STATE_LABEL[d.state]}${d.collapsed ? ', collapsed' : ''}`} className={cn('bg-panel-solid border-2', tc.border)} style={{ width: 240, height: 84 }}>
      <div className="flex items-center gap-2">
        <StateDot state={d.state} />
        <span className="truncate text-[13px] font-semibold">{d.name}</span>
        <span className="text-muted-foreground ml-auto text-[9.5px]">{d.collapsed ? '▸' : '▾'} {d.worktreeCount} wt</span>
      </div>
      <div className="mt-auto"><Chips c={d.counts} /></div>
    </Shell>
  )
}

function WorktreeNodeImpl({ data }: NodeProps) {
  const r = data as FleetRenderData
  const d = r.d as Extract<FleetNodeData, { kind: 'worktree' }>
  return (
    <Shell kind="worktree" data={r} needsYou={d.counts.needsYou > 0} label={`Worktree ${d.name}${d.branch ? `, branch ${d.branch}` : ''}, ${d.terminals} terminals`} className="bg-panel-solid" style={{ width: 240, height: 84 }}>
      <div className="flex items-center gap-1.5">
        <StateDot state={d.state} />
        <GitBranch size={11} className="opacity-60" />
        <span className="truncate font-mono text-[11px]">{d.branch ?? '—'}</span>
        <span className="text-muted-foreground ml-auto text-[9.5px]">{d.collapsed ? '▸' : '▾'}</span>
      </div>
      <div className="truncate text-[11px] font-medium">{d.name}</div>
      <div className="text-muted-foreground mt-auto flex gap-2 text-[9.5px]">
        <span>{d.terminals} terminal{d.terminals === 1 ? '' : 's'}</span>
        {d.lastActivityAt != null && <span>{formatRelative(d.lastActivityAt, r.now)}</span>}
      </div>
    </Shell>
  )
}

function SessionNodeImpl({ data }: NodeProps) {
  const r = data as FleetRenderData
  const d = r.d as Extract<FleetNodeData, { kind: 'session' }>
  const s = d.session
  const tc = toneClasses(stateTone(s.state))
  const subs = s.childIds.length
  return (
    <Shell kind="session" data={r} needsYou={d.needsYou} label={`Session ${s.title}, ${HARNESS_META[s.harness].label}, ${STATE_LABEL[s.state]}`} className={cn('pl-4', tc.surface)} style={{ width: 264, height: 96 }}>
      <span aria-hidden className="absolute top-2 bottom-2 left-1.5 w-[4px] rounded-full" style={{ background: agentColorVar(s.agent) }} />
      <div className="flex items-center gap-1.5">
        <HarnessTile harness={s.harness} />
        <StateDot state={s.state} />
        <span className="text-[9px] font-semibold tracking-wide uppercase">{STATE_LABEL[s.state]}</span>
        <span className="ml-auto text-[9px] tabular-nums">{formatCost(s.cost)}</span>
        <IconButton
          aria-label="Open tree"
          className="nodrag size-5"
          onClick={(e) => { e.stopPropagation(); r.onOpen(d.id) }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Network size={12} />
        </IconButton>
      </div>
      <div className="line-clamp-1 text-[11.5px] leading-snug font-medium">{s.title}</div>
      <div className="mt-auto truncate font-mono text-[9.5px] opacity-70">
        {[s.agent, shortModel(s.model?.modelId)].filter(Boolean).join(' · ') || '—'}
        {subs > 0 && ` · ${subs} subagent${subs === 1 ? '' : 's'} (${d.workingDescendants} working)`}
      </div>
    </Shell>
  )
}

function RunNodeImpl({ data }: NodeProps) {
  const r = data as FleetRenderData
  const d = r.d as Extract<FleetNodeData, { kind: 'run' }>
  const run = d.run
  const entries = Object.entries(run.statusCounts).filter(([, n]) => n > 0)
  const total = entries.reduce((a, [, n]) => a + n, 0)
  return (
    <Shell kind="run" data={r} needsYou={d.needsYou} label={`Run ${run.objective}`} className="bg-panel-solid border-dashed" style={{ width: 264, height: 96 }}>
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-semibold tracking-wide uppercase">Run</span>
        {run.hasBlockingGate && <span className="text-status-gate-ink text-[9px]">⚑ gate</span>}
      </div>
      <div className="line-clamp-2 text-[11.5px] leading-snug font-medium">{run.objective}</div>
      <div className="mt-auto flex h-1.5 overflow-hidden rounded-full bg-black/10" role="img" aria-label="Task status">
        {entries.map(([st, n]) => (
          <span key={st} title={`${st}: ${n}`} className={toneClasses(orchStatusTone(st)).dot} style={{ width: `${(n / total) * 100}%` }} />
        ))}
      </div>
    </Shell>
  )
}

function OverflowNodeImpl({ data }: NodeProps) {
  const r = data as FleetRenderData
  const d = r.d as Extract<FleetNodeData, { kind: 'overflow' }>
  return (
    <Shell kind="overflow" data={r} needsYou={false} label={`${d.hidden} more idle sessions`} className="text-muted-foreground items-center justify-center border-dashed" style={{ width: 160, height: 48 }}>
      +{d.hidden} idle sessions
    </Shell>
  )
}

export const nodeTypes = {
  project: memo(ProjectNodeImpl),
  worktree: memo(WorktreeNodeImpl),
  session: memo(SessionNodeImpl),
  run: memo(RunNodeImpl),
  overflow: memo(OverflowNodeImpl),
}
