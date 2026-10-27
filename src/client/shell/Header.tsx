import { Command, LayoutGrid, Moon, Radar, Sun } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useNow } from '../hooks/useNow'
import { formatClock, formatRelative } from '../lib/format'
import { cn } from '../lib/cn'
import { selectFleetPulse } from '../state/selectors'
import { useOcc, type ConnectionState } from '../state/store'
import type { SourceHealth, SourceStatus } from '../../shared/contract'
import { Button, IconButton } from '../ui/Button'
import { LiveDot } from '../ui/LiveDot'
import { Popover } from '../ui/Overlay'
import { Badge } from '../ui/Pills'
import { toneClasses } from '../ui/tones'

const SPRING = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 } as const

const SOURCE_DOT: Record<SourceStatus, string> = {
  ok: 'bg-status-completed', starting: 'bg-status-ready', degraded: 'bg-status-dispatched', missing: 'bg-status-failed', error: 'bg-status-failed', disabled: 'bg-muted-foreground/40',
}

function FleetPulse() {
  const p = useOcc(selectFleetPulse)
  const clearSelection = useOcc((s) => s.selectSession)
  return (
    <div data-testid="fleet-pulse" className="flex items-center gap-2 text-[11px]">
      <span className="flex items-center gap-1.5" title="Agents currently working, including subagents"><span className={cn('size-1.5 rounded-full', toneClasses('dispatched').dot)} /><b className="tabular-nums">{p.working}</b> working</span>
      <span className="opacity-40">·</span>
      <button type="button" onClick={() => clearSelection(null)} className={cn('focus-ring flex items-center gap-1.5 rounded', p.needsYou > 0 ? 'text-status-gate-ink font-medium' : 'text-muted-foreground')} title="Agents blocked or waiting on you, including subagents — show attention panel">
        <span className={cn('size-1.5 rounded-full', toneClasses('gate').dot)} /><b className="tabular-nums">{p.needsYou}</b> needs you
      </button>
      <span className="opacity-40">·</span>
      <span className="text-muted-foreground flex items-center gap-1.5" title="Agents idle or done, including subagents"><span className={cn('size-1.5 rounded-full', toneClasses('pending').dot)} /><b className="tabular-nums">{p.idle}</b> idle</span>
    </div>
  )
}

function SourceRow({ s }: { s: SourceHealth }) {
  return (
    <li className="border-panel-border/60 flex flex-col gap-0.5 border-b py-2 last:border-0" data-testid="source-row">
      <div className="flex items-center gap-1.5 font-medium">
        <span className={cn('size-1.5 rounded-full', SOURCE_DOT[s.status])} />{s.label}
        <span className="text-muted-foreground ml-auto uppercase tracking-wide text-[10px]">{s.status}</span>
        {s.version && <Badge variant="mono">{s.version}</Badge>}
      </div>
      {s.path && <div className="text-muted-foreground font-mono text-[10px] break-all">{s.path}</div>}
      {s.detail && <div className="text-status-dispatched-ink bg-status-dispatched-soft mt-0.5 rounded px-1.5 py-0.5">{s.detail}</div>}
      <div className="text-muted-foreground/80 text-[10px]">
        {s.lastReadAt ? `read ${formatClock(s.lastReadAt)}` : 'never read'}{s.lastChangeAt ? ` · changed ${formatClock(s.lastChangeAt)}` : ''}
      </div>
    </li>
  )
}

type Health = 'ok' | 'warn' | 'bad' | 'pending'
const HEALTH_DOT: Record<Health, string> = { ok: 'bg-status-completed', warn: 'bg-status-dispatched', bad: 'bg-status-failed', pending: 'bg-status-ready' }
const HEALTH_LABEL: Record<Health, string> = { ok: 'All connected', warn: 'Degraded', bad: 'Connection issue', pending: 'Connecting…' }
const STREAM_TEXT: Record<ConnectionState, string> = { live: 'Live', connecting: 'Stream connecting…', reconnecting: 'Stream reconnecting…', offline: 'Stream offline' }

function sourceHealth(s: SourceStatus): Health | null {
  if (s === 'ok' || s === 'disabled') return null
  if (s === 'starting') return 'pending'
  if (s === 'degraded') return 'warn'
  return 'bad'
}

/** Worst-of rollup across Orca, the event stream and every data source. */
function rollup(orcaLive: boolean, connection: ConnectionState, sources: SourceHealth[]): Health {
  const all: Health[] = [orcaLive ? 'ok' : 'warn']
  all.push(connection === 'live' ? 'ok' : connection === 'connecting' ? 'pending' : connection === 'offline' ? 'bad' : 'warn')
  for (const s of sources) { const h = sourceHealth(s.status); if (h) all.push(h) }
  for (const h of ['bad', 'warn', 'pending'] as const) if (all.includes(h)) return h
  return 'ok'
}

