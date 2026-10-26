// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AttentionItem } from '../../shared/contract'
import { renderWithMockStore, mockBootstrap } from '../../../test/client/render'
import { useOcc } from '../state/store'
import { AttentionPanel } from './AttentionPanel'
import { AttentionStrip } from './AttentionStrip'

const item = (o: Partial<AttentionItem> & { id: string }): AttentionItem => ({
  kind: 'error', severity: 'medium', sessionId: null, runId: null, taskId: null, title: o.id, detail: null, since: Date.now() - 60_000, source: 't', ...o,
})
const boot = (attention: AttentionItem[]) => ({ ...mockBootstrap(), attention })

describe('AttentionStrip', () => {
  it('renders nothing without items', () => {
    renderWithMockStore(<AttentionStrip />, { bootstrap: boot([]) })
    expect(screen.queryByTestId('attention-strip')).toBeNull()
  })

  it('orders high severity first, caps at 3 rows and shows +N more', () => {
    const items = [
      item({ id: 'm1', severity: 'medium' }), item({ id: 'h1', severity: 'high', kind: 'permission' }),
      item({ id: 'l1', severity: 'low' }), item({ id: 'm2', severity: 'medium' }), item({ id: 'h2', severity: 'high', kind: 'gate' }),
    ]
    renderWithMockStore(<AttentionStrip />, { bootstrap: boot(items) })
    const rows = screen.getAllByTestId('attention-row')
    expect(rows).toHaveLength(3)
    expect(rows[0].dataset.severity).toBe('high')
    expect(rows[1].dataset.severity).toBe('high')
    expect(screen.getByTestId('attention-more').textContent).toBe('+2 more')
  })

  it('+N more clears the selection', () => {
    const items = [1, 2, 3, 4].map((n) => item({ id: `e${n}` }))
    renderWithMockStore(<AttentionStrip />, { bootstrap: boot(items) })
    const sid = Object.keys(useOcc.getState().sessions)[0]
    act(() => useOcc.getState().selectSession(sid))
    fireEvent.click(screen.getByTestId('attention-more'))
    expect(useOcc.getState().ui.selectedSessionId).toBeNull()
  })

  it('Open selects the session', () => {
    const sid = Object.keys(mockBootstrap().sessions.reduce((m, s) => ({ ...m, [s.id]: 1 }), {}))[0]
    renderWithMockStore(<AttentionStrip />, { bootstrap: boot([item({ id: 'p', kind: 'permission', severity: 'high', sessionId: sid, title: 'Perm' })]) })
    fireEvent.click(screen.getByRole('button', { name: 'Open Perm' }))
    expect(useOcc.getState().ui.selectedSessionId).toBe(sid)
  })

  it('Open selects run + task for orchestration items', () => {
    renderWithMockStore(<AttentionStrip />, { bootstrap: boot([item({ id: 'g', kind: 'gate', severity: 'high', runId: 'run_board_01', taskId: 't4', title: 'Gate' })]) })
    fireEvent.click(screen.getByRole('button', { name: 'Open Gate' }))
    const ui = useOcc.getState().ui
    expect(ui.selectedRunId).toBe('run_board_01')
    expect(ui.selectedTaskId).toBe('t4')
  })
})

describe('AttentionPanel', () => {
  it('shows the empty state', () => {
    renderWithMockStore(<AttentionPanel />, { bootstrap: boot([]) })
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy()
    expect(screen.getByText('NEEDS YOU')).toBeTruthy()
    expect(screen.getByText('LIVE NOW')).toBeTruthy()
  })

  it('groups by severity and lists working sessions', () => {
    renderWithMockStore(<AttentionPanel />, { bootstrap: boot([item({ id: 'a', severity: 'high' }), item({ id: 'b', severity: 'low' })]) })
    expect(screen.getByTestId('attention-group-high')).toBeTruthy()
    expect(screen.getByTestId('attention-group-low')).toBeTruthy()
    expect(screen.queryByTestId('attention-group-medium')).toBeNull()
    const working = Object.values(useOcc.getState().sessions).filter((s) => s.state === 'working').length
    expect(screen.queryAllByTestId('live-row')).toHaveLength(working)
  })

  it('clicking a live row selects the session', () => {
    renderWithMockStore(<AttentionPanel />, { bootstrap: boot([]) })
    const rows = screen.queryAllByTestId('live-row')
    if (!rows.length) return
    fireEvent.click(rows[0])
    expect(useOcc.getState().ui.selectedSessionId).not.toBeNull()
  })
})
