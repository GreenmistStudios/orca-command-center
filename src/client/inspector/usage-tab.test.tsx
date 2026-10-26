import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockBackend, MOCK_IDS } from '../api/mock'
import { useOcc } from '../state/store'
import type { UsageSample } from '../../shared/contract'
import { mockBootstrap, renderWithMockStore, TEST_NOW } from '../../../test/client/render'

const backend = vi.hoisted(() => ({ current: null as null | { get: (r: string, o?: unknown) => Promise<unknown> } }))
vi.mock('../api/client', () => ({
  api: { get: (r: string, o?: unknown) => backend.current!.get(r, o) },
  ApiRequestError: class extends Error {},
}))

import { Inspector } from './Inspector'
import { compactionIndices, ContextChart, usageTabLabel } from './UsageTab'

beforeAll(() => { backend.current = createMockBackend({ now: TEST_NOW, live: false }) as never })
afterEach(cleanup)

const open = (id: string) =>
  renderWithMockStore(<div className="h-[600px]"><Inspector /></div>, { bootstrap: mockBootstrap({ now: TEST_NOW }), uiState: { selectedSessionId: id } })
const openUsage = async (id: string) => {
  open(id)
  fireEvent.click(screen.getByRole('radio', { name: /^Usage/ }))
}

const sample = (n: number, input: number, extra: Partial<UsageSample> = {}): UsageSample => ({
  id: `s${n}`, harness: 'opencode', sessionId: 'x', rootId: 'x', ledgerSeq: n, ts: 1_000 + n * 1000, startTs: null, model: null, agent: null,
  tokens: { input, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.01, aiu: null, ttftMs: 100, durationMs: 1000, finish: 'stop', source: 't', ...extra,
})

describe('Usage tab', () => {
  it('shows the tab with a compact label and KPIs for a mock root', async () => {
    await openUsage(MOCK_IDS.rootBuild)
    expect(screen.getByRole('radio', { name: /^Usage/ }).textContent).toMatch(/Usage/)
    await waitFor(() => expect(screen.getByTestId('usage-kpis')).toBeTruthy())
    for (const k of ['Inflow', 'Outflow', 'Cost', 'Cache hit', 'Calls', 'TTFT']) expect(document.querySelector(`[data-kpi="${k}"]`)).toBeTruthy()
    expect(screen.getByTestId('context-chart')).toBeTruthy()
    expect(screen.getByTestId('calls-table')).toBeTruthy()
  })

  it('usageTabLabel prefers cost, then tokens', () => {
    const s = useOcc.getState().sessions
    renderWithMockStore(<div />, { bootstrap: mockBootstrap({ now: TEST_NOW }) })
    const root = useOcc.getState().sessions[MOCK_IDS.rootBuild] ?? s[MOCK_IDS.rootBuild]
    expect(usageTabLabel({ ...root, cost: 1.42 })).toBe('Usage · $1.42')
    expect(usageTabLabel({ ...root, cost: 0, usage: undefined })).toBe('Usage')
    expect(usageTabLabel({ ...root, cost: 0, usage: { ...root.usage!, inflow: 2000, outflow: 500 } })).toMatch(/^Usage · 2\.5k/)
  })

  it('chart renders one point per call and marks a compaction drop', () => {
    const calls = [sample(1, 1000), sample(2, 2000), sample(3, 3000), sample(4, 900), sample(5, 1500)]
    expect(compactionIndices(calls)).toEqual([3])
    const onSelect = vi.fn()
    const { container } = render(<MotionConfig reducedMotion="always"><ContextChart calls={calls} highlightId={null} onSelect={onSelect} /></MotionConfig>)
    expect(container.querySelectorAll('[data-point]').length).toBe(5)
    expect(container.querySelectorAll('[data-compaction]').length).toBe(1)
    expect(container.querySelector('[data-compaction] title')?.textContent).toBe('Context compacted')
    const pt = container.querySelector('[data-point="s4"]')!
    fireEvent.mouseEnter(pt)
    expect(within(container as HTMLElement).getByTestId('context-tooltip').textContent).toContain('Context compacted')
    fireEvent.click(pt)
    expect(onSelect).toHaveBeenCalledWith('s4')
  })

  it('appends live calls and shows an in-flight row', async () => {
    await openUsage(MOCK_IDS.rootBuild)
    await waitFor(() => expect(screen.getByTestId('calls-table')).toBeTruthy())
    const before = document.querySelectorAll('[data-call]').length
    const reports = useOcc.getState().usageReports
    const rep = reports[Object.keys(reports).find((k) => k.startsWith('session:'))!]!.data!
    const seq = rep.ledgerSeq + 1
    const x: UsageSample = { ...sample(99, 4000), id: 'live-1', sessionId: MOCK_IDS.rootBuild, rootId: MOCK_IDS.rootBuild, ledgerSeq: seq, ts: Math.max(...rep.recentCalls.map((c) => c.ts), TEST_NOW) + 1000 }
    act(() => {
      useOcc.getState().applyStreamEvent({ type: 'usage', seq: useOcc.getState().seq + 1, samples: [x], estimates: [{ sessionId: MOCK_IDS.rootBuild, rootId: MOCK_IDS.rootBuild, harness: 'opencode', startedAt: Date.now(), updatedAt: Date.now(), estOutputTokens: 1200, inFlight: true }] } as never)
    })
    await waitFor(() => expect(document.querySelector('[data-call="live-1"]')).toBeTruthy(), { timeout: 2000 })
    expect(document.querySelectorAll('[data-call]').length).toBeGreaterThanOrEqual(before)
    expect(screen.getByTestId('inflight-row')).toBeTruthy()
  })

  it('workflow segment lists subagent bars and selects a session', async () => {
    await openUsage(MOCK_IDS.rootBuild)
    fireEvent.click(await screen.findByRole('radio', { name: 'Workflow' }))
    await waitFor(() => expect(document.querySelectorAll('[data-bar-list] [data-row]').length).toBeGreaterThan(0))
    const rows = [...document.querySelectorAll('[data-bar-list] button')] as HTMLButtonElement[]
    const target = rows.find((_, i) => i > 0) ?? rows[0]
    await act(async () => { fireEvent.click(target) })
    expect(useOcc.getState().ui.selectedSessionId).not.toBeNull()
  })

  it('shows the coverage state for a Copilot session before usage events', async () => {
    const real = backend.current!
    backend.current = { get: (r, o) => (r === 'GET /api/usage' ? real.get(r, o).then((x) => ({ ...(x as object), totals: { ...(x as { totals: object }).totals, calls: 0 }, recentCalls: [], inFlight: [] })) : real.get(r, o)) }
    try {
      renderWithMockStore(<div className="h-[600px]"><Inspector /></div>, { bootstrap: mockBootstrap({ now: TEST_NOW }), uiState: { selectedSessionId: MOCK_IDS.copilot } })
      fireEvent.click(screen.getByRole('radio', { name: /^Usage/ }))
      await waitFor(() => expect(screen.getByTestId('usage-empty')).toBeTruthy())
      expect(screen.getByTestId('usage-empty').textContent).toMatch(/No metered calls|reported when the session ends/)
    } finally { backend.current = real }
  })

  it('shows an error with retry', async () => {
    const real = backend.current!
    backend.current = { get: (r, o) => (r === 'GET /api/usage' ? Promise.reject(new Error('boom')) : real.get(r, o)) }
    try {
      await openUsage(MOCK_IDS.coderViewModel)
      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    } finally { backend.current = real }
  })
})
