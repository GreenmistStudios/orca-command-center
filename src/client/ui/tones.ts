import type { ActivityKind, ActivityStatus, AgentState } from '../../shared/contract'
import { stableHash } from '../lib/hash'

/** Status tone = one of the orca-viz status palette tokens (design-system §3). */
export type Tone = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked' | 'unknown' | 'gate'

/** AgentState → tone (design-system §3.1). */
export function stateTone(s: AgentState): Tone {
  switch (s) {
    case 'working': return 'dispatched'
    case 'blocked': return 'gate'
    case 'waiting': return 'blocked'
    case 'error': return 'failed'
    case 'done': return 'completed'
    case 'idle': return 'pending'
    default: return 'unknown'
  }
}

/** Orchestration task / dispatch status → tone. Unknown values → 'unknown'; circuit_broken → 'failed'. */
export function orchStatusTone(s: string): Tone {
  switch (s) {
    case 'pending': case 'ready': case 'dispatched': case 'completed': case 'failed': case 'blocked':
      return s
    case 'circuit_broken': return 'failed'
    default: return 'unknown'
  }
}

export function activityStatusTone(s: ActivityStatus | null): Tone {
  switch (s) {
    case 'running': return 'dispatched'
    case 'completed': return 'completed'
    case 'error': return 'failed'
    case 'pending': return 'pending'
    default: return 'unknown'
  }
}

// Literal class strings so Tailwind's scanner sees them.
const TONE_CLASSES: Record<Tone, { surface: string; dot: string; border: string; text: string }> = {
  pending: { surface: 'bg-status-pending-soft text-status-pending-ink border-status-pending', dot: 'bg-status-pending', border: 'border-status-pending', text: 'text-status-pending-ink' },
  ready: { surface: 'bg-status-ready-soft text-status-ready-ink border-status-ready', dot: 'bg-status-ready', border: 'border-status-ready', text: 'text-status-ready-ink' },
  dispatched: { surface: 'bg-status-dispatched-soft text-status-dispatched-ink border-status-dispatched', dot: 'bg-status-dispatched', border: 'border-status-dispatched', text: 'text-status-dispatched-ink' },
  completed: { surface: 'bg-status-completed-soft text-status-completed-ink border-status-completed', dot: 'bg-status-completed', border: 'border-status-completed', text: 'text-status-completed-ink' },
  failed: { surface: 'bg-status-failed-soft text-status-failed-ink border-status-failed', dot: 'bg-status-failed', border: 'border-status-failed', text: 'text-status-failed-ink' },
  blocked: { surface: 'bg-status-blocked-soft text-status-blocked-ink border-status-blocked', dot: 'bg-status-blocked', border: 'border-status-blocked', text: 'text-status-blocked-ink' },
  unknown: { surface: 'bg-status-unknown-soft text-status-unknown-ink border-status-unknown border-dashed', dot: 'bg-status-unknown', border: 'border-status-unknown', text: 'text-status-unknown-ink' },
  gate: { surface: 'bg-status-gate-soft text-status-gate-ink border-status-gate', dot: 'bg-status-gate', border: 'border-status-gate', text: 'text-status-gate-ink' },
}

/** Class groups + CSS accent variable for a tone. */
export function toneClasses(t: Tone): { surface: string; dot: string; border: string; text: string; accentVar: string } {
  return { ...TONE_CLASSES[t], accentVar: `var(--status-${t})` }
}

export function kindColorVar(k: ActivityKind): string {
  return `var(--kind-${k})`
}

/** 1..8 by stable hash of the agent name; 0 when the agent is unknown. */
export function agentColorIndex(agent: string | null): number {
  if (!agent) return 0
  return (stableHash(agent) % 8) + 1
}

export function agentColorVar(agent: string | null): string {
  const i = agentColorIndex(agent)
  return i === 0 ? 'color-mix(in oklch, currentColor 22%, transparent)' : `var(--agent-${i})`
}

/** Initials of hyphen/space parts when ≥ 2 parts (`sonnet-coder` → `SC`), else first two letters. */
export function agentMonogram(agent: string | null): string {
  if (!agent) return '··'
  const parts = agent.split(/[-_\s]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return agent.slice(0, 2).toUpperCase()
}

export const STATE_LABEL: Record<AgentState, string> = {
  working: 'Working',
  blocked: 'Needs permission',
  waiting: 'Waiting for you',
  error: 'Error',
  done: 'Done',
  idle: 'Idle',
  unknown: 'Unknown',
}
