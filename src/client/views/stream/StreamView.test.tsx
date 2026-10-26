import { act, fireEvent, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '../../../shared/contract'
import { useOcc } from '../../state/store'
import { renderWithMockStore } from '../../../../test/client/render'
import { StreamView } from './StreamView'
import { ev } from './filters.test'

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {})
})

function seed(events: ActivityEvent[]) {
  act(() => {
    const byId: Record<string, ActivityEvent> = {}
    for (const e of events) byId[e.id] = e
    useOcc.setState((s) => ({ activity: { byId, order: events.map((e) => e.id), version: s.activity.version + 1 } }))
  })
}
const base = [
  ev({ id: 'a', ts: 1000, title: 'first thing' }),
  ev({ id: 'b', ts: 2000, title: 'bitrise_get_build_log', status: 'error', kind: 'mcp', detailRef: 'p1' }),
  ev({ id: 'c', ts: 3000, title: 'third', kind: 'text', summary: 'hello body' }),
]
const rows = () => screen.queryAllByTestId('stream-row')

describe('StreamView', () => {
  it('renders rows, errors-only filters', () => {
    renderWithMockStore(<StreamView />, { bootstrap: null })
    seed(base)
    expect(rows()).toHaveLength(3)
    fireEvent.click(screen.getByText('Errors only'))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain('bitrise_get_build_log')
  })

  it('expands and opens inspector with activityId', () => {
    renderWithMockStore(<StreamView />, { bootstrap: null })
    seed(base)
    const spy = vi.fn()
    useOcc.setState({ selectSession: spy })
    fireEvent.click(screen.getByText('third'))
    expect(screen.getByText('hello body')).toBeTruthy()
    fireEvent.click(screen.getByText('Open in inspector'))
    expect(spy).toHaveBeenCalledWith('s1', { activityId: 'c' })
  })

  it('pause buffers arrivals and resume flushes', () => {
    renderWithMockStore(<StreamView />, { bootstrap: null })
    seed(base)
    act(() => useOcc.getState().setStreamFilters({ paused: true }))
    seed([...base, ev({ id: 'd', ts: 4000, title: 'fourth' })])
    expect(rows()).toHaveLength(3)
    expect(screen.getByTestId('new-events-chip').textContent).toContain('1 buffered')
    fireEvent.click(screen.getByTestId('new-events-chip'))
    expect(rows()).toHaveLength(4)
  })

  it('load older calls fetchScopedActivity', () => {
    renderWithMockStore(<StreamView />, { bootstrap: null, uiState: { selectedSessionId: 's1' } })
    const spy = vi.fn().mockResolvedValue(undefined)
    useOcc.setState({
      fetchScopedActivity: spy,
      scopedActivity: { 'session:s1': { status: 'ready', error: null, fetchedAt: 1, data: { events: base, before: 'x', hasMore: true } } },
    })
    act(() => useOcc.getState().setStreamFilters({ scope: 'session' }))
    fireEvent.click(screen.getByText('Load older'))
    expect(spy).toHaveBeenCalledWith({ sessionId: 's1' }, { older: true })
  })

  it('empty state with clear filters', () => {
    renderWithMockStore(<StreamView />, { bootstrap: null })
    seed(base)
    act(() => useOcc.getState().setStreamFilters({ harness: 'codex' }))
    expect(screen.getByText('Clear filters')).toBeTruthy()
  })
})
