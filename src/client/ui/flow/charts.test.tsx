import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageBucket, UsageSankey } from '../../../shared/contract'
import { MirroredStreamChart } from './MirroredStreamChart'
import { setFlowReducedOverride } from './motion'
import { frameSubscriberCount } from './frame'
import { SankeyChart } from './SankeyChart'
import { layoutSankey } from './sankey-layout'
import { stubCanvas, stubRaf } from './testutil'

const sankey: UsageSankey = {
  middle: 'agent',
  nodes: [
    { id: 's:input', label: 'Input', column: 0, kind: 'source', flow: 'input', sessionId: null, value: 900, cost: null },
    { id: 's:cacheRead', label: 'Cache read', column: 0, kind: 'source', flow: 'cacheRead', sessionId: null, value: 100, cost: null },
    { id: 'm:a', label: 'builder', column: 1, kind: 'middle', flow: null, sessionId: null, value: 1100, cost: 2 },
    { id: 'k:output', label: 'Output', column: 2, kind: 'sink', flow: 'output', sessionId: null, value: 100, cost: null },
  ],
  links: [
    { id: 'l1', source: 's:input', target: 'm:a', flow: 'input', value: 900 },
    { id: 'l2', source: 's:cacheRead', target: 'm:a', flow: 'cacheRead', value: 100 },
    { id: 'l3', source: 'm:a', target: 'k:output', flow: 'output', value: 100 },
  ],
}

beforeEach(() => { stubRaf() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setFlowReducedOverride(null) })

describe('layoutSankey', () => {
  const o = { width: 800, height: 300, units: 'tokens' as const }
  it('balanced compresses width ratios vs linear; true values preserved', () => {
    const lin = layoutSankey(sankey, { ...o, scale: 'linear' })
    const bal = layoutSankey(sankey, { ...o, scale: 'balanced' })
    const ratio = (l: ReturnType<typeof layoutSankey>) => l.links.find((x) => x.id === 'l1')!.width / l.links.find((x) => x.id === 'l2')!.width
    expect(ratio(lin)).toBeGreaterThan(ratio(bal))
    expect(ratio(bal)).toBeCloseTo(3, 0) // √900 / √100
    expect(bal.links.find((x) => x.id === 'l1')!.tokens).toBe(900)
    expect(bal.nodes.find((n) => n.id === 'm:a')!.value).toBe(1100)
  })
  it('fixes columns and drops empty links', () => {
    const l = layoutSankey({ ...sankey, links: [...sankey.links, { id: 'l0', source: 's:input', target: 'm:a', flow: 'input', value: 0 }] }, { ...o, scale: 'linear' })
    expect(l.links).toHaveLength(3)
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x0
    expect(x('s:input')).toBeLessThan(x('m:a'))
    expect(x('m:a')).toBeLessThan(x('k:output'))
  })
  it('cost units apportion middle cost; others zero out', () => {
    const l = layoutSankey(sankey, { ...o, scale: 'linear', units: 'cost' })
    expect(l.links.find((x) => x.id === 'l1')!.value).toBeCloseTo((900 / 1100) * 2)
    expect(l.nodes.find((n) => n.id === 'm:a')!.value).toBe(2)
  })
})

describe('SankeyChart', () => {
  it('renders nodes, links, hidden table; node click and keyboard', () => {
    const c = stubCanvas()
    const onNodeClick = vi.fn()
    const { container } = render(<SankeyChart sankey={sankey} scale="balanced" units="tokens" onNodeClick={onNodeClick} selectedNodeId="m:a" />)
    expect(container.querySelectorAll('[data-node]')).toHaveLength(4)
    expect(container.querySelectorAll('path[data-link]')).toHaveLength(3)
    const rows = container.querySelectorAll('table tbody tr')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toBe('InputQbuilder900'.replace('Q', ''))
    const node = screen.getByLabelText('builder: 1,100 tokens')
    expect(node).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(node)
    expect(onNodeClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'm:a' }))
    fireEvent.keyDown(node, { key: 'Enter' })
    expect(onNodeClick).toHaveBeenCalledTimes(2)
    expect(c.spy).toHaveBeenCalled()
  })
  it('hover dims other links; burst emitter reaches the engine without errors', () => {
    stubCanvas()
    let fn: ((id: string, t: number) => void) | null = null
    const burstEmitter = { subscribe: (f: (id: string, t: number) => void) => { fn = f; return () => { fn = null } } }
    const { container, unmount } = render(<SankeyChart sankey={sankey} scale="linear" units="tokens" burstEmitter={burstEmitter} rates={{ l1: 50 }} />)
    fireEvent.mouseEnter(container.querySelector('[data-node="s:input"]')!)
    expect(container.querySelector('path[data-link="l1"]')).toHaveAttribute('stroke-opacity', '0.55')
    expect(container.querySelector('path[data-link="l3"]')).toHaveAttribute('stroke-opacity', '0.12')
    expect(() => fn?.('l1', 1000)).not.toThrow()
    unmount()
    expect(fn).toBeNull()
  })
  it('reduced motion renders without animating', () => {
    stubCanvas()
    setFlowReducedOverride(true)
    const { container } = render(<SankeyChart sankey={sankey} scale="linear" units="cost" />)
    expect(container.querySelectorAll('[data-node]').length).toBeGreaterThan(0)
  })
})

