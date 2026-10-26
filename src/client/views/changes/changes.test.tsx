import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Artifact, FileChange } from '../../../shared/contract'
import { renderWithMockStore, mockBootstrap, TEST_NOW } from '../../../../test/client/render'
import { useOcc } from '../../state/store'
import { ChangesView } from './ChangesView'
import { createMockBackend } from '../../api/mock'
import { buildTree, flattenRows, groupArtifacts, groupByFile, sortFiles } from './model'

const ch = (id: string, path: string, ts: number, extra: Partial<FileChange> = {}): FileChange => ({
  id, sessionId: 's1', rootId: 'r', harness: 'opencode', ts, path, workspaceRoot: '/w', relPath: path.replace('/w/', ''),
  kind: 'edit', tool: 'edit', status: 'completed', additions: 2, deletions: 1, ...extra,
})

vi.mock('../../api/client', async () => {
  const { createMockBackend: mk } = await import('../../api/mock')
  const b = mk({ now: Date.UTC(2026, 9, 26, 12), live: false })
  return { api: { get: (r: string, o: unknown) => (b.get as (r: string, o: unknown) => Promise<unknown>)(r, o) }, ApiRequestError: class extends Error {} }
})
void createMockBackend

describe('model', () => {
  const list = [ch('1', '/w/src/client/ui/a.ts', 1), ch('2', '/w/src/client/ui/a.ts', 5), ch('3', '/w/README.md', 3)]
  it('aggregates, orders and totals', () => {
    const f = groupByFile(list)
    const a = f.find((x) => x.name === 'a.ts')!
    expect(a.changes.map((c) => c.id)).toEqual(['2', '1'])
    expect(a.additions).toBe(4)
    expect(sortFiles(f, 'changed')[0].name).toBe('a.ts')
    expect(sortFiles(f, 'recent').map((x) => x.name)).toEqual(['a.ts', 'README.md'])
  })
  it('groups by root and compacts single-child dirs', () => {
    const g = buildTree(groupByFile(list))
    expect(g).toHaveLength(1)
    expect(g[0].name).toBe('w')
    const rows = flattenRows(g, new Set())
    expect(rows.some((r) => r.type === 'dir' && r.name === 'src/client/ui')).toBe(true)
  })
  it('groups artifacts by kind', () => {
    const a = (id: string, kind: Artifact['kind']): Artifact => ({ id, kind, label: id, path: null, url: null, sessionId: 's1', rootId: 'r', ts: 1, source: '' })
    expect(groupArtifacts([a('1', 'document'), a('2', 'pull-request')]).map((x) => x.kind)).toEqual(['pull-request', 'document'])
  })
})

describe('ChangesView', () => {
  it('fetches the right keys on scope switch, shows files, PR and docs', async () => {
    renderWithMockStore(<ChangesView />, { bootstrap: mockBootstrap({ now: TEST_NOW }) })
    const root = useOcc.getState().ui.selectedRootId
    await waitFor(() => expect(useOcc.getState().fileChanges[root ? `root:${root}` : 'all']?.status).toBe('ready'))
    fireEvent.click(screen.getByRole('radio', { name: /All agents/ }))
    await waitFor(() => expect(useOcc.getState().fileChanges.all?.status).toBe('ready'))
    await waitFor(() => expect(screen.getAllByTestId('file-row').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('radio', { name: /Artifacts/ }))
    await waitFor(() => expect(screen.getAllByTestId('artifact-card').length).toBeGreaterThan(0))
    expect(screen.getByText('Pull requests')).toBeTruthy()
    const links = document.querySelectorAll('a[target="_blank"]')
    links.forEach((l) => expect(l.getAttribute('rel')).toBe('noreferrer'))
  })
  it('expanding a change triggers fetchDiff', async () => {
    renderWithMockStore(<ChangesView />, { bootstrap: mockBootstrap({ now: TEST_NOW }) })
    fireEvent.click(screen.getByRole('radio', { name: /All agents/ }))
    await waitFor(() => expect(screen.getAllByTestId('file-row').length).toBeGreaterThan(0))
    const spy = vi.spyOn(useOcc.getState(), 'fetchDiff')
    fireEvent.click(screen.getAllByTestId('file-row')[0])
    await waitFor(() => expect(screen.getAllByTestId('change-item').length).toBeGreaterThan(0))
    await waitFor(() => expect(Object.keys(useOcc.getState().diffs).length).toBeGreaterThan(0))
    spy.mockRestore()
  })
})
