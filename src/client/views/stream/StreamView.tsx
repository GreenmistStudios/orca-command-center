import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownToLine, ArrowDown, Pause, Play, Search } from 'lucide-react'
import { motion } from 'motion/react'
import { useNow } from '../../hooks/useNow'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { HARNESS_META, type ActivityEvent, type ActivityKind, type Harness } from '../../../shared/contract'
import { cn } from '../../lib/cn'
import { formatClock, formatDuration } from '../../lib/format'
import { selectActivityForScope } from '../../state/selectors'
import { useOcc } from '../../state/store'
import {
  AgentMonogram, Button, Chip, EmptyState, KindIcon, Markdownish, Segmented, StatusGlyph, ToolBadge, kindColorVar,
} from '../../ui'
import { KIND_CHIPS, effectiveKinds, isErrorEvent, matchesBase, matchesFilter, mergeEvents, type RowFilter } from './filters'

const ROW_H = 30
const EMPTY: ActivityEvent[] = []

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function Ticking({ ev }: { ev: ActivityEvent }) {
  const running = ev.status === 'running' && ev.endTs == null
  const now = useNow(1000)
  const ms = ev.endTs != null ? ev.endTs - ev.ts : running ? Math.max(0, now - ev.ts) : ev.tool?.durationMs ?? null
  return <span className="text-muted-foreground w-12 shrink-0 text-right font-mono text-[10.5px] tabular-nums">{ms != null ? formatDuration(ms) : ''}</span>
}

interface RowProps {
  ev: ActivityEvent
  sessionTitle: string
  agent: string | null
  repeated: boolean
  selected: boolean
  expanded: boolean
  fresh: boolean
  onToggle: (id: string) => void
}

const StreamRow = memo(function StreamRow({ ev, sessionTitle, agent, repeated, selected, expanded, fresh, onToggle }: RowProps) {
  const selectSession = useOcc((s) => s.selectSession)
  const selectActivity = useOcc((s) => s.selectActivity)
  const fetchPart = useOcc((s) => s.fetchPart)
  const part = useOcc((s) => (expanded && ev.detailRef ? s.parts[ev.detailRef] : undefined))
  const [full, setFull] = useState(false)
  const err = isErrorEvent(ev)
  const toggle = () => { selectActivity(ev.id); onToggle(ev.id) }
  return (
    <motion.div
      initial={fresh ? { opacity: 0, y: -6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      data-testid="stream-row"
      data-selected={selected || undefined}
      className={cn('border-panel-border/40 border-b text-xs', selected && 'bg-accent/60', err && 'bg-status-failed-soft/40')}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle() } }}
        className="flex h-[30px] cursor-pointer items-center gap-2 px-3"
      >
        <span className="text-muted-foreground w-[58px] shrink-0 font-mono text-[10.5px] tabular-nums">{formatClock(ev.ts)}</span>
        <AgentMonogram agent={agent} size={17} />
        <button
          type="button"
          title={sessionTitle}
          disabled={!ev.sessionId}
          onClick={(e) => { e.stopPropagation(); if (ev.sessionId) selectSession(ev.sessionId) }}
          className={cn('w-28 shrink-0 truncate text-left hover:underline', repeated ? 'text-muted-foreground/40' : 'text-muted-foreground')}
        >
          {sessionTitle}
        </button>
        <span style={{ color: kindColorVar(ev.kind) }} className="shrink-0"><KindIcon kind={ev.kind} category={ev.tool?.category} size={14} /></span>
        <span className="min-w-0 flex-1 truncate">
          {ev.tool?.mcpServer && <span className="border-panel-border text-muted-foreground mr-1.5 rounded-full border px-1.5 text-[10px]">{ev.tool.mcpServer}</span>}
          {ev.title}
        </span>
        <StatusGlyph status={ev.status} size={12} />
        <Ticking ev={ev} />
      </div>
      {expanded && (
        <div className="space-y-2 px-3 pb-2 pl-[88px]">
          {ev.summary && (ev.kind === 'text' || ev.kind === 'thinking' || ev.kind === 'prompt'
            ? <Markdownish text={ev.summary} />
            : <pre className="bg-muted/50 max-h-40 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">{ev.summary}</pre>)}
          {ev.tool && <div><ToolBadge tool={ev.tool} /></div>}
          {ev.tool?.input && <pre data-testid="tool-input" className="bg-muted/50 max-h-32 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">{ev.tool.input}</pre>}
          {ev.tool?.output && <pre data-testid="tool-output" className="bg-muted/50 max-h-32 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">{ev.tool.output}</pre>}
          {ev.tool?.error && <pre className="text-status-failed-ink max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{ev.tool.error}</pre>}
          {ev.files.length > 0 && <div className="flex flex-wrap gap-1">{ev.files.map((f) => <Chip key={f} title={f}>{f.split('/').pop()}</Chip>)}</div>}
          {ev.links.length > 0 && <div className="flex flex-col">{ev.links.map((l) => <a key={l} href={l} target="_blank" rel="noreferrer" className="text-primary truncate hover:underline">{l}</a>)}</div>}
          <div className="flex gap-2">
            <Button size="sm" disabled={!ev.sessionId} onClick={() => ev.sessionId && selectSession(ev.sessionId, { activityId: ev.id })}>Open in inspector</Button>
            {ev.detailRef && <Button size="sm" onClick={() => { setFull(true); void fetchPart(ev.detailRef!) }}>Full detail</Button>}
          </div>
          {full && part && (
            <div data-testid="full-detail" className="bg-muted/50 rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
              {part.status === 'loading' && 'Loading…'}
              {part.status === 'error' && (part.error ?? 'Failed to load')}
              {part.data && [part.data.text, part.data.input != null ? JSON.stringify(part.data.input, null, 2) : null, part.data.output, part.data.error].filter(Boolean).join('\n\n')}
            </div>
          )}
        </div>
      )}
    </motion.div>
  )
})

