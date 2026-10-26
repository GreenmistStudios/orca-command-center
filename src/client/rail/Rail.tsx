import { useOcc } from '../state/store'
import { selectRootSessions } from '../state/selectors'
import { EmptyState } from '../ui/EmptyState'
import { StateDot } from '../ui/LiveDot'
import { SectionLabel } from '../ui/Panel'
import { cn } from '../lib/cn'

/**
 * PLACEHOLDER — Task-9 replaces this with the FLEET rail. Contract: renders a `nav.panel` that fills
 * its wrapper (the shell provides the 18rem width).
 */
export function Rail() {
  const roots = useOcc(selectRootSessions)
  const selected = useOcc((s) => s.ui.selectedRootId)
  const selectRoot = useOcc((s) => s.selectRoot)
  return (
    <nav aria-label="Fleet" className="panel flex h-full w-full flex-col overflow-hidden">
      <div className="panel-header">
        <div className="flex items-center justify-between"><SectionLabel>Fleet</SectionLabel><span className="text-muted-foreground/70 text-[11px] tabular-nums">{roots.length}</span></div>
      </div>
      {roots.length === 0 ? (
        <EmptyState title="No agent sessions in the last 24 h." hint="Rail — Task-9" />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {roots.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => selectRoot(r.id)}
                className={cn('focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold hover:bg-accent/60', selected === r.id && 'bg-selection-soft/70')}
              >
                <StateDot state={r.state} />
                <span className="truncate">{r.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="text-muted-foreground/60 border-t border-panel-border/60 px-4 py-2 text-[10px]">Rail — Task-9 placeholder</div>
    </nav>
  )
}
