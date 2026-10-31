import { describe, expect, it } from 'vitest'
import { RATE_WINDOW_MS, TokenRateTracker, tokenBreakdown, tokenIO } from './tokens'

const T = { input: 10, output: 200, reasoning: 50, cacheRead: 1000, cacheWrite: 300 }

describe('tokenIO', () => {
  it('counts cache in input and reasoning in output', () => {
    expect(tokenIO(T)).toEqual({ input: 1310, output: 250 })
  })
  it('breakdown lists every field', () => {
    expect(tokenBreakdown(T)).toBe('Input 10 · Cache read 1,000 · Cache write 300\nOutput 200 · Reasoning 50')
  })
})

describe('TokenRateTracker', () => {
  const t0 = 1_000_000

  it('needs a change to report a rate', () => {
    const r = new TokenRateTracker()
    r.record('a', t0, 100)
    expect(r.rate('a', t0 + 30_000)).toBeNull()
    r.record('a', t0 + 30_000, 100)
    expect(r.rate('a', t0 + 30_000)).toBeNull()
    expect(r.rate('missing', t0)).toBeNull()
  })

  it('averages output since the baseline, per minute', () => {
    const r = new TokenRateTracker()
    r.record('a', t0, 100)
    r.record('a', t0 + 30_000, 400)
    r.record('a', t0 + 60_000, 700)
    expect(r.rate('a', t0 + 60_000)).toBe(600)
  })

  it('uses a minimum span so a burst right after the baseline is not a spike', () => {
    const r = new TokenRateTracker()
    r.record('a', t0, 0)
    r.record('a', t0 + 1000, 500)
    expect(r.rate('a', t0 + 1000)).toBe(2000) // 500 over 15 s
  })

  it('averages a burst after a quiet spell over the window, not the quiet period', () => {
    const r = new TokenRateTracker()
    r.record('a', t0, 0)
    r.record('a', t0 + 10 * 60_000, 1200)
    expect(r.rate('a', t0 + 10 * 60_000)).toBe(600) // 1200 over the 2-minute window
  })

  it('goes quiet once the window passes without output and drops old samples', () => {
    const r = new TokenRateTracker()
    r.record('a', t0, 0)
    r.record('a', t0 + 10_000, 100)
    expect(r.rate('a', t0 + RATE_WINDOW_MS + 10_000)).toBeNull()
    for (let i = 1; i <= 20; i++) r.record('a', t0 + 10_000 + i * 30_000, 100 + i * 50)
    const now = t0 + 10_000 + 20 * 30_000
    // baseline = last sample at or before the window start (i = 16): 4 × 50 tokens over 2 minutes
    expect(r.rate('a', now)).toBe(100)
  })

  it('restarts when the total goes down', () => {
    const r = new TokenRateTracker()
    r.record('a', t0, 500)
    r.record('a', t0 + 30_000, 900)
    r.record('a', t0 + 40_000, 100)
    expect(r.rate('a', t0 + 40_000)).toBeNull()
    r.forget('a')
    expect(r.rate('a', t0 + 40_000)).toBeNull()
  })
})
