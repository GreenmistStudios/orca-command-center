import type { ActivityEvent, ActivityKind, ActivityPage, EpochMs } from '../../shared/contract.js'

export interface RingQuery {
  sessionIds?: Iterable<string>
  kinds?: ActivityKind[]
  before?: string
  sinceMs?: EpochMs
  limit: number
  /** Extra predicate (e.g. restrict to non-harness sources). */
  filter?: (e: ActivityEvent) => boolean
}

export const cursorOf = (e: Pick<ActivityEvent, 'ts' | 'id'>): string => `${e.ts}:${e.id}`

export function parseCursor(cursor: string): { ts: number; id: string } | null {
  const i = cursor.indexOf(':')
  if (i < 0) return null
  const ts = Number(cursor.slice(0, i))
  if (!Number.isFinite(ts)) return null
  return { ts, id: cursor.slice(i + 1) }
}

export const compareEvents = (a: ActivityEvent, b: ActivityEvent): number =>
  a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Bounded, id-upserting, time-ordered activity buffer (Plan §9.6). */
export class Ring {
  private events: ActivityEvent[] = []
  private byId = new Map<string, ActivityEvent>()
  private bySession = new Map<string, Set<string>>()

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.byId.size
  }

  get(id: string): ActivityEvent | undefined {
    return this.byId.get(id)
  }

  private indexAdd(e: ActivityEvent): void {
    if (!e.sessionId) return
    let set = this.bySession.get(e.sessionId)
    if (!set) this.bySession.set(e.sessionId, (set = new Set()))
    set.add(e.id)
  }

  private indexRemove(e: ActivityEvent): void {
    if (!e.sessionId) return
    const set = this.bySession.get(e.sessionId)
    if (!set) return
    set.delete(e.id)
    if (set.size === 0) this.bySession.delete(e.sessionId)
  }

  private findIndex(e: ActivityEvent): number {
    let lo = 0
    let hi = this.events.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareEvents(this.events[mid]!, e) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Upsert one event. Returns the stored event, or null when an equal/newer rev already exists. */
  upsert(e: ActivityEvent): ActivityEvent | null {
    const prev = this.byId.get(e.id)
    if (prev) {
      if (e.rev < prev.rev) return null
      const i = this.findIndex(prev)
      if (this.events[i] === prev) this.events.splice(i, 1)
      this.indexRemove(prev)
    }
    this.byId.set(e.id, e)
    this.events.splice(this.findIndex(e), 0, e)
    this.indexAdd(e)
    this.evict()
    return e
  }

  upsertMany(list: ActivityEvent[]): ActivityEvent[] {
    if (list.length < 40) {
      const out: ActivityEvent[] = []
      for (const e of list) {
        const s = this.upsert(e)
        if (s) out.push(s)
      }
      return out
    }
    const out: ActivityEvent[] = []
    for (const e of list) {
      const prev = this.byId.get(e.id)
      if (prev && e.rev < prev.rev) continue
      if (prev) this.indexRemove(prev)
      this.byId.set(e.id, e)
      this.indexAdd(e)
      out.push(e)
    }
    this.events = [...this.byId.values()].sort(compareEvents)
    this.evict()
    return out
  }

  private evict(): void {
    const extra = this.events.length - this.capacity
    if (extra <= 0) return
    for (const e of this.events.splice(0, extra)) {
      this.byId.delete(e.id)
      this.indexRemove(e)
    }
  }

  removeWhere(pred: (e: ActivityEvent) => boolean): number {
    const keep: ActivityEvent[] = []
    let removed = 0
    for (const e of this.events) {
      if (pred(e)) {
        this.byId.delete(e.id)
        this.indexRemove(e)
        removed++
      } else keep.push(e)
    }
    this.events = keep
    return removed
  }

  /** All events, oldest → newest (do not mutate). */
  all(): readonly ActivityEvent[] {
    return this.events
  }

  query(q: RingQuery): ActivityPage {
    const kinds = q.kinds && q.kinds.length ? new Set(q.kinds) : null
    const cur = q.before ? parseCursor(q.before) : null
    const ids = q.sessionIds ? new Set(q.sessionIds) : null
    const picked: ActivityEvent[] = []
    let hasMore = false
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!
      if (cur && (e.ts > cur.ts || (e.ts === cur.ts && e.id >= cur.id))) continue
      if (q.sinceMs !== undefined && e.ts < q.sinceMs) break
      if (ids && (!e.sessionId || !ids.has(e.sessionId))) continue
      if (kinds && !kinds.has(e.kind)) continue
      if (q.filter && !q.filter(e)) continue
      if (picked.length >= q.limit) {
        hasMore = true
        break
      }
      picked.push(e)
    }
    picked.reverse()
    return { events: picked, before: hasMore && picked.length ? cursorOf(picked[0]!) : null, hasMore }
  }
}
