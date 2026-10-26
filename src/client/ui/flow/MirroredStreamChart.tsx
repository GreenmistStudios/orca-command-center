import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { UsageBucket } from '../../../shared/contract'
import { useElementSize } from '../../hooks/useElementSize'
import { cn } from '../../lib/cn'
import { formatClock } from '../../lib/format'
import { formatCost, formatTokens } from '../../lib/format'
import { FLOW_KINDS, FLOW_LABEL, FLOW_VAR, resolveFlowColor } from './flows'
import { subscribeFrame } from './frame'
import { useFlowMotion } from './motion'
import { bucketAt, bucketEase, brushRange, liveDomain, niceTicks, scaleLinear, stackBucket, symmetricMax, timeTicks, yValue } from './stream'

export interface MirroredStreamChartProps {
  buckets: UsageBucket[]
  bucketMs: number
  /** Fixed `[from, to]` epoch-ms window, or `'live'` for a window sliding with the clock. */
  domain: [number, number] | 'live'
  /** Live window length (default 5 min). */
  spanMs?: number
  units: 'tokens' | 'cost'
  /** Call markers: epoch ms drawn as 2px ticks on the axis. */
  markers?: number[]
  /** Fires with `[from, to]` epoch ms after a drag. */
  onBrush?(range: [number, number]): void
  /** Square-root y scale. */
  balanced?: boolean
  height?: number
  className?: string
}

const FALLBACK_WIDTH = 720
const PAD_TOP = 8
const PAD_BOTTOM = 18

