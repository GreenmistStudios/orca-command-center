import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockBackend, MOCK_IDS } from '../api/mock'
import { useOcc } from '../state/store'
import { mockBootstrap, renderWithMockStore, TEST_NOW } from '../../../test/client/render'

const backend = vi.hoisted(() => ({ current: null as null | { get: (r: string, o?: unknown) => Promise<unknown> } }))
vi.mock('../api/client', () => ({
  api: { get: (r: string, o?: unknown) => backend.current!.get(r, o) },
  ApiRequestError: class extends Error {},
}))

import { Inspector } from './Inspector'

beforeAll(() => {
  backend.current = createMockBackend({ now: TEST_NOW, live: false }) as never
})
afterEach(cleanup)

const open = (ui: Parameters<typeof renderWithMockStore>[1] = {}) =>
  renderWithMockStore(<div className="h-[600px]"><Inspector /></div>, { bootstrap: mockBootstrap({ now: TEST_NOW }), ...ui })

describe('Inspector – session', () => {
  it('renders header chips, provenance tooltip content and switches tabs', async () => {
    open({ uiState: { selectedSessionId: MOCK_IDS.rootBuild } })
    expect(screen.getByTestId('inspector-header')).toBeTruthy()
    expect(screen.getByLabelText('Copy session id')).toBeTruthy()
    expect(screen.getByTestId('harness-tile').textContent).toBe('OC')
    const { provenanceText } = await import('./SessionInspector')
    const s = useOcc.getState().sessions[MOCK_IDS.rootBuild]
    expect(provenanceText(s, TEST_NOW)).toMatch(/^from (Orca hook|transcript)/)
    await waitFor(() => expect(useOcc.getState().details[MOCK_IDS.rootBuild]?.status).toBe('ready'))
    fireEvent.click(screen.getByRole('radio', { name: /Info/ }))
    expect(screen.getByTestId('info-tab')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Todos/ }))
    await waitFor(() => expect(screen.getByTestId('todos')).toBeTruthy())
    fireEvent.click(screen.getByRole('radio', { name: /Files/ }))
    await waitFor(() => expect(screen.getByTestId('file-groups')).toBeTruthy())
  })

  it('renders every transcript item kind, steps toggle, tool expand, diff and subagent select', async () => {
    open({ uiState: { selectedSessionId: MOCK_IDS.rootBuild } })
    fireEvent.click(screen.getByRole('radio', { name: /Activity/ })) // tab memory persists across sessions of a kind
    await waitFor(() => expect(screen.getByTestId('transcript')).toBeTruthy())
    const tr = useOcc.getState().transcripts[MOCK_IDS.rootBuild].data!
    const kinds = new Set(tr.messages.flatMap((m) => m.items.map((i) => i.kind)))
    for (const k of ['prompt', 'text', 'thinking', 'tool', 'mcp', 'file-change', 'subagent', 'todo'] as const) {
      if (kinds.has(k)) expect(screen.getAllByTestId(`item-${k}`).length).toBeGreaterThan(0)
    }
    // steps hidden by default
    expect(screen.queryAllByTestId('item-step').length).toBe(0)
    if (kinds.has('step')) {
      fireEvent.click(screen.getByLabelText('Show steps'))
      expect(screen.getAllByTestId('item-step').length).toBeGreaterThan(0)
    }
    // tool expand fetches detail
    const card = screen.getAllByTestId('item-mcp')[0]
    fireEvent.click(card.querySelector('button')!)
    const ref = tr.messages.flatMap((m) => m.items).find((i) => i.kind === 'mcp')!.detailRef!
    await waitFor(() => expect(useOcc.getState().parts[ref]?.status).toBe('ready'))
    expect(card.querySelector('pre')).toBeTruthy()
    // diff
    const fc = screen.getAllByTestId('item-file-change')[0]
    fireEvent.click(fc.querySelector('button')!)
    await waitFor(() => expect(fc.querySelector('[data-testid="diff-view"],[data-testid="diff-empty"]')).toBeTruthy())
    // subagent
    const sub = screen.getAllByTestId('item-subagent').find((b) => !(b as HTMLButtonElement).disabled)!
    await act(async () => { fireEvent.click(sub) })
    expect(useOcc.getState().ui.selectedSessionId).not.toBe(MOCK_IDS.rootBuild)
  })

  it('shows session not found for unknown ids', async () => {
    open()
    act(() => useOcc.getState().selectSession('ses_nope'))
    await waitFor(() => expect(screen.getByText('Session not found')).toBeTruthy())
  })
})

describe('Inspector – task', () => {
  it('renders task sections', async () => {
    open({ uiState: { selectedRunId: MOCK_IDS.runBoard, selectedTaskId: 't6' } })
    await waitFor(() => expect(screen.getByTestId('task-inspector')).toBeTruthy())
    for (const t of ['Spec', 'Result', /Dispatch attempts/, /Messages/, /Gates/, 'Depends on', 'Blocks']) expect(screen.getByText(t)).toBeTruthy()
    expect(screen.getByTestId('dispatch-timeline')).toBeTruthy()
  })
})
