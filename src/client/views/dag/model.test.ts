import { describe, expect, it } from 'vitest'
import type { OrchTask } from '../../../shared/contract'
import { edgeStyle, hasCycle, isolatedGrid, runCaption, structureKey, treeCaption } from './model'

const task = (id: string, deps: string[] = []): OrchTask => ({ id, deps } as OrchTask)

describe('dag model', () => {
  it('structure key ignores order and changes with direction/edges', () => {
    const a = { nodes: [{ id: 'a', type: 'task' as const, w: 1, h: 1 }, { id: 'b', type: 'task' as const, w: 1, h: 1 }], edges: [{ id: 'e', source: 'a', target: 'b', label: null }] }
    const b = { nodes: [...a.nodes].reverse(), edges: a.edges }
    expect(structureKey(a, 'DOWN')).toBe(structureKey(b, 'DOWN'))
    expect(structureKey(a, 'DOWN')).not.toBe(structureKey(a, 'RIGHT'))
    expect(structureKey(a, 'DOWN')).not.toBe(structureKey({ ...a, edges: [] }, 'DOWN'))
  })
  it('isolated grid uses 120px gap, 4+ cols, 24px gutters', () => {
    const g = isolatedGrid(10, 300)
    expect(g[0]).toEqual({ x: 0, y: 420 })
    expect(g[1].x).toBe(264)
    expect(g[5].y).toBe(420 + 84 + 24) // cols = max(4, ceil(sqrt(20))) = 5
  })
  it('captions', () => {
    expect(runCaption([task('a'), task('b'), task('c')], 0)).toBe('No dependencies in this run — 3 tasks dispatched independently.')
    expect(runCaption([task('a'), task('b', ['a'])], 1)).toBe('2 tasks · 1 dependency')
    expect(runCaption([task('a', ['b']), task('b', ['a'])], 2)).toContain('cycle')
    expect(treeCaption('T', [{ state: 'working' }] as never)).toBe('No subagents yet.')
    expect(treeCaption('T', [{ state: 'done' }, { state: 'working' }] as never)).toBe('T · 1 agent · 1 working')
    expect(hasCycle([task('a'), task('b', ['a'])])).toBe(false)
  })
  it('edge styling by target state', () => {
    expect(edgeStyle('working')).toMatchObject({ animated: true, strokeWidth: 2, stroke: '#f59e0b' })
    expect(edgeStyle('error').stroke).toBe('var(--status-failed)')
    expect(edgeStyle('done').animated).toBe(false)
  })
})