/** Live mirrored in/out traffic chart: inflow stacked above the axis, outflow below. Canvas areas + SVG overlay. */
export function MirroredStreamChart({ buckets, bucketMs, domain, spanMs = 5 * 60_000, units, markers, onBrush, balanced = false, height = 240, className }: MirroredStreamChartProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const { reduced } = useFlowMotion()
  const width = size.width > 0 ? size.width : FALLBACK_WIDTH
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const live = domain === 'live'

  // props mirrored into refs so the frame loop never touches React state
  const state = useRef({ buckets, bucketMs, domain, spanMs, units, balanced, width, height, reduced })
  state.current = { buckets, bucketMs, domain, spanMs, units, balanced, width, height, reduced }
  const seen = useRef(new Map<number, number>())
  const seenInit = useRef(false)
  const ticksRef = useRef<SVGGElement | null>(null)
  const [tickBase, setTickBase] = useState(() => Date.now())
  const baseRef = useRef(tickBase)
  baseRef.current = tickBase

  // first-seen timestamps for ease-in (initial load is not eased)
  useMemo(() => {
    const now = Date.now()
    for (const b of buckets) if (!seen.current.has(b.t)) seen.current.set(b.t, seenInit.current ? now : 0)
    seenInit.current = true
  }, [buckets])

  const yMax = useMemo(() => symmetricMax(buckets, units), [buckets, units])
  const yMaxRef = useRef(yMax)
  yMaxRef.current = yMax

  const currentDomain = useCallback((now: number): [number, number] => {
    const s = state.current
    return s.domain === 'live' ? liveDomain(now, s.spanMs) : s.domain
  }, [])

  const draw = useCallback((now: number) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    if (!canvas || !ctx) return false
    const s = state.current
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const w = Math.round(s.width * dpr)
    const h = Math.round(s.height * dpr)
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const dom = currentDomain(now)
    const x = scaleLinear(dom, [0, s.width])
    const mid = PAD_TOP + (s.height - PAD_TOP - PAD_BOTTOM) / 2
    const half = (s.height - PAD_TOP - PAD_BOTTOM) / 2
    const norm = yValue(yMaxRef.current, s.balanced) || 1
    const py = (v: number) => (yValue(v, s.balanced) / norm) * half
    let easing = false
    for (const b of s.buckets) {
      if (b.t + s.bucketMs < dom[0] || b.t > dom[1]) continue
      const k = bucketEase(seen.current.get(b.t) ?? 0, now)
      if (k < 1) easing = true
      const st = stackBucket(b, s.units, k)
      const x0 = x(b.t)
      const bw = Math.max(1, x(b.t + s.bucketMs) - x0 - 0.5)
      for (const seg of st.up) {
        if (seg.to <= seg.from) continue
        ctx.fillStyle = resolveFlowColor(seg.flow)
        ctx.globalAlpha = 0.85
        ctx.fillRect(x0, mid - py(seg.to), bw, Math.max(0.5, py(seg.to) - py(seg.from)))
      }
      for (const seg of st.down) {
        if (seg.to <= seg.from) continue
        ctx.fillStyle = resolveFlowColor(seg.flow)
        ctx.globalAlpha = 0.85
        ctx.fillRect(x0, mid + py(seg.from), bw, Math.max(0.5, py(seg.to) - py(seg.from)))
      }
    }
    ctx.globalAlpha = 1
    const g = ticksRef.current
    if (g && s.domain === 'live') {
      const dx = -((now - baseRef.current) / (dom[1] - dom[0])) * s.width
      g.setAttribute('transform', `translate(${dx.toFixed(2)} 0)`)
    }
    return easing
  }, [currentDomain])

  // Loop controller: subscribes once per mount (and on `reduced`/`live` changes); props are read from refs.
  const ctl = useRef<{ redraw(): void } | null>(null)
  const setAnimating = useCallback((v: boolean) => {
    canvasRef.current?.setAttribute('data-animating', v ? 'true' : 'false')
  }, [])
  useEffect(() => {
    let unsub: (() => void) | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    const visible = () => typeof document === 'undefined' || !document.hidden
    const stop = () => { unsub?.(); unsub = null }
    const paint = () => {
      const easing = draw(Date.now())
      const has = state.current.buckets.length > 0
      if (reduced) { setAnimating(false); return }
      if (!live && !easing) { stop(); setAnimating(false); return }
      if (!unsub) unsub = subscribeFrame(() => paint())
      setAnimating(visible() && has)
    }
    if (reduced) timer = setInterval(() => { draw(Date.now()) }, 1000)
    const onVis = () => { if (!reduced) setAnimating(visible() && state.current.buckets.length > 0 && unsub !== null) }
    document.addEventListener('visibilitychange', onVis)
    ctl.current = { redraw: paint }
    paint()
    return () => {
      stop()
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
      ctl.current = null
    }
  }, [draw, live, reduced, setAnimating])

  // redraw on data/size changes without re-subscribing
  const domFrom = Array.isArray(domain) ? domain[0] : 0
  const domTo = Array.isArray(domain) ? domain[1] : 0
  useEffect(() => { ctl.current?.redraw() }, [buckets, yMax, width, height, units, balanced, domFrom, domTo, spanMs, bucketMs])

  // refresh tick labels ~1 Hz in live mode (positions slide imperatively in between)
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setTickBase(Date.now()), reduced ? 1000 : 2000)
    return () => clearInterval(id)
  }, [live, reduced])

  // ── overlay geometry (static snapshot at tickBase) ──
  const baseDomain: [number, number] = live ? liveDomain(tickBase, spanMs) : (domain as [number, number])
  const wide: [number, number] = live ? [baseDomain[0] - spanMs * 0.2, baseDomain[1] + spanMs * 0.2] : baseDomain
  const xs = scaleLinear(baseDomain, [0, width])
  const half = (height - PAD_TOP - PAD_BOTTOM) / 2
  const mid = PAD_TOP + half
  const tVals = timeTicks(wide[0], wide[1], 6)
  const yT = niceTicks(yMax, 2)
  const norm = yValue(yMax, balanced) || 1
  const fmtV = (v: number) => (units === 'cost' ? formatCost(v) : formatTokens(v))

  // ── pointer: crosshair, tooltip, brush ──
  const [hover, setHover] = useState<{ x: number; bucket: UsageBucket | null } | null>(null)
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null)
  const dragging = useRef<number | null>(null)
  const localX = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.min(width, Math.max(0, e.clientX - r.left))
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const px = localX(e)
    const t = scaleLinear(currentDomain(Date.now()), [0, width]).invert(px)
    setHover({ x: px, bucket: bucketAt(buckets, t, bucketMs) })
    if (dragging.current !== null) setBrush({ a: dragging.current, b: px })
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!onBrush) return
    dragging.current = localX(e)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const a = dragging.current
    dragging.current = null
    if (a === null) return
    const b = localX(e)
    setBrush(null)
    if (Math.abs(b - a) > 4) onBrush?.(brushRange(a, b, currentDomain(Date.now()), width))
  }

  const hb = hover?.bucket
  return (
    <div
      ref={ref}
      className={cn('relative w-full select-none', className)}
      style={{ height }}
      data-stream
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
      onPointerDown={onDown}
      onPointerUp={onUp}
    >
      <canvas ref={canvasRef} className="absolute inset-0" style={{ width, height }} role="img" aria-label="Token flow over time: inflow above the axis, outflow below" data-stream-canvas />
      <svg width={width} height={height} className="pointer-events-none absolute inset-0" aria-hidden="true">
        <line x1={0} x2={width} y1={mid} y2={mid} stroke="var(--panel-border)" strokeWidth={1} />
        {yT.map((v) => {
          const d = (yValue(v, balanced) / norm) * half
          return (
            <g key={v} data-ytick={v}>
              <line x1={0} x2={width} y1={mid - d} y2={mid - d} stroke="var(--panel-border)" strokeOpacity={0.4} strokeDasharray="2 4" />
              <text x={4} y={mid - d - 2} fontSize={10} fill="var(--muted-foreground)">{fmtV(v)}</text>
              {units === 'tokens' && <text x={4} y={mid + d + 10} fontSize={10} fill="var(--muted-foreground)">{fmtV(v)}</text>}
            </g>
          )
        })}
        <g ref={ticksRef}>
          {tVals.map((t) => (
            <text key={t} x={xs(t)} y={height - 4} fontSize={10} textAnchor="middle" fill="var(--muted-foreground)" data-xtick={t}>{formatClock(t)}</text>
          ))}
          {(markers ?? []).filter((m) => m >= wide[0] && m <= wide[1]).map((m) => (
            <line key={m} x1={xs(m)} x2={xs(m)} y1={mid - 3} y2={mid + 3} stroke="var(--muted-foreground)" strokeWidth={2} data-marker={m} />
          ))}
        </g>
        {live && (
          <line x1={width - 1} x2={width - 1} y1={PAD_TOP} y2={height - PAD_BOTTOM} stroke="var(--selection)" strokeWidth={1.5} className={reduced ? undefined : 'animate-pulse'} data-now-line style={{ animationDuration: '2s' }} />
        )}
        {brush && (
          <rect
            x={Math.min(brush.a, brush.b)} y={PAD_TOP} width={Math.abs(brush.b - brush.a)} height={height - PAD_TOP - PAD_BOTTOM}
            fill="color-mix(in oklch, var(--selection) 15%, transparent)" stroke="var(--selection)" strokeWidth={1} data-brush
          />
        )}
        {hover && <line x1={hover.x} x2={hover.x} y1={PAD_TOP} y2={height - PAD_BOTTOM} stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="3 3" data-crosshair />}
      </svg>
      {hover && hb && (
        <div
          className="panel pointer-events-none absolute z-10 px-2 py-1.5 text-[11px] leading-snug"
          style={{ left: Math.min(Math.max(4, hover.x + 10), Math.max(4, width - 150)), top: PAD_TOP }}
          data-tooltip
        >
          <div className="text-muted-foreground mb-0.5 tabular-nums">{formatClock(hb.t)}</div>
          {FLOW_KINDS.map((f) => (
            <div key={f} className="flex items-center justify-between gap-3 tabular-nums">
              <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full" style={{ background: FLOW_VAR[f] }} />{FLOW_LABEL[f]}</span>
              <span>{formatTokens(hb[f])}</span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 tabular-nums">
            <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full" style={{ background: FLOW_VAR.cost }} />Cost</span>
            <span>{formatCost(hb.cost)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
