import { describe, expect, it } from 'vitest'
import { nodeShares, particleCount, particleDuration, ringArcs, workflowBurn } from './overlay'
import type { SessionSummary } from '../../../shared/contract'

describe('overlay helpers', () => {
  it('maps rates to dot counts and durations', () => {
    expect(particleCount(0, true)).toBe(0)
    expect(particleCount(5000, false)).toBe(0)
    expect(particleCount(10, true)).toBe(1)
    expect(particleCount(1e6, true)).toBe(4)
    expect(particleDuration(0)).toBe(3)
    expect(particleDuration(1e6)).toBe(0.8)
    expect(particleDuration(100)).toBeGreaterThan(particleDuration(10000))
  })
  it('computes ring arcs from shares', () => {
    const s = { usage: { inflow: 25, outflow: 100 } } as SessionSummary
    const sh = nodeShares(s, { inflow: 100, outflow: 100 })
    expect(sh).toEqual({ inShare: 0.25, outShare: 1 })
    expect(ringArcs(sh)).toEqual({ inArc: 0.125, outArc: 0.5 })
    expect(nodeShares(s, null)).toEqual({ inShare: 0, outShare: 0 })
  })
  it('sums live rates only', () => {
    const mk = (live: boolean) => ({ live, usage: { rates: { inflowPerMin: 10, outflowPerMin: 5, costPerHour: 1 } } }) as SessionSummary
    expect(workflowBurn([mk(true), mk(true), mk(false)])).toEqual({ tokensPerMin: 30, costPerHour: 2 })
  })
})
