// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageSample } from '../../../shared/contract'
import { mockBootstrap, renderWithMockStore } from '../../../../test/client/render'
import { MOCK_IDS } from '../../api/mock-data'
import { resetMockBackend } from '../../api/mock'
import { DEFAULT_TOKENS_PREFS, useOcc, type TokensPrefs } from '../../state/store'
import { usageBus } from '../../state/usage-bus'
import { setFlowReducedOverride } from '../../ui/flow'
import { stubCanvas, stubRaf } from '../../ui/flow/testutil'
import { TokensView } from './TokensView'

const st = () => useOcc.getState()
const prefs = (p: Partial<TokensPrefs>) => ({ tokens: { ...DEFAULT_TOKENS_PREFS, ...p } })
let seq = 50_000_000
let frame = 90_000
const sample = (over: Partial<UsageSample> = {}): UsageSample => ({
  id: `t:${++seq}`, harness: 'opencode', sessionId: MOCK_IDS.coderViewModel, rootId: MOCK_IDS.rootBuild, ledgerSeq: seq, ts: Date.now(), startTs: null,
  model: { providerId: 'anthropic', modelId: 'claude-sonnet-5.5' }, agent: 'sonnet-coder',
  tokens: { input: 100, output: 500, reasoning: 50, cacheRead: 9000, cacheWrite: 0 }, cost: 0.05, aiu: null, ttftMs: 800, durationMs: 5000, finish: 'stop', source: 't', ...over,
})
const push = (...samples: UsageSample[]) => act(() => { st().applyStreamEvent({ type: 'usage', seq: ++frame, samples, estimates: [] }) })
const inflowOf = () => Number(within(screen.getByTestId('kpi-inflow')).getByRole('text').getAttribute('aria-label')!.replace(/[^0-9]/g, ''))
const reportKeys = () => Object.keys(st().usageReports)

beforeEach(() => {
  history.replaceState(null, '', '/?mock=1')
  resetMockBackend()
  usageBus.clear()
  stubCanvas()
  stubRaf()
  setFlowReducedOverride(true)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setFlowReducedOverride(null); usageBus.clear() })

const ready = () => screen.findByTestId('tokens-kpis', {}, { timeout: 3000 })

