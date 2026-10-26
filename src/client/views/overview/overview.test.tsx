// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../../shared/contract'
import { mockBootstrap, renderWithMockStore } from '../../../../test/client/render'
import { useOcc } from '../../state/store'
import { OverviewView, sortScoreboard } from './OverviewView'

describe('OverviewView', () => {
  it('shows KPI values from stats', () => {
    const b = mockBootstrap()
    renderWithMockStore(<OverviewView />, { bootstrap: b })
    const s = b.stats
    expect(screen.getByTestId('kpi-live-value').textContent).toBe(String(s.sessions.live))
    expect(screen.getByTestId('kpi-tools').textContent).toContain(`${s.activity.toolErrors} errors`)
    expect(screen.getByTestId('kpi-mcp').textContent).toContain(`${s.mcpServers.length} servers`)
    expect(screen.getByTestId('overview-window').textContent).toMatch(/^Last /)
  })

  it('histogram bar heights are proportional to totals', () => {
    const b = mockBootstrap()
    b.stats.histogram = b.stats.histogram.map((h, i) => ({ ...h, thinking: 0, mcp: 0, edits: 0, errors: 0, tools: i === 0 ? 10 : i === 1 ? 5 : 0 }))
    renderWithMockStore(<OverviewView />, { bootstrap: b })
    const bars = screen.getAllByTestId('hist-bar')
    const h = (i: number) => Number(bars[i].querySelector('rect[data-series="tools"]')!.getAttribute('data-height'))
    expect(h(0)).toBeGreaterThan(0)
    expect(h(1)).toBeCloseTo(h(0) / 2, 1)
    expect(bars[2].querySelector('rect[data-series]')).toBeNull()
  })

  it('tool click sets stream filters and view', () => {
    renderWithMockStore(<OverviewView />)
    const row = screen.getAllByTestId('tool-row')[0]
    fireEvent.click(row)
    const ui = useOcc.getState().ui
    expect(ui.view).toBe('stream')
    expect(ui.streamFilters.scope).toBe('all')
    expect(ui.streamFilters.query).toBe(useOcc.getState().stats!.topTools[0].name)
  })

  it('mcp click sets stream filters', () => {
    renderWithMockStore(<OverviewView />)
    fireEvent.click(screen.getAllByTestId('mcp-row')[0])
    expect(useOcc.getState().ui.streamFilters.query).toBe(useOcc.getState().stats!.mcpServers[0].server)
  })

  it('scoreboard: default order live first then cost, row click selects', () => {
    renderWithMockStore(<OverviewView />)
    const rows = within(screen.getByTestId('scoreboard')).getAllByTestId('score-row')
    const roots = Object.values(useOcc.getState().sessions).filter((s) => s.parentId == null)
    expect(rows).toHaveLength(roots.length)
    const first = rows[0].dataset.id!
    expect(useOcc.getState().sessions[first].live).toBe(roots.some((r) => r.live))
    fireEvent.click(rows[1])
    expect(useOcc.getState().ui.selectedSessionId).toBe(rows[1].dataset.id)
  })

  it('clicking a header sorts and toggles direction', () => {
    renderWithMockStore(<OverviewView />)
    const ids = () => screen.getAllByTestId('score-row').map((r) => useOcc.getState().sessions[r.dataset.id!].cost)
    fireEvent.click(screen.getByTestId('sort-cost'))
    const desc = ids()
    expect([...desc].sort((a, b) => b - a)).toEqual(desc)
    fireEvent.click(screen.getByTestId('sort-cost'))
    const asc = ids()
    expect([...asc].sort((a, b) => a - b)).toEqual(asc)
  })

  it('renders a loading state without stats', () => {
    renderWithMockStore(<OverviewView />, { bootstrap: null })
    expect(screen.getByText('Loading…')).toBeTruthy()
  })
})

describe('sortScoreboard', () => {
  const mk = (id: string, live: boolean, cost: number): SessionSummary => ({ id, live, cost, title: id, createdAt: 0, updatedAt: 1, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, descendantCount: 0, counters: null, workspace: null, agent: null, harness: 'opencode' }) as unknown as SessionSummary
  it('default: live first then cost desc', () => {
    const out = sortScoreboard([mk('a', false, 9), mk('b', true, 1), mk('c', true, 5)], 'default', 'desc')
    expect(out.map((s) => s.id)).toEqual(['c', 'b', 'a'])
  })
  it('sorts by title asc', () => {
    expect(sortScoreboard([mk('b', true, 1), mk('a', false, 1)], 'title', 'asc').map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('Tokens and Cost tiles use window usage and keep lifetime numbers in the sub-line', () => {
    const b = mockBootstrap()
    const z = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    b.stats.usage = {
      totals: { calls: 1, tokens: { ...z, input: 1000, output: 234 }, inflow: 1000, outflow: 234, cost: 1.25, costedCalls: 1, aiu: 0, cacheHitRate: null, firstTs: 1, lastTs: 2 },
      rates: { windowMs: 300000, asOf: 1, inflowPerMin: 0, outflowPerMin: 0, costPerHour: 0, callsPerMin: 0 },
    }
    renderWithMockStore(<OverviewView />, { bootstrap: b })
    expect(within(screen.getByTestId('kpi-tokens-value')).getByRole('img', { name: /1[.,]234|1\.2/ })).toBeTruthy()
    expect(within(screen.getByTestId('kpi-cost-value')).getByRole('img', { name: /1\.25/ })).toBeTruthy()
    expect(screen.getByTestId('kpi-cost').querySelector('[data-cost-disclaimer]')).toBeTruthy()
    expect(screen.getByTestId('kpi-cost-lifetime').textContent).toContain('lifetime of sessions active in window')
    expect(screen.getByTestId('kpi-tokens-lifetime').textContent).toContain('lifetime')
    fireEvent.click(screen.getByTestId('view-token-flow'))
    expect(useOcc.getState().ui.view).toBe('tokens')
  })
})
