import { subscribeFrame } from './frame'
import { MAX_PARTICLES } from './motion'

export interface ParticlePath {
  id: string
  points: Array<[number, number]>
  /** Concrete CSS color (canvas can't resolve `var()`). */
  color: string
  /** Link width in px; particles are 2–3 px regardless but clamp to it. */
  width?: number
}

export interface ParticleEngineOptions {
  maxParticles?: number
  /** Reduced motion: the engine never animates. */
  reduced?: boolean
}

export interface ParticleStats {
  active: number
  max: number
  paths: number
  running: boolean
}

/** Spawn rate per link per second (design-system §15.2). */
export function spawnRate(tokensPerSec: number): number {
  return Math.min(30, Math.max(0, Math.log10(1 + Math.max(0, tokensPerSec)) * 6))
}

/** Burst size per call (design-system §15.2). */
export function burstCount(tokens: number): number {
  return Math.min(24, Math.round(4 + 3 * Math.log10(Math.max(1, tokens))))
}

/** Traverse time in seconds: 2.4 s at idle → 1.6 s at max rate. */
export function traverseSeconds(rate: number): number {
  return 2.4 - 0.8 * Math.min(1, rate / 30)
}

export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2
}

interface PathRuntime {
  id: string
  color: string
  size: number
  pts: Float32Array
  cum: Float32Array
  len: number
  rate: number
  acc: number
}

/**
 * Framework-free canvas particle system. Fixed-size pooled typed arrays (no per-frame
 * allocation); driven by the shared frame loop; no-op without a 2D context or when reduced.
 */
export class ParticleEngine {
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly max: number
  private readonly reduced: boolean
  private paths: PathRuntime[] = []
  private index = new Map<string, number>()
  // pool
  private readonly alive: Uint8Array
  private readonly pathIdx: Uint16Array
  private readonly prog: Float32Array // progress; negative = delayed
  private readonly speed: Float32Array // progress / ms
  private readonly jitter: Float32Array
  private activeCount = 0
  private cursor = 0
  private unsub: (() => void) | null = null
  private w = 0
  private h = 0
  private dpr = 1
  private dirty = false

  constructor(private readonly canvas: HTMLCanvasElement, opts: ParticleEngineOptions = {}) {
    this.max = Math.max(1, opts.maxParticles ?? MAX_PARTICLES)
    this.reduced = Boolean(opts.reduced)
    let ctx: CanvasRenderingContext2D | null = null
    try { ctx = canvas.getContext('2d') } catch { ctx = null }
    this.ctx = ctx
    this.alive = new Uint8Array(this.max)
    this.pathIdx = new Uint16Array(this.max)
    this.prog = new Float32Array(this.max)
    this.speed = new Float32Array(this.max)
    this.jitter = new Float32Array(this.max)
  }

