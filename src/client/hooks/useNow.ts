import { useSyncExternalStore } from 'react'

/**
 * One shared clock store per interval length. Components subscribing with `useNow(5000)`
 * re-render only every 5 s; a single `setInterval` per distinct interval is shared.
 */
interface Clock {
  now: number
  listeners: Set<() => void>
  timer: ReturnType<typeof setInterval> | null
}
const clocks = new Map<number, Clock>()

function getClock(interval: number): Clock {
  let c = clocks.get(interval)
  if (!c) {
    c = { now: Date.now(), listeners: new Set(), timer: null }
    clocks.set(interval, c)
  }
  return c
}

function subscribeTo(interval: number, cb: () => void): () => void {
  const c = getClock(interval)
  c.listeners.add(cb)
  if (!c.timer) {
    c.now = Date.now()
    c.timer = setInterval(() => {
      c.now = Date.now()
      c.listeners.forEach((l) => l())
    }, interval)
  }
  return () => {
    c.listeners.delete(cb)
    if (c.listeners.size === 0 && c.timer) {
      clearInterval(c.timer)
      c.timer = null
    }
  }
}

/** Current epoch ms, refreshed every `intervalMs` (default 1 s). */
export function useNow(intervalMs = 1000): number {
  return useSyncExternalStore(
    (cb) => subscribeTo(intervalMs, cb),
    () => getClock(intervalMs).now,
    () => Date.now(),
  )
}
