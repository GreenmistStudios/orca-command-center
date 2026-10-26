import { Command, Database, Flame, Moon, Radar, Sun } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCompact } from '../hooks/useCompact'
import { useNow } from '../hooks/useNow'
import { formatClock, formatRelative } from '../lib/format'
import { cn } from '../lib/cn'
import { selectFleetBurn, selectFleetPulse } from '../state/selectors'
import { useOcc, type ConnectionState } from '../state/store'
import type { SourceHealth, SourceStatus } from '../../shared/contract'
import { Button, IconButton } from '../ui/Button'
import { LiveDot } from '../ui/LiveDot'
import { Popover } from '../ui/Overlay'
import { Badge, StatusPill } from '../ui/Pills'
import { toneClasses } from '../ui/tones'
import { COST_DISCLAIMER } from '../ui/flow/CostDisclaimer'
import { formatCost, formatTokens } from '../lib/format'
import { Odometer } from '../ui/flow/Odometer'

const SPRING = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 } as const

const SOURCE_DOT: Record<SourceStatus, string> = {
  ok: 'bg-status-completed', starting: 'bg-status-ready', degraded: 'bg-status-dispatched', missing: 'bg-status-failed', error: 'bg-status-failed', disabled: 'bg-muted-foreground/40',
}

function OrcaPill() {
  const orca = useOcc((s) => s.orca?.status ?? s.meta?.orca ?? null)
  const live = !!orca?.running
  const checking = !live && !!orca && orca.checkedAt === 0 && !orca.error
  const unreachable = !live && !!orca?.error
  const short = (orca?.error ?? '').length > 60 ? `${orca!.error!.slice(0, 57)}…` : (orca?.error ?? '')
  return (
    <StatusPill
      data-testid="orca-pill"
      tone={live ? 'completed' : undefined}
      icon={checking ? undefined : <LiveDot live={live} />}
      style={live ? { boxShadow: '0 0 16px -6px color-mix(in oklch, var(--status-completed) 90%, transparent)' } : undefined}
    >
      {checking ? 'Checking Orca…' : live ? `Connected to a running Orca${orca?.pid ? ` (pid ${orca.pid})` : ''}.` : unreachable ? `Can’t reach Orca CLI (${short}) — retrying` : 'Orca isn’t running; showing last-known state.'}
    </StatusPill>
  )
}

function StreamPill({ connection }: { connection: ConnectionState }) {
  if (connection === 'reconnecting' || connection === 'offline') {
    return <StatusPill data-testid="stream-pill" tone="dispatched">{connection === 'offline' ? 'Stream offline' : 'Stream reconnecting…'}</StatusPill>
  }
  if (connection === 'connecting') return <StatusPill data-testid="stream-pill">Stream connecting…</StatusPill>
  return <StatusPill data-testid="stream-pill" icon={<span className="bg-status-completed size-1.5 rounded-full" />}>Live</StatusPill>
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

function BurnPill() {
  const b = useOcc(selectFleetBurn)
  const setView = useOcc((s) => s.setView)
  const setTokensPrefs = useOcc((s) => s.setTokensPrefs)
  const idle = b.costPerHour <= 0 && b.tokensPerMin <= 0 && b.inFlight === 0
  const glow = b.inFlight > 0
  const tip = `Fleet burn over the last 5 minutes. ${COST_DISCLAIMER}`
  return (
    <button
      type="button"
      data-testid="burn-pill"
      data-state={idle ? 'idle' : glow ? 'streaming' : 'active'}
      title={tip}
      aria-label={idle ? 'No token burn. Open token flow' : `Token burn ${formatCost(b.costPerHour)} per hour, ${formatTokens(b.tokensPerMin)} tokens per minute. Open token flow`}
      onClick={() => { setTokensPrefs({ scope: 'fleet' }); setView('tokens') }}
      className={cn('focus-ring flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium', idle ? 'text-muted-foreground border-panel-border/70' : 'border-panel-border')}
      style={glow ? { boxShadow: '0 0 16px -6px var(--flow-cost)' } : undefined}
    >
      <Flame size={12} aria-hidden style={idle ? undefined : { color: 'var(--flow-cost)' }} />
      {idle ? 'No token burn' : (
        <span className="flex items-baseline gap-1">
          <Odometer value={b.costPerHour} format="cost" size="sm" /><span>/h</span>
          <span className="opacity-40">·</span>
          <span className="tabular-nums">{formatTokens(b.tokensPerMin)} tok/min</span>
        </span>
      )}
    </button>
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

function SourceChips() {
  const sources = useOcc((s) => s.meta?.sources)
  if (!sources?.length) return null
  return (
    <Popover
      align="end"
      className="w-96"
      trigger={
        <button type="button" data-testid="source-chips" aria-label="Data sources" className="focus-ring flex items-center gap-1.5 rounded-full">
          {sources.map((s) => (
            <span key={s.id} data-testid={`source-chip-${s.id}`} className="bg-muted text-muted-foreground flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
              <Database size={11} />
              {s.label}{s.id === 'orca-orchestration' && s.version ? ` ${s.version}` : ''}
              <span className={cn('size-1.5 rounded-full', SOURCE_DOT[s.status])} />
            </span>
          ))}
        </button>
      }
    >
      <div className="section-label mb-1">Sources</div>
      <ul>{sources.map((s) => <SourceRow key={s.id} s={s} />)}</ul>
    </Popover>
  )
}

function SourcesPopover() {
  const sources = useOcc((s) => s.meta?.sources)
  const last = useOcc((s) => s.lastEventAt)
  const now = useNow(1000)
  return (
    <Popover
      align="end"
      className="w-80"
      trigger={<Button data-testid="sources-button" className="gap-1.5"><Database size={12} />Sources</Button>}
    >
      <div className="mb-2"><BurnPill /></div>
      <div className="section-label mb-1">Sources</div>
      <ul>{(sources ?? []).map((s) => <SourceRow key={s.id} s={s} />)}</ul>
      {last && <div className="text-muted-foreground pt-2">Last event {formatRelative(last, now) === 'now' ? 'just now' : formatRelative(last, now)}</div>}
    </Popover>
  )
}

function LastEvent() {
  const last = useOcc((s) => s.lastEventAt)
  const now = useNow(1000)
  if (!last) return null
  return <span data-testid="last-event" className="hidden lg:inline">Last event {formatRelative(last, now) === 'now' ? 'just now' : formatRelative(last, now)}</span>
}

/** App header (design-system §8.1). */
export function Header() {
  const connection = useOcc((s) => s.connection)
  const theme = useOcc((s) => s.ui.theme)
  const toggleTheme = useOcc((s) => s.toggleTheme)
  const compact = useCompact()
  const setPaletteOpen = useOcc((s) => s.setPaletteOpen)
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
      <OrcaPill />
      <StreamPill connection={connection} />
      <FleetPulse />
      {!compact && <BurnPill />}
      <div className="text-muted-foreground ml-auto flex items-center gap-3 text-[11px]">
        {compact ? <SourcesPopover /> : <><SourceChips /><LastEvent /></>}
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
