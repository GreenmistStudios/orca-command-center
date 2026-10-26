import type { CSSProperties } from 'react'
import { HARNESS_META, type Harness } from '../../shared/contract'
import { cn } from '../lib/cn'
import { agentColorVar, agentMonogram } from './tones'

const TEXT: Record<number, string> = { 17: 'text-[8.5px]', 20: 'text-[9.5px]', 24: 'text-[10px]' }

/** Agent identity tile: color by agent-name hash, first-letters monogram. */
export function AgentMonogram({ agent, size = 20, className }: { agent: string | null; size?: 17 | 20 | 24; className?: string }) {
  const style: CSSProperties = {
    width: size, height: size,
    background: agentColorVar(agent),
    color: agent ? 'var(--agent-ink)' : 'var(--muted-foreground)',
  }
  return (
    <span data-testid="agent-monogram" title={agent ?? 'unknown agent'} className={cn('monogram', TEXT[size], className)} style={style}>
      {agentMonogram(agent)}
    </span>
  )
}

/** Harness tile (OC / CP / CC / CX / ??), design-system §7.2. */
export function HarnessTile({ harness, size = 17, className }: { harness: Harness; size?: 17 | 20 | 24; className?: string }) {
  return (
    <span
      data-testid="harness-tile"
      title={HARNESS_META[harness].label}
      className={cn('monogram', TEXT[size], className)}
      style={{ width: size, height: size, background: `var(--harness-${harness}-bg)`, color: `var(--harness-${harness}-fg)` }}
    >
      {HARNESS_META[harness].monogram}
    </span>
  )
}