function ConnectionRow({ testId, dot, label, children }: { testId: string; dot: string; label: string; children: ReactNode }) {
  return (
    <li data-testid={testId} className="border-panel-border/60 flex items-center gap-1.5 border-b py-2">
      <span className={cn('size-1.5 shrink-0 rounded-full', dot)} />
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground ml-auto text-right">{children}</span>
    </li>
  )
}

/** Single header status bubble; hover (or click/focus) reveals every connection. */
function StatusBubble({ connection }: { connection: ConnectionState }) {
  const orca = useOcc((s) => s.orca?.status ?? s.meta?.orca ?? null)
  const sources = useOcc((s) => s.meta?.sources) ?? []
  const last = useOcc((s) => s.lastEventAt)
  const now = useNow(1000)
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const show = () => { cancel(); setOpen(true) }
  const hide = () => { cancel(); timer.current = setTimeout(() => setOpen(false), 150) }
  useEffect(() => cancel, [])
  const live = !!orca?.running
  const health = rollup(live, connection, sources)
  const issues = sources.filter((s) => sourceHealth(s.status) && sourceHealth(s.status) !== 'pending').length
  return (
    <Popover
      align="start"
      className="w-96"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          data-testid="status-bubble"
          data-health={health}
          aria-label={`Connection status: ${HEALTH_LABEL[health]}`}
          onPointerEnter={show}
          onPointerLeave={hide}
          onClick={(e) => { e.preventDefault(); show() }}
          className="focus-ring bg-muted flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
          style={health === 'ok' ? { boxShadow: '0 0 16px -6px color-mix(in oklch, var(--status-completed) 90%, transparent)' } : undefined}
        >
          {health === 'ok' ? <LiveDot live /> : <span className={cn('size-1.5 rounded-full', HEALTH_DOT[health])} />}
          {HEALTH_LABEL[health]}
          {issues > 0 && <span className="text-muted-foreground tabular-nums">· {issues}</span>}
        </button>
      }
    >
      <div onPointerEnter={show} onPointerLeave={hide}>
        <div className="section-label mb-1">Connections</div>
        <ul>
          <ConnectionRow testId="orca-pill" dot={live ? HEALTH_DOT.ok : HEALTH_DOT.warn} label="Orca">
            {live ? `Connected to a running Orca${orca?.pid ? ` (pid ${orca.pid})` : ''}.` : 'Orca isn’t running; showing last-known state.'}
          </ConnectionRow>
          <ConnectionRow testId="stream-pill" dot={HEALTH_DOT[rollup(true, connection, [])]} label="Event stream">{STREAM_TEXT[connection]}</ConnectionRow>
        </ul>
        {sources.length > 0 && <><div className="section-label mt-2 mb-1">Sources</div><ul>{sources.map((s) => <SourceRow key={s.id} s={s} />)}</ul></>}
        {last && <div data-testid="last-event" className="text-muted-foreground pt-2">Last event {formatRelative(last, now) === 'now' ? 'just now' : formatRelative(last, now)}</div>}
      </div>
    </Popover>
  )
}

/** App header (design-system §8.1). */
export function Header() {
  const connection = useOcc((s) => s.connection)
  const theme = useOcc((s) => s.ui.theme)
  const toggleTheme = useOcc((s) => s.toggleTheme)
  const setPaletteOpen = useOcc((s) => s.setPaletteOpen)
  const setOversightOpen = useOcc((s) => s.setOversightOpen)
  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="panel flex h-13 shrink-0 items-center gap-3 px-3 max-lg:overflow-x-auto"
    >
      <div className="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-md" style={{ boxShadow: '0 0 18px -4px var(--selection)' }}>
        <Radar size={14} />
      </div>
      <h1 className="hidden text-sm leading-5 font-semibold tracking-tight sm:block">Orca Command Center</h1>
      <span className="bg-panel-border hidden h-5 w-px sm:block" />
      <StatusBubble connection={connection} />
      <FleetPulse />
      <div className="text-muted-foreground ml-auto flex items-center gap-3 text-[11px]">
        <Button data-testid="oversight-button" onClick={() => setOversightOpen(true)} className="gap-1.5" aria-label="Oversight: all repos and agents (o)" title="Oversight: all repos and agents (o)"><LayoutGrid size={12} />Oversight</Button>
        <Button onClick={() => setPaletteOpen(true)} className="gap-1.5" aria-label="Search (⌘K)"><Command size={12} />Search</Button>
        <IconButton aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={theme} initial={{ rotate: -90, scale: 0.6, opacity: 0 }} animate={{ rotate: 0, scale: 1, opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </motion.span>
          </AnimatePresence>
        </IconButton>
      </div>
    </motion.header>
  )
}
