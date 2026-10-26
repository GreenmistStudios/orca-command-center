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
  it('renders orca/stream pills, fleet pulse and the sources popover', async () => {
    renderWithMockStore(<Header />)
    expect(screen.getByTestId('orca-pill')).toHaveTextContent('Connected to a running Orca (pid 97499).')
    act(() => useOcc.getState().setConnection('live'))
    expect(screen.getByTestId('stream-pill')).toHaveTextContent('Live')
    act(() => useOcc.getState().setConnection('reconnecting'))
    expect(screen.getByTestId('stream-pill')).toHaveTextContent('Stream reconnecting…')
    expect(screen.getByTestId('fleet-pulse')).toHaveTextContent(/needs you/)
    expect(screen.getByTestId('source-chip-orca-orchestration')).toHaveTextContent('orchestration v43')
    await userEvent.click(screen.getByTestId('source-chips'))
    expect(await screen.findAllByTestId('source-row')).toHaveLength(5)
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

  it('shows the grey pill when Orca is stopped', () => {
    const b = mockBootstrap({ scenario: 'degraded' })
    const orca = { ...b.meta.orca, running: false, error: null }
    renderWithMockStore(<Header />, { bootstrap: { ...b, meta: { ...b.meta, orca }, orca: { ...b.orca, status: orca } } })
    expect(screen.getByTestId('orca-pill')).toHaveTextContent('Orca isn’t running; showing last-known state.')
  })
})

describe('Orca pill copy', () => {
  it('is neutral and honest when the CLI is unreachable', () => {
    const b = mockBootstrap({ scenario: 'degraded' })
    const orca = { ...b.meta.orca, running: false, error: 'timed out after 3000 ms' }
    renderWithMockStore(<Header />, { bootstrap: { ...b, meta: { ...b.meta, orca }, orca: { ...b.orca, status: orca } } })
    expect(screen.getByTestId('orca-pill')).toHaveTextContent('Can’t reach Orca CLI (timed out after 3000 ms) — retrying')
  })
})

describe('Orca pill: not checked yet', () => {
  it('shows a neutral "Checking Orca…" before the first poll completes', () => {
    const b = mockBootstrap({ scenario: 'degraded' })
    const orca = { ...b.meta.orca, running: false, error: null, checkedAt: 0 }
    renderWithMockStore(<Header />, { bootstrap: { ...b, meta: { ...b.meta, orca }, orca: { ...b.orca, status: orca } } })
    expect(screen.getByTestId('orca-pill')).toHaveTextContent('Checking Orca…')
  })

  it('keeps the not-running copy once checked', () => {
    const b = mockBootstrap({ scenario: 'degraded' })
    const orca = { ...b.meta.orca, running: false, error: null, checkedAt: 1234 }
    renderWithMockStore(<Header />, { bootstrap: { ...b, meta: { ...b.meta, orca }, orca: { ...b.orca, status: orca } } })
    expect(screen.getByTestId('orca-pill')).toHaveTextContent('Orca isn’t running; showing last-known state.')
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

describe('Header burn pill', () => {
  const setStats = (usage: unknown) => act(() => useOcc.setState((st) => ({ stats: { ...st.stats!, usage: usage as never } })))
  it('shows neutral state when nothing burns', () => {
    renderWithMockStore(<Header />)
    setStats({ totals: {}, rates: { windowMs: 300000, asOf: Date.now(), inflowPerMin: 0, outflowPerMin: 0, costPerHour: 0, callsPerMin: 0 } })
    expect(screen.getByTestId('burn-pill')).toHaveTextContent('No token burn')
  })
  it('shows $/h and tok/min and opens the fleet tokens view on click', async () => {
    renderWithMockStore(<Header />)
    setStats({ totals: {}, rates: { windowMs: 300000, asOf: Date.now() + 1e9, inflowPerMin: 40000, outflowPerMin: 2000, costPerHour: 3.4, callsPerMin: 2 } })
    const pill = screen.getByTestId('burn-pill')
    expect(within(pill).getByRole('img', { name: /3\.40/ })).toBeTruthy()
    expect(pill.textContent).toContain('tok/min')
    expect(pill.getAttribute('title')).toMatch(/5 minutes/)
    await userEvent.click(pill)
    expect(useOcc.getState().ui.view).toBe('tokens')
    expect(useOcc.getState().ui.tokens.scope).toBe('fleet')
  })
})
