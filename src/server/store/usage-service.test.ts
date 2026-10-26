import { describe, expect, it, vi } from 'vitest'
import type { HarnessSession, HarnessSource } from '../types.js'
import { UsageService, type UsageContext } from './usage-service.js'

describe('UsageService seeding', () => {
  it('does nothing until startSeeding, then processes one session per step', async () => {
    const loads: string[][] = []
    const src = { harness: 'opencode', getUsageSamples: (ids: string[]) => (loads.push([...ids]), []) } as unknown as HarnessSource
    const known = new Set(['a', 'b', 'c'])
    const ctx = {
      log: { debug() {}, info() {}, warn() {}, error() {} },
      now: Date.now,
      windowMs: 1000,
      harnesses: [src],
      sessionOf: (id: string) => (known.has(id) ? ({ id, harness: 'opencode' } as HarnessSession) : null),
      rootOf: (id: string) => id,
      markStatsDirty() {},
      refreshSessions() {},
      publishUsage() {},
    } as unknown as UsageContext
    const svc = new UsageService(ctx)
    await new Promise((r) => setImmediate(r))
    expect(loads).toHaveLength(0)
    svc.startSeeding(['a'], ['b', 'c'])
    expect(loads).toHaveLength(0) // deferred to the next macrotask
    // Make each step look slow so it must yield after one session.
    const spy = vi.spyOn(performance, 'now')
    let t = 0
    spy.mockImplementation(() => (t += 30))
    await new Promise((r) => setImmediate(r))
    expect(loads).toEqual([['a']])
    await new Promise((r) => setImmediate(r))
    expect(loads).toEqual([['a'], ['b']])
    spy.mockRestore()
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    expect(loads.flat()).toEqual(['a', 'b', 'c'])
    expect(svc.isSeeded()).toBe(true)
    svc.stop()
  })
})
