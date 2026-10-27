import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useOcc } from '../../state/store'
import { renderWithMockStore } from '../../../../test/client/render'
import type { LayoutFn } from '../dag/model'
import { FleetView } from './FleetView'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
  globalThis.DOMMatrixReadOnly ??= class { m22 = 1 } as never
  history.replaceState(null, '', '/?mock=1')
})
afterAll(() => history.replaceState(null, '', '/'))
beforeEach(() => localStorage.clear())

const layout: LayoutFn = async (g) => Object.fromEntries(g.nodes.map((n, i) => [n.id, { x: i * 300, y: 0 }]))
const sessionNodes = () => screen.queryAllByTestId('fleet-node-session')

async function ready() {
  localStorage.setItem('occ.fleet.scope', 'all')
  renderWithMockStore(<FleetView layout={layout} />)
  await waitFor(() => expect(sessionNodes().length).toBeGreaterThan(0))
}

describe('FleetView', () => {
  it('renders node kinds', async () => {
    await ready()
    expect(screen.getByTestId('fleet-view')).toBeTruthy()
    expect(screen.getAllByTestId('fleet-node-project').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('fleet-node-worktree').length).toBeGreaterThan(0)
    expect(screen.getByTestId('fleet-summary').textContent).toMatch(/projects/)
  })

  it('shows session model names, not [object Object]', async () => {
    await ready()
    const text = sessionNodes().map((n) => n.textContent).join('\n')
    expect(text).not.toContain('[object')
    expect(text).toMatch(/opus-5\.5|sonnet-5\.5/)
  })

  it('toggles Active/All and persists scope', async () => {
    await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Active' }))
    expect(localStorage.getItem('occ.fleet.scope')).toBe('active')
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(localStorage.getItem('occ.fleet.scope')).toBe('all')
  })

  it('collapses on project click', async () => {
    await ready()
    const before = screen.getAllByTestId('fleet-node-worktree').length
    fireEvent.click(screen.getAllByTestId('fleet-node-project')[0]!)
    await waitFor(() => expect(screen.queryAllByTestId('fleet-node-worktree').length).toBeLessThan(before))
  })

  it('selects on click and opens the DAG on double-click', async () => {
    await ready()
    const node = sessionNodes()[0]!
    const id = node.getAttribute('data-node-id')!.slice(2)
    fireEvent.click(node)
    expect(useOcc.getState().ui.selectedSessionId).toBe(id)
    fireEvent.doubleClick(node)
    expect(useOcc.getState().ui.view).toBe('dag')
  })

  it('shows empty state with Show all', async () => {
    renderWithMockStore(<FleetView layout={layout} />, { bootstrap: undefined })
    act(() => { useOcc.setState({ sessions: {}, orca: null, orchestration: null, attention: [] }) })
    await waitFor(() => expect(screen.getByText('Nothing running')).toBeTruthy())
    fireEvent.click(screen.getByText('Show all'))
    expect(localStorage.getItem('occ.fleet.scope')).toBe('all')
  })
})
