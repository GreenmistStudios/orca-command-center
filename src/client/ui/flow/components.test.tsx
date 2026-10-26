import { act, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnimatedBarList, rankDeltas, rankGlyph } from './AnimatedBarList'
import { CostDisclaimer } from './CostDisclaimer'
import { DeltaChips, mergeChip, type DeltaChipsHandle } from './DeltaChips'
import { FlowLegend } from './FlowLegend'
import { formatFlowValue } from './format'
import { InFlightMeter } from './InFlightMeter'
import { KpiTile } from './KpiTile'
import { setFlowReducedOverride } from './motion'
import { Odometer } from './Odometer'
import { gaugeColor, RadialGauge } from './RadialGauge'
import { Sparkline, sparklinePoints } from './Sparkline'

afterEach(() => { setFlowReducedOverride(null); vi.useRealTimers() })

describe('Odometer', () => {
  it.each([
    [20483274, 'tokens', '20,483,274 tokens', '20.5M'],
    [950, 'tokens', '950 tokens', '950'],
    [0.42, 'cost', '0.42 US dollars', '$0.42'],
    [1234567, 'int', '1,234,567', '1,234,567'],
    [0.834, 'percent', '83 percent', '83%'],
  ] as const)('%s %s', (v, f, aria, text) => {
    const { container } = render(<Odometer value={v} format={f} />)
    const el = screen.getByRole('img', { name: aria })
    expect(el).toHaveAttribute('data-odometer')
    expect(container.querySelector('.flow-sr-only')).toBeNull()
    expect(formatFlowValue(v, f).text).toBe(text)
  })
  it('rolls digit columns with aria-hidden digits', () => {
    const { container } = render(<Odometer value={1234} format="int" />)
    expect(container.querySelectorAll('[data-digit]')).toHaveLength(4)
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
  it('reduced motion renders plain text', () => {
    setFlowReducedOverride(true)
    const { container } = render(<Odometer value={1234} format="int" />)
    expect(container.querySelectorAll('[data-digit]')).toHaveLength(0)
    expect(container.querySelector('[data-odometer]')?.textContent).toBe('1,234')
  })
})

describe('DeltaChips', () => {
  it('pure merge: same flow within 300ms sums; different flow appends; cap 3', () => {
    let r = mergeChip([], { label: 1000, flow: 'input' }, 0, 1)
    r = mergeChip(r.chips, { label: 500, flow: 'input' }, 200, 2)
    expect(r.chips).toHaveLength(1)
    expect(r.chips[0].text).toBe('+1.5k in')
    r = mergeChip(r.chips, { label: 500, flow: 'input' }, 900, 3)
    expect(r.chips).toHaveLength(2)
    r = mergeChip(r.chips, { label: 5, flow: 'output' }, 900, 4)
    r = mergeChip(r.chips, { label: 5, flow: 'reasoning' }, 900, 5)
    expect(r.chips).toHaveLength(3)
    expect(r.chips[0].id).toBe(3)
  })
  it('push renders chips, merges bursts and expires', async () => {
    const ref = createRef<DeltaChipsHandle>()
    const { container } = render(<DeltaChips ref={ref} />)
    act(() => { ref.current!.push({ label: 12400, flow: 'input' }); ref.current!.push({ label: 100, flow: 'input' }) })
    expect(container.querySelectorAll('[data-chip]')).toHaveLength(1)
    expect(container.textContent).toContain('+12.5k in')
    act(() => { ref.current!.push({ label: '+$0.21', flow: 'cost' }); ref.current!.push({ label: 3, flow: 'output' }); ref.current!.push({ label: 4, flow: 'reasoning' }) })
    await waitFor(() => expect(container.querySelectorAll('[data-chip]')).toHaveLength(0), { timeout: 3000 })
  })
  it('reduced renders nothing', () => {
    setFlowReducedOverride(true)
    const ref = createRef<DeltaChipsHandle>()
    const { container } = render(<DeltaChips ref={ref} />)
    act(() => ref.current!.push({ label: 5, flow: 'input' }))
    expect(container.querySelector('[data-chip]')).toBeNull()
  })
})

describe('RadialGauge', () => {
  it('threshold colors', () => {
    expect(gaugeColor(0.2)).toBe('var(--status-failed)')
    expect(gaugeColor(0.5)).toBe('var(--flow-cost)')
    expect(gaugeColor(0.9)).toBe('var(--flow-cache-read)')
    expect(gaugeColor(0.5, { low: 0.6, mid: 0.8 })).toBe('var(--status-failed)')
    expect(gaugeColor(null)).toBe('var(--muted)')
  })
  it('renders label and value', () => {
    render(<RadialGauge value={0.83} label="Cache hit" />)
    expect(screen.getByRole('img', { name: 'Cache hit: 83%' })).toHaveAttribute('data-color', 'var(--flow-cache-read)')
    render(<RadialGauge value={null} label="Empty" />)
    expect(screen.getByRole('img', { name: 'Empty: no data' })).toBeInTheDocument()
  })
})

describe('AnimatedBarList', () => {
  const rows = (keys: string[]) => keys.map((k, i) => ({ key: k, label: k, value: 100 - i * 10, split: [{ flow: 'input' as const, value: 60 }, { flow: 'output' as const, value: 40 }] }))
  it('pure rank deltas and glyphs', () => {
    expect(rankDeltas(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual({ c: 2, a: -1, b: -1 })
    expect(rankDeltas(['a'], ['a', 'new'])).toEqual({})
    expect(rankGlyph(2)).toBe('▲2')
    expect(rankGlyph(-1)).toBe('▼1')
  })
  it('renders rows in order and flashes rank deltas', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<AnimatedBarList rows={rows(['a', 'b', 'c'])} />)
    expect([...container.querySelectorAll('[data-row]')].map((e) => e.getAttribute('data-row'))).toEqual(['a', 'b', 'c'])
    rerender(<AnimatedBarList rows={rows(['c', 'a', 'b'])} />)
    expect([...container.querySelectorAll('[data-row]')].map((e) => e.getAttribute('data-row'))).toEqual(['c', 'a', 'b'])
    expect(container.textContent).toContain('▲2')
    expect(container.textContent).toContain('▼1')
    act(() => { vi.advanceTimersByTime(500) })
    expect(container.textContent).not.toContain('▲2')
  })
  it('click rows', () => {
    const onClick = vi.fn()
    render(<AnimatedBarList rows={[{ key: 'a', label: 'Alpha', value: 5, onClick }]} />)
    screen.getByRole('button', { name: /Alpha/ }).click()
    expect(onClick).toHaveBeenCalled()
  })
})

describe('InFlightMeter', () => {
  it('shows the estimate then morphs to metered with a check tick', async () => {
    const { container, rerender } = render(<InFlightMeter estTokens={1200} startedAt={0} />)
    expect(container.textContent).toContain('≈ 1.2k out · streaming')
    expect(container.querySelector('[data-shimmer]')).not.toBeNull()
    rerender(<InFlightMeter estTokens={1200} startedAt={0} metered={1350} />)
    await waitFor(() => expect(container.textContent).toContain('1.4k out'))
    expect(container.querySelector('[data-inflight]')).toHaveAttribute('data-inflight', 'metered')
    expect(container.querySelector('[data-shimmer]')).toBeNull()
    await waitFor(() => expect(container.querySelector('[data-check]')).not.toBeNull())
  })
  it('reduced → static label', () => {
    setFlowReducedOverride(true)
    const { container } = render(<InFlightMeter estTokens={1200} startedAt={0} />)
    expect(container.textContent).toBe('streaming…')
  })
})

describe('misc', () => {
  it('Sparkline points', () => {
    expect(sparklinePoints([], 10, 10)).toEqual([])
    const p = sparklinePoints([0, 5, 10], 100, 24)
    expect(p[0][0]).toBe(0)
    expect(p[2][0]).toBe(100)
    expect(p[2][1]).toBeLessThan(p[0][1])
    const { container } = render(<Sparkline values={[1, 2, 3]} />)
    expect(container.querySelector('polyline')).not.toBeNull()
  })
  it('CostDisclaimer and FlowLegend', () => {
    render(<CostDisclaimer />)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Estimated by the harness at public list prices')
    const { container } = render(<FlowLegend />)
    expect(container.querySelectorAll('[data-flow]')).toHaveLength(5)
  })
  it('KpiTile composes label, odometer, sub, sparkline, info', () => {
    const ref = createRef<DeltaChipsHandle>()
    const { container } = render(<KpiTile label="Inflow" value={20483274} format="tokens" sub="sub-line" spark={[1, 2, 3]} chipsRef={ref} info={<CostDisclaimer />} />)
    expect(container.textContent).toContain('Inflow')
    expect(container.querySelector('[aria-label="20,483,274 tokens"]')).not.toBeNull()
    expect(container.textContent).toContain('sub-line')
    expect(container.querySelector('[data-sparkline]')).not.toBeNull()
    expect(container.querySelector('[data-delta-chips]')).not.toBeNull()
    expect(ref.current).not.toBeNull()
  })
})
