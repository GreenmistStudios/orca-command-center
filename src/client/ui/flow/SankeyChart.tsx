import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SankeyNode, UsageSankey } from '../../../shared/contract'
import { useElementSize } from '../../hooks/useElementSize'
import { cn } from '../../lib/cn'
import { formatCost, formatCount, formatTokens } from '../../lib/format'
import { agentColorVar } from '../tones'
import { FLOW_LABEL, FLOW_VAR, resolveFlowColor } from './flows'
import { useFlowMotion } from './motion'
import { ParticleEngine } from './particles'
import { layoutSankey, sankeySignature, type LayoutNode, type SankeyScale, type SankeyUnits } from './sankey-layout'

export interface BurstEmitter {
  subscribe(fn: (linkId: string, tokens: number) => void): () => void
}

export interface SankeyChartProps {
  sankey: UsageSankey
  /** `balanced` lays out on √value (labels and tooltips keep true values). */
  scale: SankeyScale
  units: SankeyUnits
  /** EWMA tokens/s per link id → sustained particle rate. */
  rates?: Record<string, number>
  /** Fires `(linkId, tokens)` per call → particle burst. */
  burstEmitter?: BurstEmitter
  selectedNodeId?: string | null
  onNodeClick?(node: SankeyNode): void
  /** Which nodes are clickable/focusable. Default: middle column (`column === 1`) when `onNodeClick` is set, else none. */
  isNodeInteractive?(node: SankeyNode): boolean
  /** Chart height in px (default 360). */
  height?: number
  className?: string
}

const FALLBACK_WIDTH = 720

function fmt(v: number, units: SankeyUnits): string {
  return units === 'cost' ? formatCost(v) : formatTokens(v)
}

function nodeColor(n: SankeyNode): string {
  if (n.flow) return FLOW_VAR[n.flow]
  return agentColorVar(n.label)
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s
}

