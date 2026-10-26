import { sankey as d3Sankey, sankeyJustify, sankeyLinkHorizontal } from 'd3-sankey'
import type { FlowKind, SankeyNode, UsageSankey } from '../../../shared/contract'

export type SankeyScale = 'balanced' | 'linear'
export type SankeyUnits = 'tokens' | 'cost'

export interface LayoutNode {
  id: string
  node: SankeyNode
  x0: number
  x1: number
  y0: number
  y1: number
  /** Layout value (√ in balanced mode, cost in cost units). */
  layoutValue: number
  /** True (display) value in the chosen units. */
  value: number
}

export interface LayoutLink {
  id: string
  flow: FlowKind
  source: string
  target: string
  /** True tokens. */
  tokens: number
  /** True value in the chosen units. */
  value: number
  /** Ribbon thickness in px. */
  width: number
  /** SVG path (`sankeyLinkHorizontal`). */
  d: string
  /** Center-line polyline sampled from the same Bézier, for particles. */
  points: Array<[number, number]>
}

export interface SankeyLayout {
  nodes: LayoutNode[]
  links: LayoutLink[]
}

export interface LayoutOptions {
  width: number
  height: number
  scale: SankeyScale
  units: SankeyUnits
  /** Horizontal gutter reserved for node cards (default 0). */
  marginX?: number
}

export const NODE_WIDTH = 10
export const NODE_PADDING = 12

/** Pure: value used to size a ribbon. */
export function layoutValue(v: number, scale: SankeyScale): number {
  return scale === 'balanced' ? Math.sqrt(Math.max(0, v)) : Math.max(0, v)
}

/** Pure: per-link value in the chosen units (cost units apportion the middle node's cost by token share). */
export function linkValues(sankey: UsageSankey, units: SankeyUnits): Map<string, number> {
  const byId = new Map(sankey.nodes.map((n) => [n.id, n]))
  const out = new Map<string, number>()
  for (const l of sankey.links) {
    if (units === 'tokens') { out.set(l.id, l.value); continue }
    const mid = [byId.get(l.source), byId.get(l.target)].find((n) => n?.kind === 'middle')
    out.set(l.id, mid && mid.cost !== null && mid.value > 0 ? (l.value / mid.value) * mid.cost : 0)
  }
  return out
}

/** Pure: sample a cubic Bézier link centre line (same control points as `sankeyLinkHorizontal`). */
export function sampleLink(x0: number, y0: number, x1: number, y1: number, steps = 16): Array<[number, number]> {
  const xm = (x0 + x1) / 2
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    const x = u * u * u * x0 + 3 * u * u * t * xm + 3 * u * t * t * xm + t * t * t * x1
    const y = u * u * u * y0 + 3 * u * u * t * y0 + 3 * u * t * t * y1 + t * t * t * y1
    pts.push([x, y])
  }
  return pts
}

interface DNode { id: string; column: number }
interface DLink { source: string; target: string; value: number; id: string }

/** Layout the three-column Sankey. Zero-value links are dropped; nodes without links are dropped. */
export function layoutSankey(data: UsageSankey, opts: LayoutOptions): SankeyLayout {
  const { width, height, scale, units, marginX = 0 } = opts
  const values = linkValues(data, units)
  const links = data.links.filter((l) => (values.get(l.id) ?? 0) > 0)
  const used = new Set<string>()
  for (const l of links) { used.add(l.source); used.add(l.target) }
  const nodes = data.nodes.filter((n) => used.has(n.id))
  if (nodes.length === 0 || width <= 0 || height <= 0) return { nodes: [], links: [] }

  const gen = d3Sankey<DNode, DLink>()
    .nodeId((d) => d.id)
    .nodeAlign((n, count) => (n as unknown as DNode).column ?? sankeyJustify(n, count))
    .nodeWidth(NODE_WIDTH)
    .nodePadding(NODE_PADDING)
    .nodeSort(null)
    .extent([[Math.min(marginX, width / 3), 4], [Math.max(width - marginX, width * (2 / 3)), Math.max(8, height - 4)]])

  const g = gen({
    nodes: nodes.map((n) => ({ id: n.id, column: n.column })),
    links: links.map((l) => ({ id: l.id, source: l.source, target: l.target, value: layoutValue(values.get(l.id) ?? 0, scale) })),
  })

  const nodeMeta = new Map(nodes.map((n) => [n.id, n]))
  const linkSum = new Map<string, number>()
  for (const l of links) {
    const v = values.get(l.id) ?? 0
    linkSum.set(l.source, (linkSum.get(l.source) ?? 0) + v)
    linkSum.set(l.target, (linkSum.get(l.target) ?? 0) + v)
  }
  /** True display value: contract tokens for nodes, middle cost, else Σ of the node's (single-sided) links. */
  const trueValue = (n: SankeyNode): number => {
    if (units === 'tokens') return n.value
    return n.kind === 'middle' ? (n.cost ?? 0) : (linkSum.get(n.id) ?? 0)
  }
  const rawLinks = new Map(data.links.map((l) => [l.id, l]))
  const link = sankeyLinkHorizontal<DNode, DLink>()
  const outNodes: LayoutNode[] = g.nodes.map((n) => ({
    id: n.id,
    node: nodeMeta.get(n.id)!,
    x0: n.x0 ?? 0, x1: n.x1 ?? 0, y0: n.y0 ?? 0, y1: n.y1 ?? 0,
    layoutValue: n.value ?? 0,
    value: trueValue(nodeMeta.get(n.id)!),
  }))
  const outLinks: LayoutLink[] = g.links.map((l) => {
    const s = l.source as unknown as { id: string; x1: number }
    const t = l.target as unknown as { id: string; x0: number }
    const raw = rawLinks.get((l as unknown as DLink).id)!
    return {
      id: raw.id,
      flow: raw.flow,
      source: s.id,
      target: t.id,
      tokens: raw.value,
      value: values.get(raw.id) ?? 0,
      width: Math.max(1, l.width ?? 1),
      d: link(l) ?? '',
      points: sampleLink(s.x1, l.y0 ?? 0, t.x0, l.y1 ?? 0),
    }
  })
  return { nodes: outNodes, links: outLinks }
}

/** Stable signature so memoised layouts only recompute when structure or values change. */
export function sankeySignature(data: UsageSankey): string {
  return `${data.middle}|${data.nodes.map((n) => `${n.id}:${n.value}:${n.cost ?? ''}`).join(',')}|${data.links.map((l) => `${l.id}:${l.value}`).join(',')}`
}
