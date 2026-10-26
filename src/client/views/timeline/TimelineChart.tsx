import { Minus, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { IconButton } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { toneClasses, type Tone } from '../../ui/tones'
import { generateTicks, makeScale, packSubRows, zoomRange, MIN_BLOCK_PX, TICK_PX } from './geometry'

export const GUTTER = 160
const AXIS_H = 24
const VIRTUALIZE_OVER = 40
const OVERSCAN_PX = 200

export interface BlockItem {
  id: string
  start: number
  end: number
  instant: boolean
  color: string
  error: boolean
  running: boolean
  tip: { heading: string; lines: string[] }
  onSelect(): void
}
export interface SpanBar { start: number; end: number; tone: Tone; live: boolean; text?: string }
export interface LaneModel {
  id: string
  label: ReactNode
  /** Accessible name for the gutter button. */
  labelText: string
  span: SpanBar | null
  blocks: BlockItem[]
  onSelectLane(): void
  selected?: boolean
}
export interface Connector { fromLane: number; toLane: number; from: number; to: number }

type Mode = { kind: 'all' } | { kind: 'win'; span: number; end: number }
type Preset = '5m' | '15m' | '1h' | 'all' | 'custom'
const PRESET_MS: Record<'5m' | '15m' | '1h', number> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }

interface Hover { item: BlockItem; x: number; y: number }

/**
 * Rendering: absolutely positioned DOM in a scroll container. Only blocks intersecting the viewport
 * are mounted and lanes are windowed when > 40, so pan/zoom touches a few hundred nodes at most
 * even with 5 000 events. Geometry is memoised on (data, span, width); panning only re-slices.
 */