/** Animated 3-column Sankey (sources → agents/sessions/models → sinks) with a particle overlay. */
export function SankeyChart({ sankey, scale, units, rates, burstEmitter, selectedNodeId, onNodeClick, isNodeInteractive, height = 360, className }: SankeyChartProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const { reduced } = useFlowMotion()
  const width = size.width > 0 ? size.width : FALLBACK_WIDTH
  const cardW = width < 560 ? 100 : 140
  const [hoverNode, setHoverNode] = useState<string | null>(null)
  const [hoverLink, setHoverLink] = useState<string | null>(null)

  const sig = sankeySignature(sankey)
  // Relayout only when structure/values/dimensions change (not on identity changes).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => layoutSankey(sankey, { width, height, scale, units, marginX: cardW + 8 }), [sig, width, height, scale, units, cardW])
  const nodeLabel = useMemo(() => new Map(sankey.nodes.map((n) => [n.id, n.label])), [sig]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── particles ──
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<ParticleEngine | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const engine = new ParticleEngine(canvas, { reduced })
    engineRef.current = engine
    engine.start()
    return () => { engine.destroy(); engineRef.current = null }
  }, [reduced])
  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    e.resize(width, height, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
    e.setPaths(layout.links.map((l) => ({ id: l.id, points: l.points, color: resolveFlowColor(l.flow), width: l.width })))
    for (const l of layout.links) e.setRate(l.id, rates?.[l.id] ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, width, height, reduced])
  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    for (const l of layout.links) e.setRate(l.id, rates?.[l.id] ?? 0)
  }, [rates, layout, reduced])
  useEffect(() => {
    if (!burstEmitter) return
    return burstEmitter.subscribe((id, tokens) => engineRef.current?.burst(id, tokens))
  }, [burstEmitter, reduced])

  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    const on = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  const animating = !reduced && visible && layout.links.length > 0

  const interactiveOf = (n: SankeyNode): boolean => (onNodeClick ? (isNodeInteractive ? isNodeInteractive(n) : n.column === 1) : false)
  const active = hoverNode ?? null
  const linkOpacity = (id: string, source: string, target: string): number => {
    if (hoverLink) return hoverLink === id ? 0.55 : 0.12
    if (active) return source === active || target === active ? 0.55 : 0.12
    return 0.28
  }

  const onKey = (e: KeyboardEvent, n: LayoutNode) => {
    if (!interactiveOf(n.node)) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNodeClick?.(n.node) }
  }

  return (
    <div ref={ref} className={cn('relative w-full', className)} style={{ height }} data-sankey>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Token flow Sankey" className="absolute inset-0">
        <g fill="none">
          {layout.links.map((l) => (
            <path
              key={l.id}
              data-link={l.id}
              data-width={l.width.toFixed(2)}
              d={l.d}
              stroke={FLOW_VAR[l.flow]}
              strokeWidth={l.width}
              strokeOpacity={linkOpacity(l.id, l.source, l.target)}
              style={{ transition: 'stroke-opacity 160ms' }}
              onMouseEnter={() => setHoverLink(l.id)}
              onMouseLeave={() => setHoverLink(null)}
            >
              <title>{`${nodeLabel.get(l.source) ?? l.source} → ${nodeLabel.get(l.target) ?? l.target}: ${fmt(l.value, units)} ${FLOW_LABEL[l.flow].toLowerCase()}${units === 'tokens' ? ` (${formatCount(l.tokens)})` : ''}`}</title>
            </path>
          ))}
        </g>
        <g>
          {layout.nodes.map((n) => {
            const h = Math.max(22, n.y1 - n.y0)
            const cy = (n.y0 + n.y1) / 2
            const cardX = n.node.column === 0 ? n.x0 - cardW - 4 : n.node.column === 2 ? n.x1 + 4 : (n.x0 + n.x1) / 2 - cardW / 2
            const color = nodeColor(n.node)
            const selected = selectedNodeId === n.id
            const compact = h < 30
            const maxChars = Math.floor((cardW - 14) / 6)
            const interactive = interactiveOf(n.node)
            const label = `${n.node.label}: ${units === 'cost' ? formatCost(n.value) : `${formatCount(Math.round(n.value))} tokens`}`
            return (
              <g
                key={n.id}
                data-node={n.id}
                {...(interactive
                  ? { role: 'button', tabIndex: 0, 'aria-pressed': selected }
                  : { role: 'img' })}
                aria-label={label}
                className={interactive ? 'cursor-pointer outline-none focus-visible:[&>rect:first-child]:stroke-[var(--ring)]' : undefined}
                onClick={interactive ? () => onNodeClick?.(n.node) : undefined}
                onKeyDown={interactive ? (e) => onKey(e, n) : undefined}
                onMouseEnter={() => setHoverNode(n.id)}
                onMouseLeave={() => setHoverNode(null)}
                onFocus={() => setHoverNode(n.id)}
                onBlur={() => setHoverNode(null)}
              >
                <rect x={n.x0} y={n.y0} width={Math.max(1, n.x1 - n.x0)} height={Math.max(1, n.y1 - n.y0)} fill={color} rx={2} opacity={0.9} />
                <rect
                  x={cardX} y={cy - h / 2} width={cardW} height={h} rx={8}
                  fill="var(--panel-solid)"
                  stroke={selected ? 'var(--selection)' : 'var(--panel-border)'}
                  strokeWidth={selected ? 2 : 1}
                />
                <rect x={cardX} y={cy - h / 2 + 3} width={3} height={h - 6} rx={1.5} fill={color} />
                {compact ? (
                  <text x={cardX + 10} y={cy + 4} fontSize={11} fill="var(--foreground)">
                    {clip(n.node.label, maxChars - 5)}
                    <tspan fill="var(--muted-foreground)" fontSize={10} dx={4}>{fmt(n.value, units)}</tspan>
                  </text>
                ) : (
                  <>
                    <text x={cardX + 10} y={cy - 2} fontSize={11} fill="var(--foreground)">{clip(n.node.label, maxChars)}</text>
                    <text x={cardX + 10} y={cy + 11} fontSize={10} fill="var(--muted-foreground)">{fmt(n.value, units)}</text>
                  </>
                )}
              </g>
            )
          })}
        </g>
      </svg>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" style={{ width, height }} aria-hidden="true" data-particles data-animating={animating ? 'true' : 'false'} />
      <table className="flow-sr-only">
        <caption>Token flow links</caption>
        <thead><tr><th>Source</th><th>Target</th><th>Tokens</th></tr></thead>
        <tbody>
          {sankey.links.map((l) => (
            <tr key={l.id}>
              <td>{nodeLabel.get(l.source) ?? l.source}</td>
              <td>{nodeLabel.get(l.target) ?? l.target}</td>
              <td>{formatCount(l.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
