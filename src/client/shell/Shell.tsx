import { ChevronDown, ChevronUp } from 'lucide-react'
import { motion } from 'motion/react'
import { useRef, useState, type ReactNode } from 'react'
import { AttentionStrip } from '../attention/AttentionStrip'
import { useCompact } from '../hooks/useCompact'
import { Rail } from '../rail/Rail'
import { RAIL_MAX, RAIL_MIN } from '../state/store'
import { useOcc } from '../state/store'
import { Banner } from './Banner'
import { CenterView } from './CenterView'
import { Dock } from './Dock'
import { Header } from './Header'
import { Splash } from './Splash'
import { ViewTabs } from './ViewTabs'

const CONNECTION_TEXT = { connecting: 'Stream connecting', live: 'Stream live', reconnecting: 'Stream reconnecting', offline: 'Stream offline' } as const

/** Fold-out band used for the rail and dock in the compact layout. */
function FoldBand({ label, open, onToggle, children, className }: { label: string; open: boolean; onToggle: () => void; children: ReactNode; className?: string }) {
  const Icon = open ? ChevronUp : ChevronDown
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <button type="button" aria-expanded={open} onClick={onToggle} data-testid={`fold-${label.toLowerCase()}`} className="panel focus-ring flex h-8 items-center justify-between px-3 text-xs font-medium">
        {label}<Icon size={14} />
      </button>
      {open && <div className={className}>{children}</div>}
    </div>
  )
}

/**
 * Layout (design-system §8): field background, header, banner, then rail | center | dock.
 * Below 1024 px (compact) the rail and dock become fold-out bands above/below the view.
 * Shows the splash until the first bootstrap has been applied.
 */
export function Shell() {
  const ready = useOcc((s) => s.bootstrapped)
  const connection = useOcc((s) => s.connection)
  const compact = useCompact()
  const [railOpen, setRailOpen] = useState(false)
  const [dockOpen, setDockOpen] = useState(false)
  const railWidth = useOcc((s) => s.ui.railWidth)
  const setRailWidth = useOcc((s) => s.setRailWidth)
  const railDrag = useRef<{ x: number; w: number } | null>(null)
  if (!ready) return <Splash />
  return (
    <div className="relative isolate flex h-full flex-col gap-2 p-2" data-testid="shell" data-compact={compact}>
      <a href="#center-view" className="focus-ring bg-panel-solid sr-only z-50 rounded-lg px-3 py-1.5 text-xs focus:not-sr-only focus:absolute focus:top-2 focus:left-2">Skip to view</a>
      <div aria-hidden className="field-bg bg-field absolute inset-0 -z-10" />
      <div role="status" aria-live="polite" className="sr-only" data-testid="connection-live">{CONNECTION_TEXT[connection]}</div>
      <Header />
      <Banner />
      <div className={compact ? 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto' : 'flex min-h-0 flex-1 gap-2'}>
        {/* Plain wrapper: the Rail renders its own <nav aria-label="Fleet"> landmark. */}
        <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 34, mass: 0.9 }} style={compact ? undefined : { width: railWidth }} className={compact ? 'contents' : 'relative flex shrink-0'}>
          {compact ? (
            <FoldBand label="Rail" open={railOpen} onToggle={() => setRailOpen((v) => !v)} className="flex max-h-[45dvh]"><Rail /></FoldBand>
          ) : (
            <>
              <Rail />
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize rail"
                aria-valuemin={RAIL_MIN}
                aria-valuemax={RAIL_MAX}
                aria-valuenow={railWidth}
                tabIndex={0}
                data-testid="rail-handle"
                className="focus-ring hover:bg-selection/30 absolute inset-y-0 -right-1.5 z-10 w-1.5 cursor-col-resize"
                onPointerDown={(e) => { railDrag.current = { x: e.clientX, w: railWidth }; e.currentTarget.setPointerCapture(e.pointerId) }}
                onPointerMove={(e) => { if (railDrag.current) setRailWidth(railDrag.current.w + (e.clientX - railDrag.current.x)) }}
                onPointerUp={() => { railDrag.current = null }}
                onPointerCancel={() => { railDrag.current = null }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') { e.preventDefault(); setRailWidth(railWidth + 24) }
                  if (e.key === 'ArrowLeft') { e.preventDefault(); setRailWidth(railWidth - 24) }
                }}
              />
            </>
          )}
        </motion.div>
        <main id="main-view" className="flex min-h-[24rem] min-w-0 flex-1 flex-col gap-2">
          <AttentionStrip />
          <ViewTabs />
          <CenterView />
        </main>
        {compact ? (
          <FoldBand label="Dock" open={dockOpen} onToggle={() => setDockOpen((v) => !v)} className="flex max-h-[min(60dvh,32rem)]"><Dock /></FoldBand>
        ) : <Dock />}
      </div>
    </div>
  )
}
