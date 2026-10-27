import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { mockBootstrap, renderWithMockStore } from '../../../test/client/render'
import { App } from '../App'
import { MOCK_IDS, resetMockBackend } from '../api/mock'
import { resetOccStore, useOcc } from '../state/store'
import { Banner } from './Banner'
import { Dock } from './Dock'
import { Header } from './Header'
import { Shell } from './Shell'
import { ViewTabs } from './ViewTabs'

afterEach(() => { history.replaceState(null, '', '/'); resetMockBackend(); resetOccStore() })

describe('Header', () => {
  it('rolls connections into one status bubble whose overlay lists them all', async () => {
    renderWithMockStore(<Header />)
    act(() => useOcc.getState().setConnection('live'))
    expect(screen.getByTestId('fleet-pulse')).toHaveTextContent(/needs you/)
    const bubble = screen.getByTestId('status-bubble')
    await userEvent.hover(bubble)
    expect(await screen.findByTestId('orca-pill')).toHaveTextContent('Connected to a running Orca (pid 97499).')
    expect(screen.getByTestId('stream-pill')).toHaveTextContent('Live')
    expect(screen.getAllByTestId('source-row')).toHaveLength(5)
    act(() => useOcc.getState().setConnection('reconnecting'))
    expect(screen.getByTestId('stream-pill')).toHaveTextContent('Stream reconnecting…')
    expect(bubble).not.toHaveAttribute('data-health', 'ok')
  })

  it('"needs you" clears the selection; ⌘K opens the palette; theme toggles', async () => {
    renderWithMockStore(<Header />)
    expect(useOcc.getState().ui.selectedSessionId).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /needs you/ }))
    expect(useOcc.getState().ui.selectedSessionId).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Search/ }))
    expect(useOcc.getState().ui.paletteOpen).toBe(true)
    const before = useOcc.getState().ui.theme
    await userEvent.click(screen.getByRole('button', { name: /Switch to/ }))
    expect(useOcc.getState().ui.theme).not.toBe(before)
  })

  it('shows Orca stopped in the overlay', async () => {
    renderWithMockStore(<Header />, { bootstrap: mockBootstrap({ scenario: 'degraded' }) })
    expect(screen.getByTestId('status-bubble')).not.toHaveAttribute('data-health', 'ok')
    await userEvent.hover(screen.getByTestId('status-bubble'))
    expect(await screen.findByTestId('orca-pill')).toHaveTextContent('Orca isn’t running; showing last-known state.')
  })
})

describe('Banner', () => {
  it('is hidden when everything is healthy', () => {
    renderWithMockStore(<Banner />)
    expect(screen.queryByTestId('banner')).toBeNull()
  })
  it('lists orca stopped, source problems, schema and degraded features', () => {
    renderWithMockStore(<Banner />, { bootstrap: mockBootstrap({ scenario: 'degraded' }) })
    const lines = screen.getAllByTestId('banner-line').map((l) => l.textContent)
    expect(lines.some((l) => l?.includes('Orca isn’t running'))).toBe(true)
    expect(lines.some((l) => l?.includes('Copilot CLI not found'))).toBe(true)
    expect(lines.some((l) => l?.includes('newer Orca schema') && l.includes('(schema v44)'))).toBe(true)
    expect(lines.some((l) => l?.includes('Worker heartbeat'))).toBe(true)
  })
})

describe('Dock and tabs', () => {
  it('switches between the inspector and attention panel', async () => {
    history.replaceState(null, '', '/?mock=1') // route fetchTask through the mock backend
    renderWithMockStore(<Dock />)
    expect(screen.getByTestId('session-inspector')).toBeInTheDocument()
    act(() => useOcc.getState().selectSession(null))
    expect(screen.getByTestId('attention-panel')).toBeInTheDocument()
    act(() => useOcc.getState().selectTask('t3'))
    // The task inspector shows a skeleton while fetchTask resolves.
    expect(await screen.findByTestId('task-inspector')).toBeInTheDocument()
  })

  it('resizes with the keyboard within bounds', async () => {
    renderWithMockStore(<Dock />)
    const handle = screen.getByTestId('dock-handle')
    handle.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(useOcc.getState().ui.dockWidth).toBe(408)
  })

  it('defaults to Fleet, which has no center tab (it lives in the rail)', () => {
    renderWithMockStore(<ViewTabs />)
    expect(useOcc.getState().ui.view).toBe('fleet')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).not.toContain('Fleet')
    expect(tabs.every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true)
    expect(tabs[0]).toHaveAttribute('tabindex', '0')
  })

  it('view tabs switch views and relabel for runs', async () => {
    renderWithMockStore(<ViewTabs />)
    await userEvent.click(screen.getByRole('tab', { name: /Stream/ }))
    expect(useOcc.getState().ui.view).toBe('stream')
    expect(screen.getByRole('tab', { name: /^DAG/ })).toBeInTheDocument()
    act(() => useOcc.getState().selectRun(MOCK_IDS.runBoard))
    expect(screen.getByRole('tab', { name: /Run DAG/ })).toBeInTheDocument()
  })
})

describe('Shell', () => {
  it('shows the splash, then the shell once bootstrapped', () => {
    renderWithMockStore(<Shell />, { bootstrap: null })
    expect(screen.getByTestId('splash')).toHaveTextContent('Connecting to Orca…')
    act(() => useOcc.getState().applyBootstrap(mockBootstrap()))
    expect(screen.getByTestId('shell')).toBeInTheDocument()
    expect(screen.getByTestId('center-view')).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Fleet' })).getByText('Fix flaky paparazzi snapshot tests')).toBeInTheDocument()
  })

  it('App boots from the mock backend with ?mock=1', async () => {
    history.replaceState(null, '', '/?mock=1')
    resetOccStore()
    renderWithMockStore(<App />, { bootstrap: null })
    await waitFor(() => expect(screen.getByTestId('shell')).toBeInTheDocument())
    expect(useOcc.getState().connection).toBe('live')
    expect(location.search).toContain('mock=1')
  })
})
