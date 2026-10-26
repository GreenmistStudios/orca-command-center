import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { burstCount, easeInOutSine, ParticleEngine, spawnRate, traverseSeconds } from './particles'
import { stubCanvas, stubRaf } from './testutil'

const path = { id: 'p', points: [[0, 0], [100, 0], [200, 50]] as Array<[number, number]>, color: '#0af', width: 4 }

beforeEach(() => { stubRaf() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function make(opts: { maxParticles?: number; reduced?: boolean } = {}) {
  const c = stubCanvas()
  const canvas = document.createElement('canvas')
  const e = new ParticleEngine(canvas, opts)
  e.resize(200, 100, 2)
  e.setPaths([path])
  return { e, c, canvas }
}

describe('particle mappings', () => {
  it('spawn rate is clamp(log10(1+tps)*6, 0, 30)', () => {
    expect(spawnRate(0)).toBe(0)
    expect(spawnRate(9)).toBeCloseTo(6)
    expect(spawnRate(1e9)).toBe(30)
  })
  it('burst is min(24, 4 + 3·log10(tokens))', () => {
    expect(burstCount(1)).toBe(4)
    expect(burstCount(1000)).toBe(13)
    expect(burstCount(1e12)).toBe(24)
  })
  it('traverse 2.4s → 1.6s with rate; sine easing', () => {
    expect(traverseSeconds(0)).toBeCloseTo(2.4)
    expect(traverseSeconds(30)).toBeCloseTo(1.6)
    expect(easeInOutSine(0)).toBeCloseTo(0)
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5)
    expect(easeInOutSine(1)).toBeCloseTo(1)
  })
})

describe('ParticleEngine', () => {
  it('spawns per mapped rate on a fake clock', () => {
    const { e } = make()
    e.setRate('p', 9) // → 6/s
    for (let i = 0; i < 60; i++) e.step(16.67) // ~1s, particles live 2.4 s
    expect(e.stats().active).toBe(6)
  })
  it('burst spawns burstCount particles and they expire', () => {
    const { e } = make()
    e.burst('p', 1000)
    expect(e.stats().active).toBe(13)
    for (let i = 0; i < 400; i++) e.step(16.67)
    expect(e.stats().active).toBe(0)
  })
  it('caps at maxParticles and never grows (pooled)', () => {
    const { e } = make({ maxParticles: 10 })
    e.setRate('p', 1e9)
    for (let i = 0; i < 200; i++) { e.burst('p', 1e6); e.step(16.67); expect(e.stats().active).toBeLessThanOrEqual(10) }
    expect(e.stats().max).toBe(10)
  })
  it('draws with the spy context at DPR scale', () => {
    const { e, c, canvas } = make()
    e.burst('p', 100)
    for (let i = 0; i < 30; i++) e.step(16.67)
    expect(c.calls).toContain('arc')
    expect(c.calls).toContain('fill')
    expect(canvas.width).toBe(400)
  })
  it('reduced never animates or subscribes', () => {
    const { e, c } = make({ reduced: true })
    e.setRate('p', 1e6); e.burst('p', 1e6); e.start()
    e.step(16)
    expect(e.stats().active).toBe(0)
    expect(e.stats().running).toBe(false)
    expect(c.calls).not.toContain('arc')
  })
  it('is a no-op when getContext returns null', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const e = new ParticleEngine(document.createElement('canvas'))
    e.setPaths([path]); e.setRate('p', 100); e.burst('p', 100); e.start(); e.step(16)
    expect(e.stats().running).toBe(false)
    e.destroy()
  })
  it('start/stop subscribes to the shared loop', () => {
    const { e } = make()
    e.start(); expect(e.stats().running).toBe(true)
    e.stop(); expect(e.stats().running).toBe(false)
    e.destroy()
  })
})
