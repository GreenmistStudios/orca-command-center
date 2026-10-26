import { cn } from '../lib/cn'
import { stateTone, toneClasses } from './tones'
import type { AgentState } from '../../shared/contract'

/** 6px dot (8px with `size={8}`); live = green with two radar rings, else muted. */
export function LiveDot({ live, size = 6, className }: { live: boolean; size?: 6 | 8; className?: string }) {
  const px = size === 8 ? 'size-2' : 'size-1.5'
  return (
    <span
      data-testid="live-dot"
      data-live={live}
      className={cn('relative inline-flex shrink-0 rounded-full', px, live ? 'bg-status-completed' : 'bg-muted-foreground/40', className)}
    >
      {live && (
        <>
          <span className="absolute inset-0 rounded-full bg-status-completed" style={{ animation: 'orca-radar 2s ease-out infinite' }} />
          <span className="absolute inset-0 rounded-full bg-status-completed" style={{ animation: 'orca-radar 2s ease-out 1s infinite' }} />
        </>
      )}
    </span>
  )
}

/** Agent-state dot: tone-colored; `working` pulses like a LiveDot in amber. */
export function StateDot({ state, size = 8, className }: { state: AgentState; size?: 6 | 8; className?: string }) {
  const tone = stateTone(state)
  const px = size === 8 ? 'size-2' : 'size-1.5'
  return (
    <span data-testid="state-dot" data-state={state} className={cn('relative inline-flex shrink-0 rounded-full', px, toneClasses(tone).dot, className)}>
      {state === 'working' && (
        <span className={cn('absolute inset-0 rounded-full', toneClasses(tone).dot)} style={{ animation: 'orca-radar 2s ease-out infinite' }} />
      )}
    </span>
  )
}
