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

/**
 * Stable subscribe function per interval. useSyncExternalStore re-subscribes whenever the
 * subscribe identity changes; an inline closure would resubscribe on every render, restart the
 * timer (which refreshes `now`), change the snapshot and re-render again — an update loop.
 */
const subscribers = new Map<number, (cb: () => void) => () => void>()

function getSubscribe(interval: number): (cb: () => void) => () => void {
  let subscribe = subscribers.get(interval)
  if (!subscribe) {
    subscribe = (cb) => subscribeTo(interval, cb)
    subscribers.set(interval, subscribe)
  }
  return subscribe
}

/** Current epoch ms, refreshed every `intervalMs` (default 1 s). */
export function useNow(intervalMs = 1000): number {
  return useSyncExternalStore(
    getSubscribe(intervalMs),
    () => getClock(intervalMs).now,
    () => Date.now(),
  )
}