export function TimelineChart({
  lanes, connectors, bounds, anyLive, now, selectedItemId, empty,
}: {
  lanes: LaneModel[]; connectors: Connector[]; bounds: { min: number; max: number }; anyLive: boolean; now: number
  selectedItemId: string | null; empty?: ReactNode
}) {
  const [mode, setMode] = useState<Mode>({ kind: 'all' })
  const [preset, setPreset] = useState<Preset>('all')
  const [follow, setFollow] = useState(true)
  const [width, setWidth] = useState(800)
  const [scroll, setScroll] = useState({ top: 0, height: 600 })
  const [hover, setHover] = useState<Hover | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; t0: number; span: number; moved: boolean } | null>(null)
  const justDragged = useRef(false)

  useEffect(() => {
    const el = trackRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (el.clientWidth > 0) setWidth(el.clientWidth) })
    ro.observe(el)
    if (el.clientWidth > 0) setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (el.clientHeight > 0) setScroll((s) => ({ ...s, height: el.clientHeight })) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const dataEnd = anyLive ? Math.max(now, bounds.max) : bounds.max
  const following = follow && anyLive
  const [t0, t1] = useMemo((): [number, number] => {
    if (mode.kind === 'all') {
      const pad = Math.max(1000, (dataEnd - bounds.min) * 0.02)
      return [bounds.min - pad, dataEnd + pad]
    }
    const end = following ? now : mode.end
    return [end - mode.span, end]
  }, [mode, following, now, dataEnd, bounds.min])
  const span = t1 - t0
  const scale = useMemo(() => makeScale(t0, t1, width), [t0, t1, width])

  /* geometry: packing depends only on data + span + width, not on the pan offset */
  const minMs = (span * MIN_BLOCK_PX) / width
  const packed = useMemo(() => lanes.map((l) => packSubRows(l.blocks, Math.max(minMs, 1)).rows), [lanes, Math.round(minMs)]) // eslint-disable-line react-hooks/exhaustive-deps
  const layout = useMemo(() => {
    let y = 0
    return lanes.map((l, i) => {
      const rows = Math.max(1, ...[...packed[i].values()].map((r) => r + 1))
      const h = rows === 1 ? 26 : rows * 12 + 8
      const top = y
      y += h
      return { top, h, rows }
    })
  }, [lanes, packed])
  const totalH = layout.length ? layout[layout.length - 1].top + layout[layout.length - 1].h : 0

  const visibleLanes = useMemo(() => {
    const idx: number[] = []
    const windowed = lanes.length > VIRTUALIZE_OVER
    for (let i = 0; i < lanes.length; i++) {
      const L = layout[i]
      if (windowed && (L.top + L.h < scroll.top - OVERSCAN_PX || L.top > scroll.top + scroll.height + OVERSCAN_PX)) continue
      idx.push(i)
    }
    return idx
  }, [lanes.length, layout, scroll])

  const ticks = useMemo(() => generateTicks(t0, t1, Math.max(3, Math.floor(width / 90))), [t0, t1, width])

  /* navigation */
  const setWindow = useCallback((a: number, b: number, keepFollow = true) => {
    setMode({ kind: 'win', span: b - a, end: b })
    setPreset('custom')
    if (!keepFollow) setFollow(false)
  }, [])
  const zoom = useCallback((factor: number, anchor?: number) => {
    const [a, b] = zoomRange(t0, t1, factor, anchor ?? (following ? t1 : (t0 + t1) / 2))
    setWindow(a, b)
  }, [t0, t1, following, setWindow])
  const applyPreset = (p: Preset) => {
    if (p === 'custom') return
    setPreset(p)
    if (p === 'all') { setMode({ kind: 'all' }); return }
    setMode({ kind: 'win', span: PRESET_MS[p], end: dataEnd })
  }
  const pan = useCallback((dt: number) => { setWindow(t0 + dt, t1 + dt, false) }, [t0, t1, setWindow])

  const wheelRef = useRef({ zoom, pan, scale, span, width })
  wheelRef.current = { zoom, pan, scale, span, width }
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const w = wheelRef.current
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = trackRef.current?.getBoundingClientRect()
        const anchor = rect ? w.scale.t(e.clientX - rect.left) : undefined
        w.zoom(e.deltaY > 0 ? 1.25 : 0.8, anchor)
      } else if (e.shiftKey) {
        e.preventDefault()
        w.pan(((e.deltaY || e.deltaX) / w.width) * w.span)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || e.clientX < rect.left) return
    drag.current = { x: e.clientX, t0, span, moved: false }
    const move = (ev: MouseEvent) => {
      const d = drag.current
      if (!d) return
      const dx = ev.clientX - d.x
      if (!d.moved && Math.abs(dx) < 4) return
      d.moved = true
      const dt = -(dx / width) * d.span
      setMode({ kind: 'win', span: d.span, end: d.t0 + dt + d.span })
      setPreset('custom')
      setFollow(false)
      setHover(null)
    }
    const up = () => {
      justDragged.current = !!drag.current?.moved
      drag.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setTimeout(() => { justDragged.current = false }, 0)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const nowX = scale.x(now)

  return (
    <div data-testid="timeline" className="flex h-full min-h-0 flex-col text-xs">
      <div className="border-panel-border/60 flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <Segmented<Preset>
          aria-label="Timeline range" layoutId="timeline-preset" value={preset} onChange={applyPreset}
          options={[{ value: '5m', label: '5m' }, { value: '15m', label: '15m' }, { value: '1h', label: '1h' }, { value: 'all', label: 'All' }]}
        />
        <div className="flex items-center gap-0.5">
          <IconButton aria-label="Zoom out" onClick={() => zoom(1.5)}><Minus size={12} /></IconButton>
          <IconButton aria-label="Zoom in" onClick={() => zoom(1 / 1.5)}><Plus size={12} /></IconButton>
        </div>
        <button
          type="button" role="switch" aria-checked={following} disabled={!anyLive}
          onClick={() => setFollow((f) => !f)}
          className={cn('flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40', following ? 'border-[var(--selection)] text-[var(--selection)]' : 'border-panel-border text-muted-foreground')}
        >
          <span className={cn('size-1.5 rounded-full', following ? 'bg-[var(--selection)]' : 'bg-muted-foreground/50')} /> Live
        </button>
        <span className="text-muted-foreground/70 ml-auto hidden text-[10px] sm:inline">⌘/Ctrl-wheel zoom · drag or Shift-wheel pan</span>
      </div>

      <div className="flex shrink-0" style={{ height: AXIS_H }} aria-hidden>
        <div style={{ width: GUTTER }} className="shrink-0" />
        <div className="relative flex-1 overflow-hidden">
          {ticks.map((t) => (
            <span key={t.t} className="text-muted-foreground/70 absolute top-1 -translate-x-1/2 text-[10px] tabular-nums" style={{ left: scale.x(t.t) }}>{t.label}</span>
          ))}
        </div>
      </div>

      <div
        ref={scrollRef} data-testid="timeline-scroll"
        className="relative min-h-0 flex-1 cursor-grab overflow-y-auto overflow-x-hidden select-none active:cursor-grabbing"
        onScroll={(e) => { const top = e.currentTarget.scrollTop; setScroll((s) => (Math.abs(s.top - top) > 8 ? { ...s, top } : s)) }}
        onMouseDown={onMouseDown}
      >
        <div className="relative" style={{ height: Math.max(totalH, 1) }}>
          {visibleLanes.map((i) => {
            const lane = lanes[i]
            const L = layout[i]
            const rowH = L.rows === 1 ? 18 : 10
            const sp = lane.span
            const tc = sp ? toneClasses(sp.tone) : null
            return (
              <div key={lane.id} data-testid="timeline-lane" className="border-panel-border/30 absolute inset-x-0 border-b" style={{ top: L.top, height: L.h }}>
                <button
                  type="button" aria-label={lane.labelText} aria-current={lane.selected || undefined}
                  onClick={lane.onSelectLane}
                  className={cn('hover:bg-muted/60 absolute inset-y-0 left-0 flex cursor-pointer items-center gap-1.5 overflow-hidden pr-1 text-left', lane.selected && 'bg-muted/60')}
                  style={{ width: GUTTER }}
                >
                  {lane.label}
                </button>
                <div className="absolute inset-y-0 overflow-hidden" style={{ left: GUTTER, right: 0 }}>
                  {sp && tc && (() => {
                    const x0 = scale.x(sp.start)
                    const x1 = Math.max(scale.x(sp.end), x0 + MIN_BLOCK_PX)
                    if (x1 < 0 || x0 > width) return null
                    return (
                      <div
                        data-testid="timeline-span"
                        className={cn('absolute overflow-hidden rounded border px-1.5 text-[10px] leading-[16px] whitespace-nowrap opacity-60', tc.surface)}
                        style={{
                          left: x0, width: x1 - x0, top: 4, height: L.h - 8,
                          ...(sp.live ? { maskImage: 'linear-gradient(to right, black 60%, transparent)', WebkitMaskImage: 'linear-gradient(to right, black 60%, transparent)' } : {}),
                        }}
                      >{sp.text}</div>
                    )
                  })()}
                  {lane.blocks.map((b) => {
                    const x0 = scale.x(b.start)
                    const w = b.instant ? TICK_PX : Math.max(scale.x(b.end) - x0, MIN_BLOCK_PX)
                    if (x0 + w < 0 || x0 > width) return null
                    const row = packed[i].get(b.id) ?? 0
                    const selected = b.id === selectedItemId
                    return (
                      <div
                        key={b.id} data-testid="timeline-block" data-activity-id={b.id}
                        role="button" tabIndex={-1} aria-label={b.tip.heading}
                        className={cn('absolute cursor-pointer rounded-[3px]', b.running && 'animate-pulse')}
                        style={{
                          left: b.instant ? x0 - TICK_PX / 2 : x0, width: w, top: 4 + row * (L.rows === 1 ? 0 : 12), height: rowH,
                          background: b.color,
                          outline: selected ? '2px solid var(--foreground)' : b.error ? '1.5px solid var(--status-failed)' : undefined,
                          outlineOffset: selected ? 1 : -1,
                          zIndex: selected ? 3 : b.error ? 2 : 1,
                        }}
                        onMouseEnter={(e) => setHover({ item: b, x: e.clientX, y: e.clientY })}
                        onMouseMove={(e) => setHover((h) => (h && h.item === b ? { item: b, x: e.clientX, y: e.clientY } : h))}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => { if (!justDragged.current) b.onSelect() }}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}

          <div ref={trackRef} className="pointer-events-none absolute inset-y-0" style={{ left: GUTTER, right: 0 }}>
            <svg width="100%" height="100%" className="absolute inset-0 overflow-hidden" aria-hidden>
              {ticks.map((t) => <line key={t.t} x1={scale.x(t.t)} x2={scale.x(t.t)} y1={0} y2="100%" stroke="currentColor" className="text-muted-foreground" opacity={t.major ? 0.18 : 0.08} />)}
              {connectors.map((c, k) => {
                const a = layout[c.fromLane]
                const b = layout[c.toLane]
                if (!a || !b) return null
                const x1 = scale.x(c.from)
                const x2 = scale.x(c.to)
                return <path key={k} d={`M ${x1} ${a.top + a.h / 2} H ${x2} V ${b.top + b.h / 2}`} fill="none" stroke="currentColor" className="text-muted-foreground" opacity={0.6} strokeDasharray="3 2" />
              })}
              {nowX >= 0 && nowX <= width && <line data-testid="timeline-now" x1={nowX} x2={nowX} y1={0} y2="100%" stroke="var(--selection)" strokeWidth={1.5} />}
            </svg>
          </div>
        </div>
        {empty}
      </div>

      {hover && (
        <div
          role="tooltip" data-testid="timeline-tooltip"
          className="bg-panel-solid border-panel-border shadow-lift-2 pointer-events-none fixed z-50 max-w-72 rounded-md border px-2 py-1.5 text-[11px]"
          style={{ left: Math.min(hover.x + 12, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 300), top: hover.y + 14 }}
        >
          <div className="text-foreground font-medium break-words">{hover.item.tip.heading}</div>
          {hover.item.tip.lines.map((l, i) => <div key={i} className="text-muted-foreground">{l}</div>)}
        </div>
      )}
    </div>
  )
}
