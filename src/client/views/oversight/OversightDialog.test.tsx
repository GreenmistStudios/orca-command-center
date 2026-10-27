import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MOCK_IDS } from '../../api/mock-data'
import { useGlobalHotkeys } from '../../hooks/useGlobalHotkeys'
import { Header } from '../../shell/Header'
import { useOcc } from '../../state/store'
import { renderWithMockStore } from '../../../../test/client/render'
import { OversightDialog } from './OversightDialog'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  history.replaceState(null, '', '/?mock=1')
})
afterAll(() => history.replaceState(null, '', '/'))
beforeEach(() => localStorage.clear())

function Hotkeys() { useGlobalHotkeys(); return null }

function open(uiState = {}) {
  renderWithMockStore(<><Hotkeys /><OversightDialog /></>, { uiState: { oversightOpen: true, ...uiState } })
  return screen.getByTestId('oversight')
}

describe('OversightDialog', () => {
  it('lists repos with their worktrees, agents and runs', () => {
    const board = open()
    const repos = within(board).getAllByTestId('oversight-repo')
    expect(repos.length).toBeGreaterThan(1)
    expect(within(board).getAllByTestId('oversight-worktree').length).toBeGreaterThanOrEqual(repos.length)
    const agents = within(board).getAllByTestId('oversight-agent').map((a) => a.getAttribute('data-session-id'))
    expect(agents).toContain(MOCK_IDS.rootBuild)
    expect(agents).toContain(MOCK_IDS.copilot)
    expect(agents).not.toContain(MOCK_IDS.exploreUsages) // subagents roll up to their root
    expect(within(board).getAllByTestId('oversight-run').length).toBeGreaterThan(0)
    expect(within(board).getByTestId('oversight-totals').textContent).toMatch(/\d+ repos/)
    // Needs-you repos sort first.
    expect(repos[0]!.textContent).toMatch(/needs you/)
  })

  it('opens an agent in the DAG and closes', () => {
    const board = open()
    const chip = within(board).getAllByTestId('oversight-agent').find((a) => a.getAttribute('data-session-id') === MOCK_IDS.rootBuild)!
    fireEvent.click(chip)
    const ui = useOcc.getState().ui
    expect(ui.selectedSessionId).toBe(MOCK_IDS.rootBuild)
    expect(ui.view).toBe('dag')
    expect(ui.oversightOpen).toBe(false)
    expect(screen.queryByTestId('oversight')).toBeNull()
  })

  it('opens a run in the DAG and closes', () => {
    const board = open()
    const run = within(board).getAllByTestId('oversight-run').find((r) => r.getAttribute('data-run-id') === MOCK_IDS.runBoard)!
    fireEvent.click(run)
    const ui = useOcc.getState().ui
    expect(ui.selectedRunId).toBe(MOCK_IDS.runBoard)
    expect(ui.view).toBe('dag')
    expect(ui.oversightOpen).toBe(false)
  })

  it('narrows to the rail harness filter', () => {
    const board = open({ harnessFilter: 'copilot' })
    const agents = within(board).getAllByTestId('oversight-agent').map((a) => a.getAttribute('data-session-id'))
    expect(agents).toEqual([MOCK_IDS.copilot])
  })

  it('toggles with `o` and closes with Escape', () => {
    renderWithMockStore(<><Hotkeys /><OversightDialog /></>)
    expect(screen.queryByTestId('oversight')).toBeNull()
    act(() => { fireEvent.keyDown(window, { key: 'o' }) })
    expect(screen.getByTestId('oversight')).toBeTruthy()
    // Other single-key shortcuts are inert while the board is open.
    act(() => { fireEvent.keyDown(window, { key: '3' }) })
    expect(useOcc.getState().ui.view).not.toBe('timeline')
    act(() => { fireEvent.keyDown(window, { key: 'o' }) })
    expect(screen.queryByTestId('oversight')).toBeNull()
    act(() => { fireEvent.keyDown(window, { key: 'o' }) })
    act(() => { fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' }) })
    expect(useOcc.getState().ui.oversightOpen).toBe(false)
  })
})

describe('Header oversight button', () => {
  it('opens the board', () => {
    renderWithMockStore(<><Header /><OversightDialog /></>)
    fireEvent.click(screen.getByTestId('oversight-button'))
    expect(useOcc.getState().ui.oversightOpen).toBe(true)
    expect(screen.getByTestId('oversight')).toBeTruthy()
  })
})
