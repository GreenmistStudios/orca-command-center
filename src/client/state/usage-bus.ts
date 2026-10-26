import type { UsageEstimate, UsageSample } from '../../shared/contract'

export interface UsageBusEvent {
  samples: UsageSample[]
  estimates: UsageEstimate[]
}

type Listener = (ev: UsageBusEvent) => void

/**
 * Tiny synchronous, non-React emitter for live usage (animation engines subscribe here so no
 * React state changes per call/estimate). A throwing listener never breaks the others.
 */
const listeners = new Set<Listener>()

export const usageBus = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
  emit(ev: UsageBusEvent): void {
    for (const fn of [...listeners]) {
      try { fn(ev) } catch (err) { console.error('[occ] usageBus listener failed', err) }
    }
  },
  /** Test helper. */
  clear(): void { listeners.clear() },
}