describe('SankeyChart interactivity and animating', () => {
  it('only middle nodes are buttons by default; custom predicate overrides', () => {
    stubCanvas()
    const { container, rerender } = render(<SankeyChart sankey={sankey} scale="linear" units="tokens" onNodeClick={() => {}} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(container.querySelector('[data-node="s:input"]')).toHaveAttribute('role', 'img')
    expect(container.querySelector('[data-node="s:input"]')).not.toHaveAttribute('tabindex')
    rerender(<SankeyChart sankey={sankey} scale="linear" units="tokens" />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    rerender(<SankeyChart sankey={sankey} scale="linear" units="tokens" onNodeClick={() => {}} isNodeInteractive={(n) => n.column === 0} />)
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
  it('data-animating true normally, false when reduced', () => {
    stubCanvas()
    const { container, unmount } = render(<SankeyChart sankey={sankey} scale="linear" units="tokens" />)
    expect(container.querySelector('[data-particles]')).toHaveAttribute('data-animating', 'true')
    unmount()
    setFlowReducedOverride(true)
    const r = render(<SankeyChart sankey={sankey} scale="linear" units="tokens" />)
    expect(r.container.querySelector('[data-particles]')).toHaveAttribute('data-animating', 'false')
  })
})

describe('MirroredStreamChart', () => {
  const buckets: UsageBucket[] = Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, input: 10 + i, cacheRead: 5, cacheWrite: 1, output: 8, reasoning: 2, cost: 0.1, aiu: 0, calls: 1 }))
  it('renders, draws on the canvas and shows a tooltip + brush callback', () => {
    const c = stubCanvas()
    const onBrush = vi.fn()
    const { container } = render(<MirroredStreamChart buckets={buckets} bucketMs={1000} domain={[0, 10_000]} units="tokens" markers={[2000]} onBrush={onBrush} />)
    expect(c.calls).toContain('fillRect')
    expect(container.querySelector('[data-marker="2000"]')).not.toBeNull()
    const root = container.querySelector('[data-stream]')!
    root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 720, bottom: 240, width: 720, height: 240, x: 0, y: 0, toJSON() {} })
    fireEvent.pointerMove(root, { clientX: 150 })
    expect(container.querySelector('[data-tooltip]')?.textContent).toContain('Cache write')
    expect(container.querySelector('[data-crosshair]')).not.toBeNull()
    fireEvent.pointerDown(root, { clientX: 100 })
    fireEvent.pointerMove(root, { clientX: 300 })
    expect(container.querySelector('[data-brush]')).not.toBeNull()
    fireEvent.pointerUp(root, { clientX: 300 })
    expect(onBrush).toHaveBeenCalledWith([expect.any(Number), expect.any(Number)])
    expect(onBrush.mock.calls[0][0][0]).toBeLessThan(onBrush.mock.calls[0][0][1])
  })
  it('live mode shows a now-line and subscribes to the frame loop', () => {
    stubCanvas()
    const { container, unmount } = render(<MirroredStreamChart buckets={buckets} bucketMs={1000} domain="live" units="cost" />)
    expect(container.querySelector('[data-now-line]')).not.toBeNull()
    unmount()
  })
  it('live: animating true, subscribes once across data updates', () => {
    stubCanvas()
    const base = frameSubscriberCount()
    const { container, rerender, unmount } = render(<MirroredStreamChart buckets={buckets} bucketMs={1000} domain="live" units="cost" />)
    expect(container.querySelector('[data-stream-canvas]')).toHaveAttribute('data-animating', 'true')
    expect(frameSubscriberCount()).toBe(base + 1)
    rerender(<MirroredStreamChart buckets={[...buckets]} bucketMs={1000} domain="live" units="cost" />)
    rerender(<MirroredStreamChart buckets={[...buckets]} bucketMs={1000} domain="live" units="cost" />)
    expect(frameSubscriberCount()).toBe(base + 1)
    unmount()
    expect(frameSubscriberCount()).toBe(base)
  })
  it('reduced live: no frame subscription, 1 s interval redraw, not animating', () => {
    vi.useFakeTimers()
    const c = stubCanvas()
    setFlowReducedOverride(true)
    const base = frameSubscriberCount()
    const { container, unmount } = render(<MirroredStreamChart buckets={buckets} bucketMs={1000} domain="live" units="cost" />)
    expect(frameSubscriberCount()).toBe(base)
    expect(container.querySelector('[data-stream-canvas]')).toHaveAttribute('data-animating', 'false')
    const n = c.calls.length
    act(() => { vi.advanceTimersByTime(2100) })
    expect(c.calls.length).toBeGreaterThan(n)
    unmount()
    vi.useRealTimers()
  })
  it('static domain after easing is not animating', () => {
    stubCanvas()
    const { container } = render(<MirroredStreamChart buckets={buckets} bucketMs={1000} domain={[0, 10_000]} units="tokens" />)
    expect(container.querySelector('[data-stream-canvas]')).toHaveAttribute('data-animating', 'false')
  })
})
