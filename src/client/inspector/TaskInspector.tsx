import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { OrchDispatch } from '../../shared/contract'
import { cn } from '../lib/cn'
import { useOcc } from '../state/store'
import { Badge, Button, CopyButton, Duration, IconButton, RelativeTime, StatusPill, orchStatusTone, toneClasses } from '../ui'
import { ErrorBox, PreBlock, Section, Skeleton } from './common'

function TaskChip({ id, title }: { id: string; title?: string }) {
  const selectTask = useOcc((s) => s.selectTask)
  return <button type="button" className="chip focus-ring" onClick={() => selectTask(id)}>{title ? `${id} · ${title}` : id}</button>
}

function DispatchTimeline({ dispatches }: { dispatches: OrchDispatch[] }) {
  const selectSession = useOcc((s) => s.selectSession)
  if (!dispatches.length) return <div className="text-muted-foreground text-[11px]">No dispatch attempts.</div>
  return (
    <ol className="m-0 list-none p-0" data-testid="dispatch-timeline">
      {dispatches.map((d, i) => {
        const tone = orchStatusTone(d.status)
        return (
          <li key={d.id} className="relative flex gap-2 pb-3 last:pb-0">
            {i < dispatches.length - 1 && <span className="bg-panel-border absolute top-3 bottom-0 left-[4px] w-px" aria-hidden />}
            <span className={cn('mt-1 size-[9px] shrink-0 rounded-full', toneClasses(tone).dot)} aria-hidden />
            <div className="min-w-0 flex-1 text-[11px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusPill tone={tone}>{d.status}</StatusPill>
                <span className="text-muted-foreground">attempt {i + 1}</span>
                {d.assigneeSessionId ? (
                  <Button variant="subtle" className="h-5 px-1.5 font-mono" onClick={() => selectSession(d.assigneeSessionId)}>{d.assigneeHandle ?? d.assigneeSessionId}</Button>
                ) : d.assigneeHandle ? <span className="font-mono">{d.assigneeHandle}</span> : null}
              </div>
              <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                {d.dispatchedAt != null && <span>dispatched <RelativeTime ts={d.dispatchedAt} /></span>}
                {d.completedAt != null && <span>completed <RelativeTime ts={d.completedAt} /></span>}
                {d.lastHeartbeatAt != null && <span>heartbeat <RelativeTime ts={d.lastHeartbeatAt} /></span>}
              </div>
              {d.failureCount > 0 && <div className="text-status-failed-ink">{d.failureCount} failure{d.failureCount > 1 ? 's' : ''}{d.lastFailure ? ` · ${d.lastFailure}` : ''}</div>}
              {d.terminationReason && <div className="text-muted-foreground">Termination: {d.terminationReason}</div>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** Orchestration task inspector (orca-viz parity). */
export function TaskInspector({ taskId }: { taskId: string }) {
  const entry = useOcc((s) => s.tasks[taskId])
  const fetchTask = useOcc((s) => s.fetchTask)
  const fetchRun = useOcc((s) => s.fetchRun)
  const selectTask = useOcc((s) => s.selectTask)
  const orchestration = useOcc((s) => s.orchestration)
  const detail = entry?.data ?? null
  const runId = detail?.task.runId
  const run = useOcc((s) => (runId ? s.runs[runId]?.data : null))

  useEffect(() => { void fetchTask(taskId) }, [taskId, fetchTask])
  useEffect(() => { if (runId) void fetchRun(runId) }, [runId, fetchRun])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    void fetchTask(taskId, { force: true })
  }, [orchestration, taskId, fetchTask])

  const close = <IconButton aria-label="Close task" onClick={() => selectTask(null)}><X size={14} /></IconButton>
  if (!detail) {
    if (entry?.status === 'error') return <div className="flex h-full flex-col"><div className="flex justify-end p-2">{close}</div><ErrorBox message={entry.error ?? 'Task not found'} onRetry={() => void fetchTask(taskId, { force: true })} /></div>
    return <div className="flex h-full flex-col"><div className="flex justify-end p-2">{close}</div><Skeleton /></div>
  }
  const { task } = detail
  const tone = orchStatusTone(task.status)
  const blocks = (run?.tasks ?? []).filter((t) => t.deps.includes(task.id))
  const lastDone = detail.dispatches.map((d) => d.completedAt).filter((x): x is number => x != null).sort().pop() ?? null
  const titleOf = (id: string) => run?.tasks.find((t) => t.id === id)?.title

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="task-inspector">
      <header className="border-panel-border/60 border-b p-3" style={{ background: `color-mix(in oklch, ${toneClasses(tone).accentVar} 8%, transparent)` }}>
        <div className="flex items-start justify-between gap-2">
          <h2 className="m-0 text-[13px] leading-tight font-semibold">{task.title}</h2>
          {close}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          <StatusPill tone={tone}>{task.status}</StatusPill>
          <Badge>{task.attemptCount} attempt{task.attemptCount === 1 ? '' : 's'}</Badge>
          {task.createdAt != null && <Duration start={task.createdAt} end={task.completedAt ?? (task.status === 'completed' || task.status === 'failed' ? lastDone : null)} className="text-muted-foreground tabular-nums" />}
          <span className="text-muted-foreground inline-flex items-center gap-0.5 font-mono">{task.id}<CopyButton text={task.id} label="Copy task id" className="size-5" /></span>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Spec"><PreBlock text={detail.spec || task.specPreview} copy={false} /></Section>
        <Section title="Result">
          {detail.result ? <PreBlock text={detail.result} /> : <div className="text-muted-foreground text-[11px]">No result yet.</div>}
        </Section>
        <Section title={`Dispatch attempts (${detail.dispatches.length})`}><DispatchTimeline dispatches={detail.dispatches} /></Section>
        <Section title={`Messages (${detail.messages.length})`}>
          {detail.messages.length === 0 ? <div className="text-muted-foreground text-[11px]">No messages.</div> : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {detail.messages.map((m) => (
                <li key={m.id} className="text-[11px]">
                  <div className="flex items-center gap-1.5"><Badge variant="mono">{m.type}</Badge><span className="font-medium">{m.subject}</span></div>
                  <div className="text-muted-foreground">{m.from} → {m.to}{m.createdAt != null && <> · <RelativeTime ts={m.createdAt} /></>}</div>
                  {m.bodyPreview && <div className="text-foreground/80 mt-0.5 break-words">{m.bodyPreview}</div>}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={`Gates (${detail.gates.length})`}>
          {detail.gates.length === 0 ? <div className="text-muted-foreground text-[11px]">No gates.</div> : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {detail.gates.map((g) => (
                <li key={g.id} className="border-panel-border/60 rounded-lg border p-2 text-[11px]">
                  <div className="flex items-center gap-1.5"><StatusPill tone={g.blocking ? 'gate' : 'completed'}>{g.status}</StatusPill><span className="font-medium">{g.question}</span></div>
                  {g.options.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{g.options.map((o) => <Badge key={o} variant={o === g.resolution ? 'solid' : 'outline'}>{o}</Badge>)}</div>}
                  {g.resolution && <div className="text-muted-foreground mt-1">Resolution: {g.resolution}</div>}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Depends on">
          {task.deps.length ? <div className="flex flex-wrap gap-1">{task.deps.map((d) => <TaskChip key={d} id={d} title={titleOf(d)} />)}</div> : <div className="text-muted-foreground text-[11px]">None.</div>}
        </Section>
        <Section title="Blocks">
          {blocks.length ? <div className="flex flex-wrap gap-1">{blocks.map((t) => <TaskChip key={t.id} id={t.id} title={t.title} />)}</div> : <div className="text-muted-foreground text-[11px]">None.</div>}
        </Section>
      </div>
    </div>
  )
}