  setPaths(paths: ParticlePath[]): void {
    const old = new Map(this.paths.map((p) => [p.id, p]))
    this.paths = paths.map((p) => {
      const n = p.points.length
      const pts = new Float32Array(n * 2)
      const cum = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        pts[i * 2] = p.points[i][0]
        pts[i * 2 + 1] = p.points[i][1]
        if (i > 0) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1])
      }
      const prev = old.get(p.id)
      return { id: p.id, color: p.color, size: Math.min(3, Math.max(2, (p.width ?? 3) / 2)), pts, cum, len: n ? cum[n - 1] : 0, rate: prev?.rate ?? 0, acc: prev?.acc ?? 0 }
    })
    this.index = new Map(this.paths.map((p, i) => [p.id, i]))
    // Drop particles whose path vanished or whose index moved out of range.
    for (let i = 0; i < this.max; i++) if (this.alive[i] && this.pathIdx[i] >= this.paths.length) this.kill(i)
  }

  /** Set the sustained spawn rate from tokens/s (mapped through `spawnRate`). */
  setRate(pathId: string, tokensPerSec: number): void {
    const p = this.paths[this.index.get(pathId) ?? -1]
    if (p) p.rate = spawnRate(tokensPerSec)
  }

  /** Emit a burst for one call. */
  burst(pathId: string, tokens: number): void {
    if (this.reduced) return
    const i = this.index.get(pathId)
    if (i === undefined) return
    const n = burstCount(tokens)
    for (let k = 0; k < n; k++) this.spawn(i, -Math.random() * 0.2)
  }

  resize(w: number, h: number, dpr: number): void {
    this.w = w
    this.h = h
    this.dpr = dpr || 1
    this.canvas.width = Math.max(1, Math.round(w * this.dpr))
    this.canvas.height = Math.max(1, Math.round(h * this.dpr))
    this.dirty = true
  }

  start(): void {
    if (this.reduced || !this.ctx || this.unsub) return
    this.unsub = subscribeFrame((_now, dt) => this.step(dt))
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
  }

  destroy(): void {
    this.stop()
    this.alive.fill(0)
    this.activeCount = 0
    this.paths = []
    this.index.clear()
    this.clear()
  }

  stats(): ParticleStats {
    return { active: this.activeCount, max: this.max, paths: this.paths.length, running: this.unsub !== null }
  }

  /** Advance by `dtMs` and draw. Public so tests can drive a fake clock. */
  step(dtMs: number): void {
    if (this.reduced || !this.ctx) return
    // sustained spawn
    for (let i = 0; i < this.paths.length; i++) {
      const p = this.paths[i]
      if (p.rate <= 0 || p.len <= 0) continue
      p.acc += (p.rate * dtMs) / 1000
      while (p.acc >= 1) {
        p.acc -= 1
        if (!this.spawn(i, 0)) { p.acc = 0; break }
      }
    }
    // advance
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue
      this.prog[i] += this.speed[i] * dtMs
      if (this.prog[i] >= 1) this.kill(i)
    }
    this.draw()
  }

  private spawn(pathIndex: number, startProgress: number): boolean {
    const p = this.paths[pathIndex]
    if (!p || p.len <= 0 || this.activeCount >= this.max) return false
    for (let n = 0; n < this.max; n++) {
      const i = (this.cursor + n) % this.max
      if (this.alive[i]) continue
      this.cursor = (i + 1) % this.max
      this.alive[i] = 1
      this.pathIdx[i] = pathIndex
      this.prog[i] = startProgress
      this.speed[i] = 1 / (traverseSeconds(p.rate) * 1000 * (0.9 + Math.random() * 0.2))
      this.jitter[i] = (Math.random() - 0.5) * 2
      this.activeCount++
      return true
    }
    return false
  }

  private kill(i: number): void {
    if (!this.alive[i]) return
    this.alive[i] = 0
    this.activeCount--
  }

  private clear(): void {
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  private draw(): void {
    const ctx = this.ctx!
    if (this.activeCount === 0) {
      if (this.dirty) { this.clear(); this.dirty = false }
      return
    }
    this.dirty = true
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ctx.globalAlpha = 0.9
    ctx.shadowBlur = dark ? 6 : 3
    let lastColor = ''
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i] || this.prog[i] < 0) continue
      const p = this.paths[this.pathIdx[i]]
      if (!p) continue
      const d = easeInOutSine(this.prog[i]) * p.len
      // locate segment (linear scan; polylines are short)
      let s = 1
      while (s < p.cum.length - 1 && p.cum[s] < d) s++
      const segLen = p.cum[s] - p.cum[s - 1] || 1
      const u = (d - p.cum[s - 1]) / segLen
      const x = p.pts[(s - 1) * 2] + (p.pts[s * 2] - p.pts[(s - 1) * 2]) * u
      const y = p.pts[(s - 1) * 2 + 1] + (p.pts[s * 2 + 1] - p.pts[(s - 1) * 2 + 1]) * u + this.jitter[i] * 0.6
      if (p.color !== lastColor) {
        ctx.fillStyle = p.color
        ctx.shadowColor = p.color
        lastColor = p.color
      }
      ctx.beginPath()
      ctx.arc(x, y, p.size / 1.2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.shadowBlur = 0
  }
}