export function StreamView() {
  const filters = useOcc((s) => s.ui.streamFilters)
  const setFilters = useOcc((s) => s.setStreamFilters)
  const selectedRootId = useOcc((s) => s.ui.selectedRootId)
  const selectedSessionId = useOcc((s) => s.ui.selectedSessionId)
  const selectedActivityId = useOcc((s) => s.ui.selectedActivityId)
  const sessions = useOcc((s) => s.sessions)
  const activity = useOcc((s) => s.activity)
  const fetchScoped = useOcc((s) => s.fetchScopedActivity)

  const scope = filters.scope
  const rootId = scope === 'tree' ? selectedRootId : null
  const sessionId = scope === 'session' ? selectedSessionId : null
  const scoped = scope !== 'all' && (rootId || sessionId)
  const scopeKey = sessionId ? `session:${sessionId}` : rootId ? `root:${rootId}` : ''
  const history = useOcc((s) => (scopeKey ? s.scopedActivity[scopeKey]?.data : null))

  useEffect(() => {
    if (sessionId) void fetchScoped({ sessionId })
    else if (rootId) void fetchScoped({ rootId })
  }, [sessionId, rootId, fetchScoped])

  const [queryText, setQueryText] = useState(filters.query)
  useEffect(() => setQueryText(filters.query), [filters.query])
  const debounced = useDebounced(queryText, 150)
  useEffect(() => { if (debounced !== filters.query) setFilters({ query: debounced }) }, [debounced]) // eslint-disable-line react-hooks/exhaustive-deps

  const kindSet = useMemo(() => effectiveKinds(filters.kinds), [filters.kinds])
  const titleOf = useCallback((id: string | null) => (id ? sessions[id]?.title ?? id : ''), [sessions])

  // Candidate events: ring ∪ scoped history (scope-restricted), deduped by id/rev, oldest first.
  const candidates = useMemo(() => {
    const ids = selectActivityForScope(useOcc.getState(), { rootId, sessionId })
    const ring = ids.map((id) => activity.byId[id]).filter(Boolean) as ActivityEvent[]
    if (!scoped) return mergeEvents(ring)
    return mergeEvents(history?.events ?? EMPTY, ring)
  }, [activity, rootId, sessionId, scoped, history])

  const base: RowFilter = useMemo(
    () => ({ kinds: kindSet, harness: filters.harness, errorsOnly: filters.errorsOnly, query: filters.query }),
    [kindSet, filters.harness, filters.errorsOnly, filters.query],
  )

  const { rows, counts } = useMemo(() => {
    const counts: Partial<Record<ActivityKind, number>> = {}
    const rows: ActivityEvent[] = []
    for (const e of candidates) {
      const st = e.sessionId ? sessions[e.sessionId]?.title : null
      if (!matchesBase(e, base, st)) continue
      counts[e.kind] = (counts[e.kind] ?? 0) + 1
      if (matchesFilter(e, base, st)) rows.push(e)
    }
    return { rows, counts }
  }, [candidates, base, sessions])

  // Pause: freeze the visible list; buffered = arrivals since.
  const live = useRef(rows)
  if (!filters.paused) live.current = rows
  const shown = filters.paused ? live.current : rows
  const buffered = useMemo(() => {
    if (!filters.paused) return 0
    const seen = new Set(shown.map((e) => e.id))
    let n = 0
    for (const e of rows) if (!seen.has(e.id)) n++
    return n
  }, [filters.paused, rows, shown])

  // Rows arriving after mount animate in.
  const prevIds = useRef<Set<string> | null>(null)
  const fresh = useMemo(() => {
    const prev = prevIds.current
    const f = new Set<string>()
    if (prev) for (const e of shown) if (!prev.has(e.id)) f.add(e.id)
    return f
  }, [shown])
  useEffect(() => { prevIds.current = new Set(shown.map((e) => e.id)) }, [shown])

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const onToggle = useCallback((id: string) => setExpanded((x) => ({ ...x, [id]: !x[id] })), [])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    getItemKey: (i) => shown[i]?.id ?? i,
  })

  // Follow: stick to the bottom as rows arrive.
  const programmatic = useRef(false)
  useLayoutEffect(() => {
    if (!filters.follow || shown.length === 0) return
    programmatic.current = true
    virt.scrollToIndex(shown.length - 1, { align: 'end' })
    const t = setTimeout(() => { programmatic.current = false }, 120)
    return () => clearTimeout(t)
  }, [filters.follow, shown.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const seenAtOff = useRef(0)
  useEffect(() => { if (!filters.follow) seenAtOff.current = shown.length }, [filters.follow]) // eslint-disable-line react-hooks/exhaustive-deps
  const newCount = filters.follow ? 0 : filters.paused ? 0 : Math.max(0, shown.length - seenAtOff.current)

  const onScroll = () => {
    const el = scrollRef.current
    if (!el || programmatic.current || !filters.follow) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 48) setFilters({ follow: false })
  }

  const [announce, setAnnounce] = useState('')
  const lastAnnounced = useRef<string | null>(null)
  useEffect(() => {
    const last = shown[shown.length - 1]
    if (last && last.id !== lastAnnounced.current && (isErrorEvent(last) || last.kind === 'permission')) {
      setAnnounce(`${last.kind === 'permission' ? 'Permission needed' : 'Error'}: ${last.title}`)
    }
    lastAnnounced.current = last?.id ?? null
  }, [shown])

  const toggleKind = (k: ActivityKind) => {
    const next = new Set(kindSet)
    if (next.has(k)) next.delete(k); else next.add(k)
    setFilters({ kinds: [...next] })
  }
  const hasSelection = (s: 'tree' | 'session') => (s === 'tree' ? !!selectedRootId : !!selectedSessionId)
  const anyFilter = filters.errorsOnly || filters.query !== '' || filters.harness !== 'all' || filters.kinds.length > 0
  const olderKey = scopeKey
  const canOlder = !!scoped && !!history?.hasMore && !!olderKey

  const items = virt.getVirtualItems()

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="stream-view">
      <div className="panel-header flex flex-wrap items-center gap-2 px-3 py-2">
        <Segmented<'all' | 'tree' | 'session'>
          aria-label="Scope"
          layoutId="stream-scope"
          value={filters.scope}
          onChange={(v) => setFilters({ scope: v })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'tree', label: hasSelection('tree') ? 'This tree' : <span className="opacity-50">This tree</span>, title: hasSelection('tree') ? undefined : 'Select a session first' },
            { value: 'session', label: hasSelection('session') ? 'This session' : <span className="opacity-50">This session</span>, title: hasSelection('session') ? undefined : 'Select a session first' },
          ]}
        />
        <select
          aria-label="Harness"
          value={filters.harness}
          onChange={(e) => setFilters({ harness: e.target.value as Harness | 'all' })}
          className="border-panel-border bg-background h-7 rounded-md border px-1.5 text-xs"
        >
          <option value="all">All harnesses</option>
          {(Object.keys(HARNESS_META) as Harness[]).map((h) => <option key={h} value={h}>{HARNESS_META[h].label}</option>)}
        </select>
        <label className="border-panel-border bg-background flex h-7 items-center gap-1 rounded-md border px-1.5">
          <Search size={12} className="text-muted-foreground" />
          <input
            aria-label="Search stream"
            placeholder="Search"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            className="w-36 bg-transparent text-xs outline-none"
          />
        </label>
        <Button size="sm" aria-pressed={filters.errorsOnly} onClick={() => setFilters({ errorsOnly: !filters.errorsOnly })} className={cn(filters.errorsOnly && 'text-status-failed-ink')}>
          Errors only
        </Button>
        <Button size="sm" aria-pressed={filters.follow} title="Follow (f)" onClick={() => setFilters({ follow: !filters.follow })}>
          <ArrowDownToLine size={13} /> Follow
        </Button>
        <Button size="sm" aria-pressed={filters.paused} title="Pause (space)" onClick={() => setFilters({ paused: !filters.paused })}>
          {filters.paused ? <Play size={13} /> : <Pause size={13} />} {filters.paused ? 'Resume' : 'Pause'}
        </Button>
        <div className="flex w-full flex-wrap gap-1" role="group" aria-label="Kinds">
          {KIND_CHIPS.map(({ kind, label }) => {
            const on = kindSet.has(kind)
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={on}
                onClick={() => toggleKind(kind)}
                className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]', on ? 'border-panel-border bg-accent' : 'border-transparent text-muted-foreground opacity-70')}
              >
                <span className="size-1.5 rounded-full" style={{ background: kindColorVar(kind) }} />
                {label}
                <span className="text-muted-foreground/70 tabular-nums" data-testid={`count-${kind}`}>{counts[kind] ?? 0}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {shown.length === 0 && (
          <div className="absolute inset-0 z-10">
            {anyFilter && candidates.length > 0 ? (
              <EmptyState title="No events match the filters">
                <Button size="sm" onClick={() => { setFilters({ errorsOnly: false, query: '', harness: 'all', kinds: [] }); setQueryText('') }}>Clear filters</Button>
              </EmptyState>
            ) : (
              <EmptyState title="No activity yet" hint="Events from every agent will stream in here." />
            )}
          </div>
        )}
        {(
          <div ref={scrollRef} onScroll={onScroll} role="log" aria-live="off" aria-label="Activity stream" className="h-full overflow-auto">
            {canOlder && (
              <div className="flex justify-center py-1.5">
                <Button size="sm" onClick={() => void fetchScoped(sessionId ? { sessionId } : { rootId: rootId! }, { older: true })}>Load older</Button>
              </div>
            )}
            <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
              {items.map((vi) => {
                const ev = shown[vi.index]
                if (!ev) return null
                const prev = shown[vi.index - 1]
                const sess = ev.sessionId ? sessions[ev.sessionId] : undefined
                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={virt.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                  >
                    <StreamRow
                      ev={ev}
                      sessionTitle={titleOf(ev.sessionId)}
                      agent={sess?.agent ?? null}
                      repeated={!!prev && prev.sessionId === ev.sessionId}
                      selected={selectedActivityId === ev.id}
                      expanded={!!expanded[ev.id]}
                      fresh={fresh.has(ev.id)}
                      onToggle={onToggle}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {(newCount > 0 || buffered > 0) && (
          <button
            type="button"
            data-testid="new-events-chip"
            onClick={() => (buffered > 0 ? setFilters({ paused: false }) : setFilters({ follow: true }))}
            className="bg-foreground text-background shadow-lift-2 absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full px-3 py-1 text-xs"
          >
            {buffered > 0 ? `${buffered} buffered · Resume` : `${newCount} new events`} <ArrowDown size={12} />
          </button>
        )}
        <div role="status" aria-live="polite" className="sr-only">{announce}</div>
      </div>
    </div>
  )
}
