import { BaseEdge, getBezierPath, Handle, Position, type EdgeProps, type NodeProps } from '@xyflow/react'
import { motion } from 'motion/react'
import { memo, useEffect, useRef, useState } from 'react'
import { HARNESS_META, type SessionSummary } from '../../../shared/contract'
import { cn } from '../../lib/cn'
import { formatCost, formatDuration, formatRelative } from '../../lib/format'
import { agentColorVar, AgentMonogram, STATE_LABEL, stateTone, toneClasses, useSpotlight } from '../../ui'
import type { Direction, TaskInfo } from './model'
import type { OrchTask } from '../../../shared/contract'

export interface SessionNodeData extends Record<string, unknown> {
  s: SessionSummary
  selected: boolean
  dimmed: boolean
  direction: Direction
  now: number
}

export interface TaskNodeData extends Record<string, unknown> {
  task: OrchTask
  info: TaskInfo
  assignee: { label: string; agent: string | null; key: string | null } | null
  selected: boolean
  direction: Direction
  now: number
}

const handles = (d: Direction) => (d === 'RIGHT' ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom])

function Handles({ direction }: { direction: Direction }) {
  const [t, s] = handles(direction)
  return (
    <>
      <Handle type="target" position={t} isConnectable={false} className="!opacity-0" />
      <Handle type="source" position={s} isConnectable={false} className="!opacity-0" />
    </>
  )
}

function SessionNodeImpl({ data }: NodeProps) {
  const { s, selected, dimmed, direction, now } = data as SessionNodeData
  const tone = stateTone(s.state)
  const tc = toneClasses(tone)
  const accent = tc.accentVar
  const spot = useSpotlight<HTMLDivElement>()
  const working = s.state === 'working'
  const prev = useRef(s.lastActivityAt)
  const [pulse, setPulse] = useState(0)
  useEffect(() => {
    if (prev.current !== s.lastActivityAt) { prev.current = s.lastActivityAt; setPulse((p) => p + 1) }
  }, [s.lastActivityAt])
  const glow = working || s.state === 'error' ? `0 0 24px -6px color-mix(in oklch, ${accent} calc(var(--glow-strength) * 100%), transparent), ` : ''
  const elapsed = formatDuration((s.live ? now : s.lastActivityAt ?? s.updatedAt) - (s.stateSince ?? s.createdAt))
  const c = s.counters
  return (
    <motion.div
      ref={spot.ref}
      onPointerMove={spot.onPointerMove}
      whileHover={{ y: -2 }}
      data-testid="session-node"
      data-session-id={s.id}
      data-state={s.state}
      className={cn(
        'group relative flex flex-col gap-1 rounded-xl border py-2 pr-2.5 pl-4 text-[11px]', tc.surface,
        selected && 'outline-selection outline-2 outline-offset-2', dimmed && 'opacity-30',
      )}
      style={{ width: 264, height: 96, boxShadow: `${glow}inset 0 1px 0 0 var(--sheen), var(--lift-2)` }}
    >
      <Handles direction={direction} />
      {working && <span className="orca-alive pointer-events-none" aria-hidden />}
      {pulse > 0 && (
        <span
          key={pulse}
          aria-hidden
          className="pointer-events-none absolute -inset-[3px] rounded-[17px]"
          style={{ animation: 'orca-pulse 1s ease-out 1', ['--orca-pulse' as string]: accent }}
        />
      )}
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-xl" style={{ background: `linear-gradient(to right, color-mix(in oklch, ${accent} 20%, transparent), transparent 62%)` }} />
      <span aria-hidden className="absolute top-2 bottom-2 left-1.5 w-[4px] rounded-full" style={{ background: agentColorVar(s.agent) }} />
      <div className="relative flex items-center gap-1.5">
        <AgentMonogram agent={s.agent} size={17} />
        <span className="text-[9px] font-semibold tracking-wide uppercase">{STATE_LABEL[s.state]}</span>
        <span className="text-muted-foreground font-mono text-[9px]">{HARNESS_META[s.harness].monogram}</span>
        {c && c.toolErrors > 0 && <span className="text-status-failed text-[9px]">✗{c.toolErrors}</span>}
        <span className="ml-auto text-[9px] tabular-nums">{elapsed}</span>
      </div>
      <div className="relative line-clamp-2 text-[11.5px] leading-snug font-medium">{s.title}</div>
      <div className="relative mt-auto truncate font-mono text-[9.5px] opacity-70">
        {s.live && s.current
          ? `▸ ${s.current.label}${s.current.detail ? ` · ${s.current.detail}` : ''}`
          : c ? `${c.tools} tools · ${c.fileChanges} files · ${formatCost(s.cost)}` : formatCost(s.cost)}
      </div>
    </motion.div>
  )
}
export const SessionNode = memo(SessionNodeImpl)

function TaskNodeImpl({ data }: NodeProps) {
  const { task, info, assignee, selected, direction, now } = data as TaskNodeData
  const tc = toneClasses(info.tone)
  const stale = info.lastSeen !== null && (info.tone === 'dispatched') && now - info.lastSeen > 10 * 60_000
  return (
    <div
      data-testid="task-node"
      data-task-id={task.id}
      className={cn(
        'relative flex flex-col gap-1 rounded-xl border py-2 pr-2.5 pl-4 text-[11px]', tc.surface,
        selected && 'outline-selection outline-2 outline-offset-2',
      )}
      style={{ width: 240, height: 84, boxShadow: 'inset 0 1px 0 0 var(--sheen), var(--lift-2)' }}
    >
      <Handles direction={direction} />
      <span aria-hidden className="absolute top-2 bottom-2 left-1.5 w-[4px] rounded-full" style={{ background: agentColorVar(assignee?.key ?? null) }} />
      <div className="flex items-center gap-1.5">
        {assignee && (assignee.agent
          ? <AgentMonogram agent={assignee.agent} size={17} />
          : <span className="monogram text-[8.5px]" style={{ width: 17, height: 17, background: agentColorVar(assignee.key), color: 'var(--agent-ink)' }}>{assignee.label}</span>)}
        <span className="text-[9px] font-semibold tracking-wide uppercase">{info.status.replace('_', ' ')}</span>
        {info.gate && <span className="text-status-gate-ink text-[9px]" title={info.gate.question}>⚑ gate</span>}
        {info.attempts > 1 && <span className="text-[9px]">↻{info.attempts}</span>}
        {info.failures > 0 && <span className="text-status-failed ml-auto text-[9px]">✗{info.failures}</span>}
      </div>
      <div className="line-clamp-2 text-[11.5px] leading-snug font-medium">{task.title}</div>
      {info.lastSeen !== null && (
        <div className={cn('mt-auto text-[9px] opacity-70', stale && 'text-amber-500 font-bold opacity-100')}>
          last seen {formatRelative(info.lastSeen, now)}
        </div>
      )}
    </div>
  )
}
export const TaskNode = memo(TaskNodeImpl)

export interface DagEdgeData extends Record<string, unknown> { label: string | null; style: { stroke: string; strokeWidth: number; strokeDasharray?: string; opacity: number } }

export function DagEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps) {
  const d = data as DagEdgeData | undefined
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={d?.style} />
      <path d={path} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke">
        {d?.label && <title>{d.label}</title>}
      </path>
    </>
  )
}

export const nodeTypes = { session: SessionNode, task: TaskNode }
export const edgeTypes = { dag: DagEdge }
