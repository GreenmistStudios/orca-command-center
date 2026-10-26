import { afterEach, describe, expect, it, vi } from 'vitest'
import { frameSubscriberCount, getFrameStats, subscribeFrame } from './frame'
import { setHidden, stubRaf } from './testutil'

afterEach(() => { vi.unstubAllGlobals(); setHidden(false) })

describe('frame loop', () => {
  it('runs one loop for many subscribers and stops with none', () => {
    const raf = stubRaf()
    const a = vi.fn(), b = vi.fn()
    const ua = subscribeFrame(a)
    const ub = subscribeFrame(b)
    expect(raf.pending()).toBe(1)
    raf.tick(1000)
    raf.tick(1016)
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(2)
    expect(a.mock.calls[1][1]).toBeCloseTo(16, 0)
    expect(getFrameStats().fps).toBeGreaterThan(0)
    ua(); ub()
    expect(frameSubscriberCount()).toBe(0)
    expect(raf.pending()).toBe(0)
  })

  it('pauses while hidden and resumes when visible', () => {
    const raf = stubRaf()
    const cb = vi.fn()
    const un = subscribeFrame(cb)
    raf.tick(100)
    setHidden(true)
    expect(raf.pending()).toBe(0)
    setHidden(false)
    expect(raf.pending()).toBe(1)
    raf.tick(5000)
    expect(cb).toHaveBeenCalledTimes(2)
    // dt is clamped after a long pause
    expect(cb.mock.calls[1][1]).toBeLessThanOrEqual(100)
    un()
  })
})
