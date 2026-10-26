import { ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { HARNESS_META, type SessionSummary } from '../../shared/contract'
import { formatCost, formatRelative, formatTokens, shortModel } from '../lib/format'
import { selectSessionAncestors } from '../state/selectors'
import { useOcc } from '../state/store'
import { AgentMonogram, CopyButton, Duration, EmptyState, HarnessTile, IconButton, STATE_LABEL, StatusPill, Segmented, Tooltip, stateTone, toneClasses } from '../ui'
import { ErrorBox, Skeleton } from './common'
import { FilesTab } from './FilesTab'
import { InfoTab } from './InfoTab'
import { TodosTab } from './TodosTab'
import { Transcript } from './Transcript'

type Tab = 'activity' | 'files' | 'todos' | 'info'
const tabMemory: Record<'root' | 'subagent', Tab> = { root: 'activity', subagent: 'activity' }

export function provenanceText(s: SessionSummary, now = Date.now()): string {
  switch (s.stateSource) {
    case 'orca-hook': {
      const at = s.orca?.hookAt ?? s.stateSince
      return `from Orca hook${s.orca?.hookEvent ? ` · ${s.orca.hookEvent}` : ''}${at ? ` ${formatRelative(at, now)}` : ''}`
    }
    case 'transcript': return 'from transcript'
    case 'parent-tool': return 'from parent tool call'
    case 'orchestration': return 'from orchestration'
    default: return 'no state source'
  }
}

function Header({ s }: { s: SessionSummary }) {
  const ancestors = useOcc((st) => selectSessionAncestors(st, s.id))
  const selectSession = useOcc((st) => st.selectSession)
  const tone = stateTone(s.state)
  const tokens = s.tokens.input + s.tokens.output
  return (
    <header className="border-panel-border/60 border-b p-3" style={{ background: `color-mix(in oklch, ${toneClasses(tone).accentVar} 8%, transparent)` }} data-testid="inspector-header">
      {ancestors.length > 0 && (
        <nav aria-label="Ancestors" className="text-muted-foreground mb-1 flex flex-wrap items-center gap-0.5 text-[10px]">
          {ancestors.map((a) => (
            <span key={a.id} className="flex items-center gap-0.5">
              <button type="button" className="focus-ring hover:text-foreground max-w-[120px] truncate underline-offset-2 hover:underline" onClick={() => selectSession(a.id)}>{a.title}</button>
              <ChevronRight size={10} />
            </span>
          ))}
        </nav>
      )}
      <div className="flex items-start justify-between gap-2">
        <h2 className="m-0 text-[13px] leading-tight font-semibold break-words">{s.title}</h2>
        <IconButton aria-label="Close inspector" onClick={() => selectSession(null)}><X size={14} /></IconButton>
      </div>
      {s.current && s.live && (
        <div className="text-muted-foreground mt-1 truncate text-[11px]" data-testid="current-activity">
          <span className="text-foreground">{s.current.label}</span>{s.current.detail ? ` · ${s.current.detail}` : ''}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <Tooltip content={provenanceText(s)}>
          <span><StatusPill tone={tone}>{STATE_LABEL[s.state]}</StatusPill></span>
        </Tooltip>
        <span className="inline-flex items-center gap-1"><HarnessTile harness={s.harness} />{HARNESS_META[s.harness].label}</span>
        {s.agent && <span className="inline-flex items-center gap-1"><AgentMonogram agent={s.agent} size={17} />{s.agent}</span>}
        {s.model && <span className="font-mono">{shortModel(s.model.modelId)}</span>}
        <Duration start={s.createdAt} end={s.live ? null : s.lastActivityAt ?? s.updatedAt} className="text-muted-foreground tabular-nums" />
        <span className="text-muted-foreground tabular-nums">{formatTokens(tokens)} tok</span>
        <span className="text-muted-foreground tabular-nums">{formatCost(s.cost)}</span>
        <span className="text-muted-foreground inline-flex items-center gap-0.5 font-mono text-[10px]">{s.id.slice(0, 14)}<CopyButton text={s.id} label="Copy session id" className="size-5" /></span>
      </div>
    </header>
  )
}

export function SessionInspector({ id }: { id: string }) {
  const summary = useOcc((s) => s.sessions[id])
  const detailEntry = useOcc((s) => s.details[id])
  const fetchSessionDetail = useOcc((s) => s.fetchSessionDetail)
  const session = summary ?? detailEntry?.data?.session ?? null
  const kind = session && session.depth > 0 ? 'subagent' : 'root'
  const [tab, setTabState] = useState<Tab>(tabMemory[kind])
  const setTab = (t: Tab) => { tabMemory[kind] = t; setTabState(t) }

  useEffect(() => { void fetchSessionDetail(id) }, [id, fetchSessionDetail])

  // Refresh detail when updatedAt changes, throttled to once per 3 s.
  const updatedAt = summary?.updatedAt
  const lastFetch = useRef(0)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; lastFetch.current = Date.now(); return }
    const wait = Math.max(0, 3000 - (Date.now() - lastFetch.current))
    const t = setTimeout(() => { lastFetch.current = Date.now(); void fetchSessionDetail(id, { force: true }) }, wait)
    return () => clearTimeout(t)
  }, [updatedAt, id, fetchSessionDetail])

  if (!session) {
    if (detailEntry?.status === 'error') {
      return (
        <div className="flex h-full flex-col">
          <EmptyState title="Session not found" hint={`${id} is outside the loaded window or unknown.`} />
          <ErrorBox message={detailEntry.error ?? 'Failed to load session'} onRetry={() => void fetchSessionDetail(id, { force: true })} />
        </div>
      )
    }
    return <Skeleton lines={8} />
  }

  const detail = detailEntry?.data
  const todos = detail?.todos ?? []
  const done = todos.filter((t) => t.status === 'completed').length
  const files = detail?.fileChanges.length ?? session.counters?.filesTouched
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="session-inspector">
      <Header s={session} />
      <div className="px-3 py-1.5">
        <Segmented<Tab>
          aria-label="Inspector tabs"
          layoutId="inspector-tab"
          className="w-full"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'activity', label: 'Activity' },
            { value: 'files', label: 'Files', count: files },
            { value: 'todos', label: todos.length ? `Todos ${done}/${todos.length}` : 'Todos' },
            { value: 'info', label: 'Info' },
          ]}
        />
      </div>
      {detailEntry?.status === 'error' && <ErrorBox message={detailEntry.error ?? 'Failed to load details'} onRetry={() => void fetchSessionDetail(id, { force: true })} />}
      {tab === 'activity' && <Transcript sessionId={id} live={session.live} onOpenTodos={() => setTab('todos')} />}
      {tab !== 'activity' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!detail && tab !== 'info' ? <Skeleton /> : tab === 'files' ? <FilesTab sessionId={id} /> : tab === 'todos' ? <TodosTab sessionId={id} /> : <InfoTab sessionId={id} />}
        </div>
      )}
    </div>
  )
}
