import { Brain, ChevronDown, ChevronRight, FileText, Paperclip } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { LIMITS, type ActivityEvent, type TranscriptMessage } from '../../shared/contract'
import { cn } from '../lib/cn'
import { formatClock, formatCost, formatDuration, formatTokens, shortPath } from '../lib/format'
import { useOcc } from '../state/store'
import { AgentMonogram, KindIcon, Markdownish, Spinner, StatusGlyph, ToolBadge } from '../ui'
import { ErrorBox, PreBlock } from './common'
import { ChangeDiff } from './FilesTab'
import { TodoRow } from './TodosTab'

const dur = (e: ActivityEvent) => (e.endTs != null ? formatDuration(e.endTs - e.ts) : null)

function useDetail(ref: string | null, enabled: boolean) {
  const entry = useOcc((s) => (ref ? s.parts[ref] : undefined))
  const fetchPart = useOcc((s) => s.fetchPart)
  useEffect(() => { if (enabled && ref) void fetchPart(ref) }, [enabled, ref, fetchPart])
  return entry
}

function Expander({ open, onToggle, children, label }: { open: boolean; onToggle: () => void; children: ReactNode; label: string }) {
  return (
    <button type="button" aria-expanded={open} aria-label={label} onClick={onToggle} className="focus-ring hover:bg-accent flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left">
      {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
      {children}
    </button>
  )
}

const card = 'border-panel-border/60 bg-panel-solid/60 rounded-lg border text-[11px]'

function Thinking({ e }: { e: ActivityEvent }) {
  const [open, setOpen] = useState(false)
  const truncated = (e.summary?.length ?? 0) >= LIMITS.summaryChars - 5
  const part = useDetail(e.detailRef, open && truncated)
  const text = part?.data?.text ?? e.summary ?? ''
  const first = (e.summary ?? '').split('\n')[0]
  return (
    <div className="text-muted-foreground text-[11px]" data-testid="item-thinking">
      <Expander open={open} onToggle={() => setOpen((o) => !o)} label="Toggle thinking">
        <Brain size={13} style={{ color: 'var(--kind-thinking)' }} className="shrink-0" />
        <span className="shrink-0">Thinking{dur(e) ? ` · ${dur(e)}` : ''}</span>
        {!open && <span className="min-w-0 truncate italic">{first}</span>}
        {e.status === 'running' && <Spinner size={11} />}
      </Expander>
      {open && <div className="border-panel-border/60 ml-4 border-l pl-3 whitespace-pre-wrap italic">{text}</div>}
    </div>
  )
}

function ToolCard({ e }: { e: ActivityEvent }) {
  const [open, setOpen] = useState(false)
  const t = e.tool
  const part = useDetail(e.detailRef, open)
  if (!t) return null
  const d = part?.data
  const input = d?.input != null ? (typeof d.input === 'string' ? d.input : JSON.stringify(d.input, null, 2)) : t.input
  const output = d?.output ?? t.output
  const error = d?.error ?? t.error
  return (
    <div className={cn(card, e.status === 'error' && 'border-status-failed')} data-testid={`item-${e.kind}`}>
      <Expander open={open} onToggle={() => setOpen((o) => !o)} label={`Toggle ${t.displayName}`}>
        <ToolBadge tool={t} />
        {t.input && <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono">{t.input}</span>}
        <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">{dur(e)}</span>
        <StatusGlyph status={e.status} />
      </Expander>
      {!open && e.status === 'running' && t.output && <pre className="pre-block m-1.5 mt-0 max-h-20 overflow-hidden" data-testid="live-output">{t.output}</pre>}
      {open && (
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {part?.status === 'loading' && !d && <Spinner size={12} />}
          {part?.status === 'error' && <ErrorBox message={part.error ?? 'Failed to load detail'} />}
          {input && <div><div className="text-muted-foreground mb-0.5 text-[10px] uppercase">Input</div><PreBlock text={input} copy={false} /></div>}
          {output && <div><div className="text-muted-foreground mb-0.5 text-[10px] uppercase">Output</div><PreBlock text={output} /></div>}
          {error && <pre className="pre-block text-status-failed-ink m-0 whitespace-pre-wrap" role="alert">{error}</pre>}
        </div>
      )}
    </div>
  )
}

function FileChangeCard({ e }: { e: ActivityEvent }) {
  const [open, setOpen] = useState(false)
  const root = useOcc((s) => (e.sessionId ? s.sessions[e.sessionId]?.workspace?.path : null))
  const paths = e.files.length ? e.files.map((p) => shortPath(p, root)) : [e.title]
  const fc = useOcc((s) => (e.sessionId ? s.details[e.sessionId]?.data?.fileChanges.find((c) => c.id === e.id) : undefined))
  const m = fc && (fc.additions != null || fc.deletions != null) ? [null, String(fc.additions ?? 0), String(fc.deletions ?? 0)] : null
  return (
    <div className={card} data-testid="item-file-change">
      <Expander open={open} onToggle={() => setOpen((o) => !o)} label="Toggle diff">
        <KindIcon kind="file-change" />
        <span className="min-w-0 flex-1 truncate font-mono" title={paths.join(', ')}>{paths.join(', ')}</span>
        {m && <span className="font-mono text-[10px]"><span className="text-status-completed-ink">+{m[1]}</span> <span className="text-status-failed-ink">−{m[2]}</span></span>}
        <StatusGlyph status={e.status} />
      </Expander>
      {open && <div className="px-2 pb-2"><ChangeDiff id={e.id} /></div>}
    </div>
  )
}

function SubagentCard({ e }: { e: ActivityEvent }) {
  const selectSession = useOcc((s) => s.selectSession)
  const child = useOcc((s) => (e.childSessionId ? s.sessions[e.childSessionId] : undefined))
  const agent = child?.agent ?? child?.spawn?.subagentType ?? e.tool?.input?.split(/\s/)[0] ?? null
  const clickable = !!e.childSessionId
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => e.childSessionId && selectSession(e.childSessionId)}
      className={cn(card, 'focus-ring hover:bg-accent flex w-full items-center gap-2 px-2 py-1.5 text-left')}
      data-testid="item-subagent"
    >
      <AgentMonogram agent={agent} size={20} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{child?.spawn?.subagentType ?? agent ?? 'subagent'}</span>
        <span className="text-muted-foreground block truncate">{child?.spawn?.description ?? e.title}</span>
      </span>
      <StatusGlyph status={e.status} />
    </button>
  )
}