describe('TokensView', () => {
  it('renders all sections for the fleet scope (24 h default)', async () => {
    renderWithMockStore(<TokensView />, { uiState: prefs({ scope: 'fleet' }) })
    await ready()
    for (const r of ['Inflow', 'Outflow', 'Cost', 'Burn', 'Cache hit', 'Calls']) expect(screen.getByRole('region', { name: r })).toBeTruthy()
    expect(screen.getByTestId('tokens-flow')).toBeTruthy()
    expect(screen.getByTestId('tokens-leaderboard')).toBeTruthy()
    expect(screen.getByTestId('tokens-stream')).toBeTruthy()
    expect(screen.queryByTestId('tokens-yield')).toBeNull()
    expect(reportKeys().some((k) => k.startsWith('fleet::86400000'))).toBe(true)
    expect(screen.getByRole('radio', { name: '24h' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Fleet' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('tokens-flow-summary').textContent).toMatch(/^Token flow:/)
  })

  it('renders the workflow scope with yield, and Yield opens Changes', async () => {
    renderWithMockStore(<TokensView />, { uiState: { selectedSessionId: MOCK_IDS.coderViewModel, selectedRootId: MOCK_IDS.rootBuild } })
    await ready()
    expect(reportKeys().some((k) => k.startsWith(`workflow:${MOCK_IDS.rootBuild}:all`))).toBe(true)
    expect(screen.getByRole('radio', { name: /^Workflow/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('tokens-yield'))
    expect(st().ui.view).toBe('changes')
  })

  it('switching window/units/middle persists prefs and refetches the matching report key', async () => {
    renderWithMockStore(<TokensView />, { uiState: prefs({ scope: 'fleet' }) })
    await ready()
    fireEvent.click(screen.getByRole('radio', { name: '15m' }))
    await waitFor(() => expect(reportKeys().some((k) => k.startsWith('fleet::900000'))).toBe(true))
    expect(st().ui.tokens.windowMs).toBe(900_000)
    fireEvent.click(screen.getByRole('radio', { name: 'Sessions' }))
    await waitFor(() => expect(reportKeys().some((k) => k.endsWith(':session'))).toBe(true))
    fireEvent.click(screen.getByRole('radio', { name: 'Cost' }))
    expect(st().ui.tokens.units).toBe('cost')
    expect(document.querySelectorAll('[data-cost-disclaimer]').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('radio', { name: 'Linear' }))
    expect(st().ui.tokens.scale).toBe('linear')
  })

  it('explicit scope switch to session uses a session report', async () => {
    renderWithMockStore(<TokensView />, { uiState: { selectedSessionId: MOCK_IDS.exploreBackoff, selectedRootId: MOCK_IDS.rootBuild } })
    await ready()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Scope' })).getByRole('radio', { name: /^Session/ }))
    await waitFor(() => expect(reportKeys().some((k) => k.startsWith(`session:${MOCK_IDS.exploreBackoff}:`))).toBe(true))
    expect(st().ui.tokens.scope).toBe('session')
  })

  it('a live sample increases Inflow and shows a delta chip', async () => {
    setFlowReducedOverride(false)
    renderWithMockStore(<TokensView />, { uiState: { selectedSessionId: MOCK_IDS.coderViewModel, selectedRootId: MOCK_IDS.rootBuild } })
    await ready()
    const before = inflowOf()
    push(sample())
    await waitFor(() => expect(inflowOf()).toBe(before + 9100), { timeout: 3000 })
    await waitFor(() => expect(within(screen.getByTestId('kpi-inflow')).getAllByText(/^\+9\.1k/).length).toBeGreaterThan(0))
  })

  it('sankey node click selects the session (middle = sessions)', async () => {
    renderWithMockStore(<TokensView />, { uiState: { ...prefs({ middle: 'session' }), selectedSessionId: MOCK_IDS.exploreBackoff, selectedRootId: MOCK_IDS.rootBuild } })
    await ready()
    const node = document.querySelector(`[data-node="mid:${MOCK_IDS.coderViewModel}"]`) as Element | null
    expect(node).not.toBeNull()
    fireEvent.click(node!)
    expect(st().ui.selectedSessionId).toBe(MOCK_IDS.coderViewModel)
  })

  it('sankey node click on an agent filters the leaderboard; chip clears it', async () => {
    renderWithMockStore(<TokensView />, { uiState: { ...prefs({ middle: 'agent' }) } })
    await ready()
    const node = document.querySelector('[data-node^="mid:"]:not([data-node="mid:other"])') as Element
    fireEvent.click(node)
    const chip = await screen.findByTestId('tokens-filter-chip')
    expect(chip.textContent).toContain('agent:')
    expect(screen.getByRole('tab', { name: 'Sessions' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(chip)
    expect(screen.queryByTestId('tokens-filter-chip')).toBeNull()
  })

  it('leaderboard tabs switch the rows', async () => {
    renderWithMockStore(<TokensView />, { uiState: prefs({ scope: 'fleet' }) })
    await ready()
    const keys = () => [...document.querySelectorAll('[data-bar-list] [data-row]')].map((e) => e.getAttribute('data-row'))
    const agents = keys()
    expect(agents.length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    expect(keys()).not.toEqual(agents)
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    const first = document.querySelector('[data-bar-list] button')!
    fireEvent.click(first)
    expect(st().ui.selectedSessionId).not.toBeNull()
  })

  it('brushing the stream shows a zoom chip that resets', async () => {
    renderWithMockStore(<TokensView />)
    await ready()
    const root = document.querySelector('[data-stream]')!
    root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 720, bottom: 220, width: 720, height: 220, x: 0, y: 0, toJSON() {} })
    fireEvent.pointerDown(root, { clientX: 100 })
    fireEvent.pointerMove(root, { clientX: 300 })
    fireEvent.pointerUp(root, { clientX: 300 })
    const reset = await screen.findByTestId('tokens-reset-zoom')
    fireEvent.click(reset)
    expect(screen.queryByTestId('tokens-reset-zoom')).toBeNull()
  })

  it('calls ledger renders rows for a small scope, session click selects', async () => {
    renderWithMockStore(<TokensView />, { uiState: { ...prefs({ scope: 'session', showCalls: true }), selectedSessionId: MOCK_IDS.exploreBackoff, selectedRootId: MOCK_IDS.rootBuild } })
    const ledger = await screen.findByTestId('tokens-calls', {}, { timeout: 3000 })
    await waitFor(() => expect(ledger.querySelectorAll('[data-call]').length).toBeGreaterThanOrEqual(20))
    const before = ledger.querySelectorAll('[data-call]').length
    expect(within(ledger).queryByText('Load older')).toBeNull()
    expect(before).toBeLessThanOrEqual(60)
    fireEvent.click(within(ledger.querySelector('[data-call]') as HTMLElement).getAllByRole('button')[0])
    expect(st().ui.selectedSessionId).toBe(MOCK_IDS.exploreBackoff)
  })

  it('calls ledger pages older calls (virtualized)', async () => {
    const h = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400)
    const w = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900)
    renderWithMockStore(<TokensView />, { uiState: { ...prefs({ scope: 'fleet', showCalls: true }) } })
    const ledger = await screen.findByTestId('tokens-calls', {}, { timeout: 3000 })
    const more = await within(ledger).findByText('Load older', {}, { timeout: 3000 })
    expect(ledger.querySelector('[data-testid="tokens-calls-scroll"]')).not.toBeNull()
    const n = () => Number(/(\d+) loaded/.exec(ledger.textContent!)![1])
    const before = n()
    fireEvent.click(more)
    await waitFor(() => expect(n()).toBeGreaterThan(before))
    h.mockRestore(); w.mockRestore()
  })

  it('CSV export downloads all loaded calls with headers', async () => {
    let blob: Blob | null = null
    const url = globalThis.URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown }
    url.createObjectURL = (b: Blob) => { blob = b; return 'blob:x' }
    url.revokeObjectURL = () => {}
    renderWithMockStore(<TokensView />, { uiState: { ...prefs({ scope: 'session' }), selectedSessionId: MOCK_IDS.exploreBackoff, selectedRootId: MOCK_IDS.rootBuild } })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Export calls as CSV' }))
    await waitFor(() => expect(blob).not.toBeNull(), { timeout: 3000 })
    const text = await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsText(blob!) })
    const lines = text.trimEnd().split('\r\n')
    expect(lines[0]).toMatch(/^id,time,session,harness,agent,model,input,cache_read/)
    expect(lines.length).toBeGreaterThan(20)
    delete url.createObjectURL; delete url.revokeObjectURL
  })

  it('shows the empty state for a scope without metered calls', async () => {
    renderWithMockStore(<TokensView />, { uiState: { selectedRunId: MOCK_IDS.runSpike } })
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByTestId('empty-state').textContent).toMatch(/No metered calls in this scope yet\.|no linked sessions/)
  })

  it('shows an error with retry', async () => {
    renderWithMockStore(<TokensView />)
    act(() => { st().selectRun('run_missing') })
    const err = await screen.findByTestId('tokens-error', {}, { timeout: 3000 })
    expect(within(err).getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('shows a skeleton while loading', () => {
    renderWithMockStore(<TokensView />)
    expect(screen.getByTestId('tokens-skeleton')).toBeTruthy()
  })

  it('does not re-render per sample: bounded commits for 50 live samples', async () => {
    let commits = 0
    renderWithMockStore(<Profiler id="t" onRender={() => { commits++ }}><TokensView /></Profiler>, { uiState: { selectedSessionId: MOCK_IDS.coderViewModel, selectedRootId: MOCK_IDS.rootBuild } })
    await ready()
    const before = commits
    for (let i = 0; i < 50; i++) push(sample({ ts: Date.now() + i }))
    await waitFor(() => expect(inflowOf()).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 600))
    expect(commits - before).toBeLessThan(15)
  })
})
