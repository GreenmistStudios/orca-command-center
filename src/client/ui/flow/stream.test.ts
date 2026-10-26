import { describe, expect, it } from 'vitest'
import type { UsageBucket } from '../../../shared/contract'
import { bucketAt, bucketEase, brushRange, liveDomain, niceTicks, scaleLinear, stackBucket, symmetricMax, timeTicks, yValue } from './stream'

const b = (o: Partial<UsageBucket> = {}): UsageBucket => ({ t: 0, input: 10, cacheRead: 20, cacheWrite: 5, output: 8, reasoning: 2, cost: 0.5, aiu: 0, calls: 1, ...o })

describe('stream helpers', () => {
  it('scaleLinear maps and inverts', () => {
    const s = scaleLinear([100, 200], [0, 50])
    expect(s(150)).toBe(25)
    expect(s.invert(25)).toBe(150)
    expect(scaleLinear([1, 1], [0, 9]).invert(4)).toBe(1)
  })
  it('stackBucket stacks inflow up and outflow down', () => {
    const s = stackBucket(b(), 'tokens')
    expect(s.up.map((x) => [x.flow, x.from, x.to])).toEqual([['input', 0, 10], ['cacheRead', 10, 30], ['cacheWrite', 30, 35]])
    expect(s.down.map((x) => [x.flow, x.to])).toEqual([['output', 8], ['reasoning', 10]])
    expect(s.upTotal).toBe(35)
    expect(s.downTotal).toBe(10)
  })
  it('stackBucket eases and handles cost units', () => {
    expect(stackBucket(b(), 'tokens', 0.5).upTotal).toBe(17.5)
    const c = stackBucket(b(), 'cost')
    expect(c.up).toEqual([{ flow: 'cost', from: 0, to: 0.5 }])
    expect(c.downTotal).toBe(0)
  })
  it('symmetricMax uses the larger side; never zero', () => {
    expect(symmetricMax([b(), b({ output: 500 })], 'tokens')).toBe(502)
    expect(symmetricMax([], 'tokens')).toBe(1)
    expect(yValue(16, true)).toBe(4)
    expect(yValue(16, false)).toBe(16)
  })
  it('niceTicks and timeTicks', () => {
    expect(niceTicks(1000, 2)).toEqual([500, 1000])
    expect(niceTicks(0)).toEqual([])
    const t = timeTicks(0, 5 * 60_000, 5)
    expect(t.length).toBeGreaterThan(2)
    expect(t.every((v) => v % 60_000 === 0)).toBe(true)
    expect(timeTicks(5, 5)).toEqual([])
  })
  it('live domain slides with now', () => {
    expect(liveDomain(1000, 400)).toEqual([600, 1000])
    expect(liveDomain(1500, 400)).toEqual([1100, 1500])
  })
  it('brush math orders and clamps', () => {
    expect(brushRange(100, 0, [0, 1000], 500)).toEqual([0, 200])
    expect(brushRange(-50, 900, [0, 1000], 500)).toEqual([0, 1000])
  })
  it('bucketEase eases from 0 over 400ms; seenAt 0 = no ease', () => {
    expect(bucketEase(1000, 1000)).toBe(0)
    expect(bucketEase(1000, 1200)).toBeGreaterThan(0.5)
    expect(bucketEase(1000, 1400)).toBe(1)
    expect(bucketEase(0, 5)).toBe(1)
  })
  it('bucketAt finds the containing bucket', () => {
    const bs = [b({ t: 0 }), b({ t: 1000 })]
    expect(bucketAt(bs, 1500, 1000)).toBe(bs[1])
    expect(bucketAt(bs, 3000, 1000)).toBeNull()
  })
})
