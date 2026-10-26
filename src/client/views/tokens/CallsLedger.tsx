import { useVirtualizer } from '@tanstack/react-virtual'
import { motion } from 'motion/react'
import { memo, useRef } from 'react'
import type { SessionSummary, UsageEstimate, UsageSample } from '../../../shared/contract'
import { throughputTps } from '../../../shared/usage-math'
import { cn } from '../../lib/cn'
import { formatClock, formatCost, formatTokens, shortModel } from '../../lib/format'
import { AgentMonogram, SectionLabel } from '../../ui'
import { InFlightMeter, useFlowMotion } from '../../ui/flow'
import { formatMs } from './model'

export const VIRTUALIZE_AFTER = 60
const ROW_H = 28
const COLS = 'grid-cols-[64px_minmax(120px,1.4fr)_28px_minmax(90px,1fr)_repeat(5,64px)_64px_64px]'
const HEADERS = ['Time', 'Session', '', 'Model', 'Fresh in', 'Cache rd', 'Cache wr', 'Out', 'Reason', 'Cost', 'TTFT', 'tok/s']

export interface CallsLedgerProps {
  calls: UsageSample[]
  inFlight: UsageEstimate[]
  sessions: Record<string, SessionSummary>
  hasMore: boolean
  loading: boolean
  onLoadOlder(): void
  onSelectSession(id: string): void
}

const num = (n: number) => (n > 0 ? formatTokens(n) : '—')

const CallRow = memo(function CallRow({ c, title, animate, onSelect }: { c: UsageSample; title: string; animate: boolean; onSelect(id: string): void }) {
  const tps = throughputTps(c)
  return (
    <motion.div
      role="row" data-call={c.id} initial={animate ? { y: -6, opacity: 0 } : false} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.18 }}
      className={cn('grid h-7 items-center gap-2 px-2 text-[11px] tabular-nums', COLS)}
    >
      <span role="cell" className="text-muted-foreground">{formatClock(c.ts)}</span>
      <span role="cell" className="min-w-0">
        <button type="button" onClick={() => onSelect(c.sessionId)} className="hover:text-foreground text-muted-foreground focus-ring block max-w-full truncate text-left hover:underline" title={title}>{title}</button>
      </span>
      <span role="cell"><AgentMonogram agent={c.agent} size={17} /></span>
      <span role="cell" className="truncate" title={c.model?.modelId}>{c.model ? shortModel(c.model.modelId) : '—'}</span>
      <span role="cell" className="text-right" style={{ color: 'var(--flow-input)' }}>{num(c.tokens.input)}</span>
      <span role="cell" className="text-right" style={{ color: 'var(--flow-cache-read)' }}>{num(c.tokens.cacheRead)}</span>
      <span role="cell" className="text-right" style={{ color: 'var(--flow-cache-write)' }}>{num(c.tokens.cacheWrite)}</span>
      <span role="cell" className="text-right" style={{ color: 'var(--flow-output)' }}>{num(c.tokens.output)}</span>
      <span role="cell" className="text-right" style={{ color: 'var(--flow-reasoning)' }}>{num(c.tokens.reasoning)}</span>
      <span role="cell" className="text-right">{c.cost == null ? '—' : formatCost(c.cost)}</span>
      <span role="cell" className="text-right">{c.ttftMs == null ? '—' : formatMs(c.ttftMs)}</span>
      <span role="cell" className="text-right">{tps == null ? '—' : Math.round(tps)}</span>
    </motion.div>
  )
})

export const CallsLedger = memo(function CallsLedger({ calls, inFlight, sessions, hasMore, loading, onLoadOlder, onSelectSession }: CallsLedgerProps) {
  const { reduced } = useFlowMotion()
  const scrollRef = useRef<HTMLDivElement>(null)
  const seen = useRef<Set<string> | null>(null)
  const virtual = calls.length > VIRTUALIZE_AFTER
  const titleOf = (id: string) => sessions[id]?.title ?? id
  // Rows present on first paint don't animate; later arrivals do.
  const fresh = new Set<string>()
  if (seen.current === null) seen.current = new Set(calls.map((c) => c.id))
  else for (const c of calls) if (!seen.current.has(c.id)) { fresh.add(c.id); seen.current.add(c.id) }

  const virtualizer = useVirtualizer({
    count: virtual ? calls.length : 0, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 12,
  })
  const items = virtual ? virtualizer.getVirtualItems() : []

  return (
    <section className="panel bg-panel-solid flex min-w-0 flex-col gap-2 p-3" aria-label="Calls ledger" data-testid="tokens-calls">
      <div className="flex items-center justify-between"><SectionLabel>CALLS</SectionLabel><span className="text-muted-foreground text-[10px]">{calls.length} loaded</span></div>
      <div className="overflow-x-auto">
        <div role="table" aria-label="Metered calls" aria-rowcount={calls.length + inFlight.length} className="min-w-[900px]">
          <div role="row" className={cn('text-muted-foreground grid items-center gap-2 px-2 pb-1 text-[10px] font-medium tracking-wide uppercase', COLS)}>
            {HEADERS.map((h, i) => <span key={i} role="columnheader" className={i >= 4 ? 'text-right' : undefined}>{h}</span>)}
          </div>
          {inFlight.map((e) => (
            <div key={`if:${e.sessionId}`} role="row" data-inflight-row={e.sessionId} className={cn('grid h-9 items-center gap-2 px-2 text-[11px]', COLS)}>
              <span role="cell" className="text-muted-foreground">now</span>
              <span role="cell" className="min-w-0"><button type="button" onClick={() => onSelectSession(e.sessionId)} className="text-muted-foreground hover:text-foreground focus-ring block max-w-full truncate text-left hover:underline">{titleOf(e.sessionId)}</button></span>
              <span role="cell" className="col-span-10"><InFlightMeter estTokens={e.estOutputTokens} startedAt={e.startedAt} /></span>
            </div>
          ))}
          {virtual ? (
            <div ref={scrollRef} className="max-h-[360px] overflow-y-auto" data-testid="tokens-calls-scroll">
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {items.map((v) => {
                  const c = calls[v.index]
                  return <div key={c.id} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }}><CallRow c={c} title={titleOf(c.sessionId)} animate={!reduced && fresh.has(c.id)} onSelect={onSelectSession} /></div>
                })}
              </div>
            </div>
          ) : (
            <div ref={scrollRef}>{calls.map((c) => <CallRow key={c.id} c={c} title={titleOf(c.sessionId)} animate={!reduced && fresh.has(c.id)} onSelect={onSelectSession} />)}</div>
          )}
        </div>
      </div>
      {hasMore && <button type="button" onClick={onLoadOlder} disabled={loading} className="bg-muted hover:bg-accent focus-ring w-fit self-center rounded-md px-3 py-1 text-[11px] disabled:opacity-50">{loading ? 'Loading…' : 'Load older'}</button>}
      {calls.length === 0 && inFlight.length === 0 && <p className="text-muted-foreground py-3 text-center text-[11px]">No calls loaded.</p>}
    </section>
  )
})
