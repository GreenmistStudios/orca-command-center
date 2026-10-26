/** One shared requestAnimationFrame loop for every flow animation (Plan §6). */

export type FrameCallback = (now: number, dt: number) => void

export interface FrameStats {
  /** Exponential moving average of frames per second. */
  fps: number
  lastFrameMs: number
}

const subs = new Set<FrameCallback>()
let raf = 0
let last = 0
const stats: FrameStats = { fps: 0, lastFrameMs: 0 }
let visibilityBound = false

function publish(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { __occFrameStats?: FrameStats }
  let on = false
  try {
    on = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV) || /[?&]perf=1/.test(window.location.search)
  } catch { /* ignore */ }
  if (on) w.__occFrameStats = stats
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

function tick(ts: number): void {
  raf = 0
  if (subs.size === 0 || hidden()) { last = 0; return }
  const dt = last ? Math.min(ts - last, 100) : 16.7
  last = ts
  if (dt > 0) {
    stats.lastFrameMs = dt
    const inst = 1000 / dt
    stats.fps = stats.fps ? stats.fps * 0.9 + inst * 0.1 : inst
  }
  publish()
  for (const cb of [...subs]) cb(ts, dt)
  schedule()
}

function schedule(): void {
  if (raf || subs.size === 0 || hidden() || typeof requestAnimationFrame === 'undefined') return
  raf = requestAnimationFrame(tick)
}

function onVisibility(): void {
  if (hidden()) {
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    last = 0
  } else {
    schedule()
  }
}

/** Subscribe to the shared loop. Returns an unsubscribe; the loop stops with no subscribers. */
export function subscribeFrame(cb: FrameCallback): () => void {
  subs.add(cb)
  if (!visibilityBound && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
    visibilityBound = true
  }
  schedule()
  return () => {
    subs.delete(cb)
    if (subs.size === 0 && raf) { cancelAnimationFrame(raf); raf = 0; last = 0 }
  }
}

export function getFrameStats(): FrameStats {
  return { ...stats }
}

/** Test hook. */
export function frameSubscriberCount(): number {
  return subs.size
}
