import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MOCK_IDS } from '../api/mock'
import { useOcc } from '../state/store'
import { mockBootstrap, renderWithMockStore } from '../../../test/client/render'
import { Rail } from './Rail'

const groupBtn = () => screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded') && b.textContent?.startsWith('acme-android'))!
const rootIds = () => screen.getAllByTestId('rail-root-row').map((e) => e.getAttribute('data-session-id'))

describe('Rail', () => {
  it('lists groups and orders urgent roots before working before done', () => {
    renderWithMockStore(<Rail />)
    expect(screen.getByRole('navigation', { name: 'Fleet' })).toBeTruthy()
    expect(groupBtn()).toBeTruthy()
    const ids = rootIds()
    expect(ids).toHaveLength(6)
    const pos = (id: string) => ids.indexOf(id)
    expect(pos(MOCK_IDS.blocked)).toBeLessThan(pos(MOCK_IDS.rootBuild))
    expect(pos(MOCK_IDS.waiting)).toBeLessThan(pos(MOCK_IDS.rootBuild))
  })

  it('Live filter, harness filter and query narrow the list', () => {
    renderWithMockStore(<Rail />)
    fireEvent.click(screen.getByRole('radio', { name: 'Live' }))
    expect(useOcc.getState().ui.liveOnly).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: /Copilot/ }))
    expect(rootIds()).toEqual([MOCK_IDS.copilot])
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    const title = useOcc.getState().sessions[MOCK_IDS.blocked].title
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: title } })
    expect(rootIds()).toEqual([MOCK_IDS.blocked])
  })

  it('shows the cast only for the selected root; cast click keeps root', () => {
    renderWithMockStore(<Rail />)
    fireEvent.click(screen.getAllByTestId('rail-root-row').find((e) => e.getAttribute('data-session-id') === MOCK_IDS.rootBuild)!)
    expect(useOcc.getState().ui.selectedRootId).toBe(MOCK_IDS.rootBuild)
    const rows = screen.getAllByTestId('rail-cast-row')
    expect(rows).toHaveLength(6)
    fireEvent.click(within(screen.getByTestId('rail-cast')).getAllByTestId('rail-cast-row')[1])
    const ui = useOcc.getState().ui
    expect(ui.selectedRootId).toBe(MOCK_IDS.rootBuild)
    expect(ui.selectedSessionId).not.toBe(MOCK_IDS.rootBuild)
    expect(screen.getAllByTestId('rail-cast-row').filter((r) => r.getAttribute('aria-current') === 'true')).toHaveLength(1)
  })

  it('collapses a workspace group', () => {
    renderWithMockStore(<Rail />)
    fireEvent.click(groupBtn())
    expect(useOcc.getState().ui.collapsedWorkspaces['wt_acme_main']).toBe(true)
    expect(groupBtn().getAttribute('aria-expanded')).toBe('false')
  })

  it('renders orchestration runs and selects one', () => {
    renderWithMockStore(<Rail />)
    const rows = screen.getAllByTestId('rail-run-row')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    fireEvent.click(rows.find((r) => r.getAttribute('data-run-id') === MOCK_IDS.runBoard)!)
    expect(useOcc.getState().ui.selectedRunId).toBe(MOCK_IDS.runBoard)
    expect(useOcc.getState().ui.view).toBe('dag')
  })

  it('empty states', () => {
    const b = mockBootstrap()
    const { unmount } = renderWithMockStore(<Rail />, { bootstrap: { ...b, sessions: [] } })
    expect(screen.getByText('No agent sessions in the last 24 h.')).toBeTruthy()
    unmount()
    renderWithMockStore(<Rail />, { uiState: { railQuery: 'zzzz-nomatch' } })
    expect(screen.getByText(/No sessions match your search/)).toBeTruthy()
    act(() => useOcc.getState().setRailQuery(''))
    act(() => useOcc.getState().setLiveOnly(true))
    // mock fleet has live roots, so the list is non-empty
    expect(rootIds().length).toBeGreaterThan(0)
  })

  it('root rows show tree cost, in/out micro bar and in-flight shimmer', () => {
    const b = mockBootstrap()
    const root = b.sessions.find((x) => x.parentId == null)!
    for (const x of b.sessions) if (x.usage) x.usage = { ...x.usage, inFlight: null }
    const tok = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    root.usage = {
      calls: 3, inflow: 750, outflow: 250, aiu: 0, cacheHitRate: null, rates: null, inFlight: null,
      tree: { sessions: 1, calls: 3, tokens: tok, inflow: 750, outflow: 250, cost: 3.5, costedCalls: 3, aiu: 0 },
    }
    renderWithMockStore(<Rail />, { bootstrap: b })
    const row = screen.getAllByTestId('rail-root-row').find((r) => r.getAttribute('data-session-id') === root.id)!
    expect(within(within(row).getByTestId('rail-cost')).getByRole('img', { name: /3\.50/ })).toBeTruthy()
    expect(within(row).getByTestId('rail-flow-bar').getAttribute('data-inflow-share')).toBe('0.750')
    expect(within(row).queryByTestId('rail-shimmer')).toBeNull()
    act(() => useOcc.setState((st) => ({
      sessions: { ...st.sessions, [root.id]: { ...st.sessions[root.id], usage: { ...st.sessions[root.id].usage!, inFlight: { startedAt: 1 } as never } } },
    })))
    const row2 = screen.getAllByTestId('rail-root-row').find((r) => r.getAttribute('data-session-id') === root.id)!
    expect(within(row2).getByTestId('rail-shimmer')).toBeTruthy()
  })
})
