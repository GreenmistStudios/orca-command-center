import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, MessageSquare } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent, TranscriptMessage } from '../../shared/contract'
import { cn } from '../lib/cn'
import { formatDay } from '../lib/format'
import { useOcc } from '../state/store'
import { Button, EmptyState } from '../ui'
import { ErrorBox, Skeleton } from './common'
import { ItemView, MessageHeader } from './TranscriptItems'

export const VIRTUALIZE_AFTER = 300

type Row =
  | { key: string; type: 'day'; ts: number }
  | { key: string; type: 'head'; m: TranscriptMessage }
  | { key: string; type: 'item'; e: ActivityEvent }

export function buildRows(messages: TranscriptMessage[], showSteps: boolean): Row[] {
  const rows: Row[] = []
  let day = ''
  for (const m of messages) {
    const d = formatDay(m.createdAt)
    if (d !== day) { day = d; rows.push({ key: `day:${m.id}`, type: 'day', ts: m.createdAt }) }
    if (m.role !== 'system') rows.push({ key: `head:${m.id}`, type: 'head', m })
    for (const e of m.items) if (showSteps || e.kind !== 'step') rows.push({ key: e.id, type: 'item', e })
  }
  return rows
}

export function Transcript({ sessionId, live, onOpenTodos }: { sessionId: string; live: boolean; onOpenTodos: () => void }) {
  const entry = useOcc((s) => s.transcripts[sessionId])
  const fetchTranscript = useOcc((s) => s.fetchTranscript)
  const selectedActivityId = useOcc((s) => s.ui.selectedActivityId)
  const [showSteps, setShowSteps] = useState(false)
  const [newBelow, setNewBelow] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const lastCount = useRef(0)

  useEffect(() => { void fetchTranscript(sessionId) }, [sessionId, fetchTranscript])

  const data = entry?.data ?? null
  const rows = useMemo(() => buildRows(data?.messages ?? [], showSteps), [data, showSteps])
  const virtual = rows.length > VIRTUALIZE_AFTER
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 10,
  })

  const toBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (virtual) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' })
    el.scrollTop = el.scrollHeight
    setNewBelow(false)
  }, [virtual, virtualizer, rows.length])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    following.current = at
    if (at) setNewBelow(false)
  }

  useLayoutEffect(() => {
    const grew = rows.length > lastCount.current
    const first = lastCount.current === 0
    lastCount.current = rows.length
    if (!grew) return
    if (first || (live && following.current)) toBottom()
    else if (!first) setNewBelow(true)
  }, [rows.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to the selected activity.
  useEffect(() => {
    if (!selectedActivityId) return
    const idx = rows.findIndex((r) => r.type === 'item' && r.e.id === selectedActivityId)
    if (idx < 0) return
    following.current = false
    if (virtual) virtualizer.scrollToIndex(idx, { align: 'center' })
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`[data-activity-id="${CSS.escape(selectedActivityId)}"]`)?.scrollIntoView?.({ block: 'center' })
    })
  }, [selectedActivityId, rows, virtual]) // eslint-disable-line react-hooks/exhaustive-deps

  const renderRow = (r: Row) => {
    if (r.type === 'day') return <div className="text-muted-foreground flex items-center gap-2 py-1 text-[10px]"><span className="bg-panel-border h-px flex-1" />{formatDay(r.ts)}<span className="bg-panel-border h-px flex-1" /></div>
    if (r.type === 'head') return <MessageHeader m={r.m} />
    const sel = r.e.id === selectedActivityId
    return (
      <div data-activity-id={r.e.id} className={cn('rounded-lg', sel && 'ring-selection ring-2')} data-selected={sel || undefined}>
        <ItemView e={r.e} onOpenTodos={onOpenTodos} />
      </div>
    )
  }

  if (!data) {
    if (entry?.status === 'error') return <ErrorBox message={entry.error ?? 'Failed to load transcript'} onRetry={() => void fetchTranscript(sessionId, { force: true })} />
    return <Skeleton lines={8} />
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="transcript">
      <div className="border-panel-border/60 flex items-center justify-end gap-2 border-b px-3 py-1">
        <label className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
          <input type="checkbox" checked={showSteps} onChange={(e) => setShowSteps(e.target.checked)} /> Show steps
        </label>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-3">
        {data.hasMore && (
          <div className="mb-2 flex justify-center">
            <Button variant="subtle" disabled={entry?.status === 'loading'} onClick={() => void fetchTranscript(sessionId, { older: true })}>
              {entry?.status === 'loading' ? 'Loading…' : 'Load earlier'}
            </Button>
          </div>
        )}
        {entry?.status === 'error' && <ErrorBox message={entry.error ?? 'Failed to refresh transcript'} onRetry={() => void fetchTranscript(sessionId, { force: true })} />}
        {rows.length === 0 ? <EmptyState icon={<MessageSquare size={20} />} title="No activity recorded yet." /> : virtual ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => (
              <div key={rows[v.index].key} data-index={v.index} ref={virtualizer.measureElement} className="absolute top-0 left-0 w-full pb-1.5" style={{ transform: `translateY(${v.start}px)` }}>
                {renderRow(rows[v.index])}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">{rows.map((r) => <div key={r.key}>{renderRow(r)}</div>)}</div>
        )}
      </div>
      {newBelow && (
        <button type="button" onClick={toBottom} className="bg-selection text-background focus-ring shadow-lift-1 absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium">
          <ArrowDown size={12} /> New activity below
        </button>
      )}
    </div>
  )
}
