import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent, ServerMeta, SessionSummary, StreamEvent } from '../../shared/contract.js'
import { createHub, type HubClient } from './hub.js'

const meta = { app: 'orca-command-center' } as ServerMeta

function client(): HubClient & { frames: string[]; ended: boolean; buffered: number } {
  const c = {
    frames: [] as string[],
    ended: false,
    buffered: 0,
    write(f: string) {
      c.frames.push(f)
      return true
    },
    end() {
      c.ended = true
    },
    get writableLength() {
      return c.buffered
    },
  }
  return c
}
const events = (c: { frames: string[] }) =>
  c.frames.map((f) => JSON.parse(f.split('\ndata: ')[1]!.trim()) as StreamEvent)
const ev = (id: string, rev: number, title = ''): ActivityEvent => ({ id, rev, title }) as ActivityEvent
const sess = (id: string, title = ''): SessionSummary => ({ id, title }) as SessionSummary

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('hub', () => {
  it('sends hello first with current seq id and bootId', () => {
    const hub = createHub({ meta: () => meta })
    const c = client()
    hub.subscribe(null, c)
    expect(c.frames[0]).toMatch(/^id: 0\ndata: /)
    expect(events(c)[0]).toMatchObject({ type: 'hello', seq: 0, bootId: hub.bootId })
    expect(c.frames).toHaveLength(1)
  })

  it('coalesces activity by id keeping highest rev', () => {
    const hub = createHub({ meta: () => meta })
    const c = client()
    hub.subscribe(null, c)
    hub.publish({ type: 'activity', events: [ev('a', 2, 'new'), ev('b', 1)] })
    hub.publish({ type: 'activity', events: [ev('a', 1, 'old'), ev('b', 1, 'later-tie')] })
    vi.advanceTimersByTime(250)
    const e = events(c)[1] as Extract<StreamEvent, { type: 'activity' }>
    expect(e.seq).toBe(1)
    expect(e.events.find((x) => x.id === 'a')!.title).toBe('new')
    expect(e.events.find((x) => x.id === 'b')!.title).toBe('later-tie')
  })

  it('coalesces sessions and removals', () => {
    const hub = createHub({ meta: () => meta })
    const c = client()
    hub.subscribe(null, c)
    hub.publish({ type: 'sessions', sessions: [sess('s1', 'x')], removed: ['s2', 's3'] })
    hub.publish({ type: 'sessions', sessions: [sess('s1', 'y'), sess('s3')], removed: ['s4'] })
    vi.advanceTimersByTime(250)
    const e = events(c)[1] as Extract<StreamEvent, { type: 'sessions' }>
    expect(e.sessions.map((s) => [s.id, s.title])).toEqual([['s1', 'y'], ['s3', '']])
    expect(e.removed.sort()).toEqual(['s2', 's4'])
  })

  it('merges orca, orchestration, and last-wins types', () => {
    const hub = createHub({ meta: () => meta })
    const c = client()
    hub.subscribe(null, c)
    hub.publish({ type: 'orca', orca: { worktrees: [] } })
    hub.publish({ type: 'orca', orca: { terminals: [], worktrees: [{ id: 'w' } as never] } })
    hub.publish({ type: 'orchestration', summary: { v: 1 } as never, changedRunIds: ['r1'] })
    hub.publish({ type: 'orchestration', summary: { v: 2 } as never, changedRunIds: ['r2', 'r1'] })
    hub.publish({ type: 'attention', items: [{ id: 1 } as never] })
    hub.publish({ type: 'attention', items: [{ id: 2 } as never] })
    hub.publish({ type: 'stats', stats: { n: 1 } as never })
    hub.publish({ type: 'meta', meta: { app: 'm' } as never })
    vi.advanceTimersByTime(250)
    const [, orca, orch, att, stats, m] = events(c) as any[]
    expect(orca.orca).toEqual({ worktrees: [{ id: 'w' }], terminals: [] })
    expect(orch.summary).toEqual({ v: 2 })
    expect(orch.changedRunIds.sort()).toEqual(['r1', 'r2'])
    expect(att.items).toEqual([{ id: 2 }])
    expect(stats.stats).toEqual({ n: 1 })
    expect(m.meta.app).toBe('m')
    expect(events(c).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(hub.seq).toBe(5)
  })

  it('replays within the window and resyncs outside it', () => {
    const hub = createHub({ meta: () => meta, replaySize: 3 })
    for (let i = 1; i <= 5; i++) {
      hub.publish({ type: 'attention', items: [{ id: i } as never] })
      vi.advanceTimersByTime(250)
    }
    expect(hub.seq).toBe(5)
    // ring holds seq 3..5
    const replay = client()
    hub.subscribe(3, replay)
    expect(events(replay).map((e) => [e.type, e.seq])).toEqual([['hello', 5], ['attention', 4], ['attention', 5]])

    const edge = client()
    hub.subscribe(2, edge)
    expect(events(edge).map((e) => e.seq)).toEqual([5, 3, 4, 5])

    const old = client()
    hub.subscribe(1, old)
    expect(events(old)[1]).toMatchObject({ type: 'resync', reason: 'cursor-too-old' })

    const ahead = client()
    hub.subscribe(99, ahead)
    expect(events(ahead)[1]).toMatchObject({ type: 'resync', reason: 'cursor-ahead' })
    expect(ahead.frames[1]).toMatch(/^id: 5\n/)

    const same = client()
    hub.subscribe(5, same)
    expect(same.frames).toHaveLength(1)
  })

  it('drops clients over the buffer limit', () => {
    const hub = createHub({ meta: () => meta, maxBufferedBytes: 100 })
    const slow = client()
    const ok = client()
    hub.subscribe(null, slow)
    hub.subscribe(null, ok)
    slow.buffered = 1000
    hub.publish({ type: 'attention', items: [] })
    vi.advanceTimersByTime(250)
    expect(slow.ended).toBe(true)
    expect(hub.clientCount()).toBe(1)
    expect(ok.frames).toHaveLength(2)
  })

  it('unsubscribe and close', () => {
    const hub = createHub({ meta: () => meta })
    const c = client()
    const un = hub.subscribe(null, c)
    expect(hub.clientCount()).toBe(1)
    un()
    expect(hub.clientCount()).toBe(0)
    const d = client()
    hub.subscribe(null, d)
    hub.close()
    expect(d.ended).toBe(true)
  })
})

describe('hub usage coalescing', () => {
  const sample = (id: string, ledgerSeq: number, cost = 0) => ({ id, ledgerSeq, cost }) as never
  const est = (sessionId: string, updatedAt: number, inFlight: boolean) => ({ sessionId, updatedAt, inFlight }) as never

  it('merges samples by id (highest ledgerSeq) and estimates by session (latest updatedAt, end wins)', () => {
    const hub = createHub({ meta: () => meta })
    const c = client()
    hub.subscribe(null, c)
    hub.publish({ type: 'usage', samples: [sample('a', 2, 5), sample('b', 1)], estimates: [est('s1', 10, true), est('s2', 10, true)] })
    hub.publish({ type: 'usage', samples: [sample('a', 1, 1), sample('c', 3)], estimates: [est('s1', 20, false), est('s2', 5, false)] })
    hub.publish({ type: 'usage', samples: [], estimates: [est('s1', 15, true)] })
    vi.advanceTimersByTime(250)
    const frames = events(c).filter((e) => e.type === 'usage') as Array<Extract<StreamEvent, { type: 'usage' }>>
    expect(frames).toHaveLength(1)
    const f = frames[0]!
    expect(f.samples.map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
    expect(f.samples.find((s) => s.id === 'a')).toMatchObject({ ledgerSeq: 2, cost: 5 })
    expect(f.estimates.find((e) => e.sessionId === 's1')).toMatchObject({ updatedAt: 20, inFlight: false })
    expect(f.estimates.find((e) => e.sessionId === 's2')).toMatchObject({ updatedAt: 10, inFlight: true })
  })

  it('an end estimate wins an updatedAt tie', () => {
    const hub = createHub({ meta: () => meta })
    const c = client()
    hub.subscribe(null, c)
    hub.publish({ type: 'usage', samples: [], estimates: [est('s', 10, true)] })
    hub.publish({ type: 'usage', samples: [], estimates: [est('s', 10, false)] })
    vi.advanceTimersByTime(250)
    const f = events(c).find((e) => e.type === 'usage') as Extract<StreamEvent, { type: 'usage' }>
    expect(f.estimates[0]!.inFlight).toBe(false)
  })
})
