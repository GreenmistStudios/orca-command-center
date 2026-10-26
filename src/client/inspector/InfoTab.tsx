import { HARNESS_META } from '../../shared/contract'
import { formatCost, formatCount } from '../lib/format'
import { useOcc } from '../state/store'
import { Button, RelativeTime } from '../ui'
import { KV, Section } from './common'

const T = ({ ts }: { ts: number | null | undefined }) => (ts ? <RelativeTime ts={ts} /> : <>—</>)

export function InfoTab({ sessionId }: { sessionId: string }) {
  const summary = useOcc((s) => s.sessions[sessionId])
  const detail = useOcc((s) => s.details[sessionId]?.data)
  const selectRun = useOcc((s) => s.selectRun)
  const selectTask = useOcc((s) => s.selectTask)
  const s = summary ?? detail?.session
  if (!s) return null
  const o = s.orca
  const goTask = (runId: string, taskId: string | null) => { selectRun(runId); if (taskId) selectTask(taskId) }
  return (
    <div data-testid="info-tab">
      <Section title="Identity">
        <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
          <KV k="Session id" copy={s.id}>{s.id}</KV>
          <KV k="Root id" copy={s.rootId}>{s.rootId}</KV>
          {s.parentId && <KV k="Parent id" copy={s.parentId}>{s.parentId}</KV>}
          <KV k="Harness">{HARNESS_META[s.harness].label}</KV>
          <KV k="Agent">{s.agent ?? '—'}</KV>
          <KV k="Model">{s.model ? `${s.model.providerId ? `${s.model.providerId}/` : ''}${s.model.modelId}` : '—'}</KV>
        </dl>
      </Section>
      <Section title="Workspace">
        <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
          <KV k="Directory" copy={s.directory ?? undefined}>{s.directory ?? '—'}</KV>
          <KV k="Workspace">{s.workspace?.name ?? '—'}</KV>
          <KV k="Repo">{s.workspace?.repo ?? '—'}</KV>
          <KV k="Branch">{s.workspace?.branch ?? '—'}</KV>
        </dl>
      </Section>
      <Section title="Time">
        <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
          <KV k="Created"><T ts={s.createdAt} /></KV>
          <KV k="Updated"><T ts={s.updatedAt} /></KV>
          <KV k="Last activity"><T ts={s.lastActivityAt} /></KV>
        </dl>
      </Section>
      <Section title="Usage">
        <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
          <KV k="Input">{formatCount(s.tokens.input)}</KV>
          <KV k="Output">{formatCount(s.tokens.output)}</KV>
          <KV k="Reasoning">{formatCount(s.tokens.reasoning)}</KV>
          <KV k="Cache read">{formatCount(s.tokens.cacheRead)}</KV>
          <KV k="Cache write">{formatCount(s.tokens.cacheWrite)}</KV>
          <KV k="Cost">{formatCost(s.cost)}</KV>
          {s.counters && Object.entries(s.counters).map(([k, v]) => <KV key={k} k={k}>{v}</KV>)}
        </dl>
      </Section>
      {s.facts.length > 0 && (
        <Section title="Facts"><dl className="m-0 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">{s.facts.map((f) => <KV key={f.label} k={f.label}>{f.value}</KV>)}</dl></Section>
      )}
      {o && (
        <Section title="Orca">
          <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
            <KV k="Worktree">{o.worktreeId ?? '—'}</KV>
            <KV k="Terminal">{o.terminalHandle ?? '—'}{o.terminalTitle ? ` · ${o.terminalTitle}` : ''}</KV>
            <KV k="Pane key">{o.paneKey ?? '—'}</KV>
            <KV k="Hook">{o.hookEvent ?? '—'}{o.hookState ? ` · ${o.hookState}` : ''}{o.hookAt ? <> · <T ts={o.hookAt} /></> : null}</KV>
            {o.role && <KV k="Role">{o.role}</KV>}
          </dl>
          {o.runId && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Button variant="subtle" onClick={() => goTask(o.runId!, null)}>Run {o.runId}</Button>
              {o.taskId && <Button variant="subtle" onClick={() => goTask(o.runId!, o.taskId)}>Task {o.taskId}</Button>}
              {o.dispatchId && <span className="text-muted-foreground self-center font-mono text-[10px]">dispatch {o.dispatchId}</span>}
            </div>
          )}
        </Section>
      )}
      {s.spawn && (
        <Section title="Spawn">
          <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
            <KV k="Parent">{s.spawn.parentSessionId}</KV>
            <KV k="Type">{s.spawn.subagentType ?? '—'}</KV>
            <KV k="Description">{s.spawn.description}</KV>
            <KV k="Status">{s.spawn.status}</KV>
          </dl>
        </Section>
      )}
      <Section title="Provenance">
        <ul className="text-muted-foreground m-0 list-disc pl-4 text-[11px]">
          <li>state: {s.stateSource}</li>
          {(detail?.provenance ?? []).map((p) => <li key={p}>{p}</li>)}
        </ul>
      </Section>
    </div>
  )
}
