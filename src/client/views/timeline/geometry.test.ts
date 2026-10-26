import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../../shared/contract'
import { blockEnd, chooseStep, generateTicks, isInstant, makeScale, orderLanes, packSubRows, sessionSpanEnd, zoomRange } from './geometry'

const S = (id: string, parentId: string | null, createdAt: number, depth = 0) => ({ id, parentId, createdAt, depth, rootId: 'r' }) as SessionSummary

describe('scale', () => {
  it('maps time to x and back', () => {
    const s = makeScale(1000, 2000, 500)
    expect(s.x(1000)).toBe(0)
    expect(s.x(1500)).toBe(250)
    expect(s.t(500)).toBe(2000)
  })
})

describe('live extension', () => {
  it('extends running items to now, keeps instants', () => {
    expect(blockEnd({ ts: 10, endTs: null, status: 'running' }, 50)).toBe(50)
    expect(blockEnd({ ts: 10, endTs: 20, status: 'completed' }, 50)).toBe(20)
    expect(blockEnd({ ts: 10, endTs: null, status: 'completed' }, 50)).toBe(10)
    expect(isInstant({ endTs: null, status: 'completed' })).toBe(true)
    expect(isInstant({ endTs: null, status: 'running' })).toBe(false)
  })
  it('session span extends to now while live', () => {
    expect(sessionSpanEnd({ live: true, lastActivityAt: 20, updatedAt: 20, createdAt: 5 }, 99)).toBe(99)
    expect(sessionSpanEnd({ live: false, lastActivityAt: 20, updatedAt: 30, createdAt: 5 }, 99)).toBe(20)
  })
})

describe('orderLanes', () => {
  it('orders root first then DFS by spawn time', () => {
    const lanes = orderLanes([S('c2', 'r', 30, 1), S('g', 'c1', 25, 2), S('c1', 'r', 20, 1), S('r', null, 0)], 'r')
    expect(lanes.map((l) => `${l.session.id}:${l.depth}`)).toEqual(['r:0', 'c1:1', 'g:2', 'c2:1'])
  })
})

describe('packSubRows', () => {
  it('stacks overlaps and reuses rows', () => {
    const { rows, count } = packSubRows([{ id: 'a', start: 0, end: 10 }, { id: 'b', start: 5, end: 15 }, { id: 'c', start: 12, end: 20 }], 0)
    expect(count).toBe(2)
    expect([rows.get('a'), rows.get('b'), rows.get('c')]).toEqual([0, 1, 0])
  })
  it('caps at 3 rows and merges overflow', () => {
    const items = [0, 1, 2, 3, 4].map((i) => ({ id: `i${i}`, start: i, end: 100 }))
    const { rows, count } = packSubRows(items, 0)
    expect(count).toBe(3)
    expect(Math.max(...rows.values())).toBe(2)
  })
  it('respects minimum visual width', () => {
    const { count } = packSubRows([{ id: 'a', start: 0, end: 0 }, { id: 'b', start: 1, end: 1 }], 5)
    expect(count).toBe(2)
  })
})

describe('ticks', () => {
  it('picks adaptive steps', () => {
    expect(chooseStep(60_000, 6)).toBe(10_000)
    expect(chooseStep(3_600_000, 6)).toBe(600_000)
    expect(chooseStep(86_400_000, 6)).toBe(21_600_000)
  })
  it('generates aligned ticks inside the range', () => {
    const t0 = new Date(2026, 9, 26, 12, 0, 3).getTime()
    const ticks = generateTicks(t0, t0 + 60_000, 6)
    expect(ticks.length).toBeGreaterThan(3)
    expect(ticks.every((t) => t.t >= t0 && t.t <= t0 + 60_000 && new Date(t.t).getSeconds() % 10 === 0)).toBe(true)
    expect(ticks[0].label).toBe('12:00:10')
  })
})

describe('zoomRange', () => {
  it('keeps the anchor fixed', () => {
    const [a, b] = zoomRange(0, 100_000, 0.5, 25_000)
    expect(b - a).toBe(50_000)
    expect((25_000 - a) / (b - a)).toBeCloseTo(0.25)
  })
  it('clamps span', () => {
    const [a, b] = zoomRange(0, 3000, 0.1, 0)
    expect(b - a).toBe(2000)
  })
})