function TodoSnapshot({ e, onOpenTodos }: { e: ActivityEvent; onOpenTodos: () => void }) {
  type T = { content: string; status: string; priority?: string }
  let todos: T[] | null = null
  try {
    const j = JSON.parse(e.tool?.input ?? '') as { todos?: unknown }
    if (Array.isArray(j.todos)) todos = j.todos as T[]
  } catch { /* preview not JSON */ }
  if (!todos && e.summary) {
    const parsed = e.summary.split('\n').flatMap((l) => { const m = /^\[(\w+)\]\s+(.*)$/.exec(l); return m ? [{ status: m[1], content: m[2] }] : [] })
    if (parsed.length) todos = parsed
  }
  return (
    <div className={cn(card, 'p-2')} data-testid="item-todo">
      <div className="mb-1 flex items-center gap-1.5"><KindIcon kind="todo" /><span className="font-medium">{e.title}</span></div>
      {todos?.length ? <ul className="m-0 flex list-none flex-col gap-1 p-0">{todos.map((t, i) => <TodoRow key={i} t={t} />)}</ul>
        : <button type="button" className="text-selection underline" onClick={onOpenTodos}>View todos</button>}
    </div>
  )
}

function SystemRow({ e }: { e: ActivityEvent }) {
  const err = e.kind === 'error'
  return (
    <div className={cn('flex items-start gap-1.5 px-1 text-[11px]', err ? 'text-status-failed-ink' : 'text-muted-foreground')} data-testid={`item-${e.kind}`}>
      <KindIcon kind={e.kind} size={12} className="mt-0.5" />
      <span className="min-w-0 break-words">{e.title}{e.summary && e.summary !== e.title ? ` — ${e.summary}` : ''}</span>
      <span className="ml-auto shrink-0 tabular-nums">{formatClock(e.ts)}</span>
    </div>
  )
}

export function StepRow({ e }: { e: ActivityEvent }) {
  const u = e.usage
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-[10px]" data-testid="item-step">
      <span className="bg-panel-border h-px flex-1" />
      <span className="tabular-nums">{u ? `${formatTokens(u.tokens.input + u.tokens.output)} tok · ${formatCost(u.cost)}` : e.title}</span>
      <span className="bg-panel-border h-px flex-1" />
    </div>
  )
}

export function ItemView({ e, onOpenTodos }: { e: ActivityEvent; onOpenTodos: () => void }) {
  switch (e.kind) {
    case 'prompt': {
      const attach = e.files
      return (
        <div className="flex flex-col items-end gap-1" data-testid="item-prompt">
          <div className="bg-selection/15 border-selection/30 max-w-[90%] rounded-2xl rounded-br-sm border px-3 py-1.5"><Markdownish text={e.summary ?? e.title} /></div>
          {attach.length > 0 && <div className="flex flex-wrap justify-end gap-1">{attach.map((f) => <span key={f} className="chip"><Paperclip size={10} />{f.split('/').pop()}</span>)}</div>}
        </div>
      )
    }
    case 'text':
      return <div className="bg-muted/50 max-w-[95%] rounded-2xl rounded-bl-sm px-3 py-1.5" data-testid="item-text"><Markdownish text={e.summary ?? e.title} /></div>
    case 'thinking': return <Thinking e={e} />
    case 'tool': case 'mcp': return <ToolCard e={e} />
    case 'file-change': return <FileChangeCard e={e} />
    case 'subagent': return <SubagentCard e={e} />
    case 'todo': return <TodoSnapshot e={e} onOpenTodos={onOpenTodos} />
    case 'step': return <StepRow e={e} />
    default: return <SystemRow e={e} />
  }
}

export function MessageHeader({ m }: { m: TranscriptMessage }) {
  const tok = m.tokens ? m.tokens.input + m.tokens.output : null
  return (
    <div className="mt-1" data-testid="message-header">
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
        {m.role === 'assistant' ? <AgentMonogram agent={m.agent} size={17} /> : <FileText size={11} />}
        <span className="text-foreground font-medium">{m.role === 'assistant' ? (m.agent ?? 'assistant') : 'You'}</span>
        {m.model && <span className="font-mono">{m.model.modelId}</span>}
        <span className="tabular-nums">{formatClock(m.createdAt)}</span>
        {tok != null && <span className="tabular-nums">{formatTokens(tok)} tok</span>}
        {m.cost != null && m.cost > 0 && <span className="tabular-nums">{formatCost(m.cost)}</span>}
      </div>
      {m.error && <div role="alert" className="bg-status-failed-soft text-status-failed-ink border-status-failed mt-1 rounded-lg border px-2 py-1 text-[11px]">{m.error}</div>}
    </div>
  )
}
