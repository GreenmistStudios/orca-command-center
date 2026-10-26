import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MOCK_IDS } from '../../api/mock'
import { useOcc } from '../../state/store'
import { renderWithMockStore } from '../../../../test/client/render'
import { DagView } from './DagView'
import type { LayoutFn } from './model'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  globalThis.DOMMatrixReadOnly ??= class { m22 = 1 } as never
  history.replaceState(null, '', '/?mock=1')
})
afterAll(() => history.replaceState(null, '', '/'))

const layout: LayoutFn = async (g) => Object.fromEntries(g.nodes.map((n, i) => [n.id, { x: i * 300, y: 0 }]))

describe('DagView', () => {
  it('empty state without selection', () => {
    renderWithMockStore(<DagView layout={layout} />, { bootstrap: null })
    expect(screen.getByText('Select an agent session or orchestration run.')).toBeTruthy()
  })

  it('renders the agent tree and selects on click', async () => {
    renderWithMockStore(<DagView layout={layout} />, { uiState: { selectedRootId: MOCK_IDS.rootBuild, selectedSessionId: MOCK_IDS.rootBuild } })
    await waitFor(() => expect(screen.getAllByTestId('session-node')).toHaveLength(7))
    expect(screen.getByTestId('dag-caption').textContent).toContain('6 agents')
    fireEvent.click(screen.getAllByTestId('session-node').find((n) => n.getAttribute('data-session-id') === MOCK_IDS.coderTests)!)
    expect(useOcc.getState().ui.selectedSessionId).toBe(MOCK_IDS.coderTests)
  })

  it('renders the isolated run caption', async () => {
    renderWithMockStore(<DagView layout={layout} />, { uiState: { selectedRootId: MOCK_IDS.rootBuild, selectedRunId: MOCK_IDS.runSpike } })
    await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(3))
    expect(screen.getByTestId('dag-caption').textContent).toBe('No dependencies in this run — 3 tasks dispatched independently.')
    act(() => fireEvent.click(screen.getByText('Isolated tasks (3)')))
  })

  it('renders run tasks with dependencies', async () => {
    renderWithMockStore(<DagView layout={layout} />, { uiState: { selectedRunId: MOCK_IDS.runBoard } })
    await waitFor(() => expect(screen.getAllByTestId('task-node').length).toBeGreaterThanOrEqual(6))
    expect(screen.getByTestId('dag-caption').textContent).toMatch(/^6 tasks · \d+ dependenc/)
  })
})
