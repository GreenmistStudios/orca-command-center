import type { ActivityEvent, SessionSummary } from '../../../shared/contract'

/** Pure timeline geometry (no React). Times are epoch ms; x values are px within the track. */

export interface Scale { t0: number; t1: number; width: number; x(t: number): number; t(x: number): number }

export function makeScale(t0: number, t1: number, width: number): Scale {
  const span = Math.max(1, t1 - t0)
  const w = Math.max(1, width)
  return { t0, t1, width: w, x: (t) => ((t - t0) / span) * w, t: (x) => t0 + (x / w) * span }
}

export const MIN_BLOCK_PX = 3
export const TICK_PX = 6
export const MAX_SUBROWS = 3

/** End of an activity for layout: running items extend to `now`; no end → instantaneous (start). */
export function blockEnd(e: Pick<ActivityEvent, 'ts' | 'endTs' | 'status'>, now: number): number {
  if (e.endTs != null) return Math.max(e.endTs, e.ts)
  if (e.status === 'running') return Math.max(now, e.ts)
  return e.ts
}
export const isInstant = (e: Pick<ActivityEvent, 'endTs' | 'status'>) => e.endTs == null && e.status !== 'running'

/** Right edge of a session's span bar: now while live, else its last activity. */
export function sessionSpanEnd(s: Pick<SessionSummary, 'live' | 'lastActivityAt' | 'updatedAt' | 'createdAt'>, now: number): number {
  if (s.live) return Math.max(now, s.createdAt)
  return Math.max(s.lastActivityAt ?? s.updatedAt, s.createdAt)
}

/** Lanes in spawn order: root first, then DFS with children sorted by createdAt (ties by id). Orphans are appended. */
export function orderLanes(sessions: SessionSummary[], rootId: string): Array<{ session: SessionSummary; depth: number }> {
  const byParent = new Map<string, SessionSummary[]>()
  const byId = new Map<string, SessionSummary>()
  for (const s of sessions) {
    byId.set(s.id, s)
    if (s.parentId) { const a = byParent.get(s.parentId); if (a) a.push(s); else byParent.set(s.parentId, [s]) }
  }
  for (const a of byParent.values()) a.sort((p, q) => p.createdAt - q.createdAt || p.id.localeCompare(q.id))
  const out: Array<{ session: SessionSummary; depth: number }> = []
  const seen = new Set<string>()
  const walk = (s: SessionSummary, depth: number) => {
    if (seen.has(s.id)) return
    seen.add(s.id)
    out.push({ session: s, depth })
    for (const c of byParent.get(s.id) ?? []) walk(c, depth + 1)
  }
  const root = byId.get(rootId)
  if (root) walk(root, 0)
  for (const s of sessions) if (!seen.has(s.id)) walk(s, Math.max(1, s.depth))
  return out
}

export interface PackItem { id: string; start: number; end: number }

/**
 * Greedy interval packing into ≤ `maxRows` sub-rows. `minMs` is the minimum visual width in time
 * units. Items that fit nowhere merge into the last row. Returns id → row and the row count.
 */
export function packSubRows(items: PackItem[], minMs: number, maxRows = MAX_SUBROWS): { rows: Map<string, number>; count: number } {
  const sorted = items.slice().sort((a, b) => a.start - b.start || a.end - b.end)
  const ends: number[] = []
  const rows = new Map<string, number>()
  for (const it of sorted) {
    const end = Math.max(it.end, it.start + minMs)
    let r = ends.findIndex((e) => e <= it.start)
    if (r < 0) {
      if (ends.length < maxRows) { ends.push(end); r = ends.length - 1 } else r = maxRows - 1
    }
    ends[r] = Math.max(ends[r] ?? 0, end)
    rows.set(it.id, r)
  }
  return { rows, count: Math.max(1, ends.length) }
}

export interface Tick { t: number; label: string; major: boolean }

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * 1000)
const p2 = (n: number) => String(n).padStart(2, '0')

export function chooseStep(spanMs: number, targetTicks: number): number {
  const want = spanMs / Math.max(1, targetTicks)
  return STEPS.find((s) => s >= want) ?? STEPS[STEPS.length - 1]
}

/** Adaptive axis ticks aligned to local-time multiples of the step. */
export function generateTicks(t0: number, t1: number, targetTicks: number): Tick[] {
  if (!(t1 > t0)) return []
  const step = chooseStep(t1 - t0, targetTicks)
  const offset = new Date(t0).getTimezoneOffset() * 60_000
  const first = Math.ceil((t0 - offset) / step) * step + offset
  const out: Tick[] = []
  for (let t = first; t <= t1 && out.length < 200; t += step) {
    const d = new Date(t)
    const label = step < 60_000 ? `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` : `${p2(d.getHours())}:${p2(d.getMinutes())}`
    out.push({ t, label, major: step >= 3_600_000 ? d.getMinutes() === 0 : step >= 60_000 ? d.getMinutes() % 15 === 0 : d.getSeconds() === 0 })
  }
  return out
}

/** Zoom `[t0,t1]` by `factor` (<1 zooms in) keeping time `anchor` at the same fractional position. */
export function zoomRange(t0: number, t1: number, factor: number, anchor: number, minSpan = 2000, maxSpan = 1000 * 86400 * 30): [number, number] {
  const span = t1 - t0
  const next = Math.min(maxSpan, Math.max(minSpan, span * factor))
  const f = span > 0 ? (anchor - t0) / span : 0.5
  const n0 = anchor - f * next
  return [n0, n0 + next]
}
