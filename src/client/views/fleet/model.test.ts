import { describe, expect, it } from 'vitest'
import type { AgentState, AttentionItem, OrchRun, SessionSummary, WorktreeInfo } from '../../../shared/contract'
import { buildFleetGraph, rollupState, type FleetInput, type FleetOptions } from './model'

const NOW = 1_000_000
const WIN = 10_000

function sess(id: string, o: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, harness: 'opencode', parentId: null, rootId: id, depth: 0, title: id, agent: null, model: null, directory: null,
    workspace: { key: 'k1', name: 'ws', path: '/a', repo: 'repo', branch: 'main' },
    createdAt: 0, updatedAt: 0, lastActivityAt: null, archivedAt: null, state: 'idle', stateSource: 'transcript', stateSince: null,
    live: false, current: null, lastPrompt: null, lastMessage: null, counters: null,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    childIds: [], descendantCount: 0, spawn: null, orca: null, facts: [], ...o,
  } as unknown as SessionSummary
}
const wt = (id: string, o: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  id, repoId: null, repo: 'repo', path: `/wt/${id}`, branch: id, displayName: null, status: null, workspaceStatus: null,
  isActive: false, isMainWorktree: false, liveTerminalCount: 2, lastActivityAt: null, lastOutputAt: null, links: [], ...o,
} as WorktreeInfo)
const run = (id: string, o: Partial<OrchRun> = {}): OrchRun => ({
  id, objective: id, coordinatorHandle: null, coordinatorSessionId: null, legacy: false, createdAt: null, updatedAt: null,
  lastActivityAt: NOW, taskCount: 1, statusCounts: { done: 1 }, dispatchCount: 0, messageCount: 0, hasBlockingGate: false, ...o,
})
const link = (o: object) => ({ paneKey: null, tabId: null, terminalHandle: null, terminalTitle: null, worktreeId: null, hookEvent: null, hookState: null, hookAt: null, runId: null, taskId: null, dispatchId: null, role: null, ...o }) as SessionSummary['orca']
const attn = (o: Partial<AttentionItem>): AttentionItem => ({ id: 'a', kind: 'permission', severity: 'high', sessionId: null, runId: null, taskId: null, title: '', detail: null, since: 0, source: '', ...o })

function run1(sessions: SessionSummary[], o: { wts?: WorktreeInfo[]; runs?: OrchRun[]; attention?: AttentionItem[] } = {}, opts: Partial<FleetOptions> = {}) {
  const input: FleetInput = { sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), worktrees: o.wts ?? [], runs: o.runs ?? [], attention: o.attention ?? [], now: NOW, windowMs: WIN }
  return buildFleetGraph(input, { scope: 'all', harness: null, collapsed: new Set(), ...opts })
}
const ids = (g: { nodes: { id: string }[] }) => g.nodes.map((n) => n.id).sort()
const hasEdge = (g: { edges: { id: string }[] }, id: string) => g.edges.some((e) => e.id === id)

describe('grouping', () => {
  it('joins by worktreeId, then path, then synthetic', () => {
    const g = run1(
      [sess('a', { orca: link({ worktreeId: 'W1' }) }), sess('b', { workspace: { key: 'x', name: 'n', path: '/wt/W2', repo: 'repo', branch: null } }), sess('c', { workspace: { key: 'syn', name: 'synname', path: null, repo: null, branch: null } })],
      { wts: [wt('W1'), wt('W2')] },
    )
    expect(hasEdge(g, 'w:W1>s:a')).toBe(true)
    expect(hasEdge(g, 'w:W2>s:b')).toBe(true)
    expect(hasEdge(g, 'w:syn>s:c')).toBe(true)
    expect(hasEdge(g, 'p:synname>w:syn')).toBe(true)
    expect(hasEdge(g, 'p:repo>w:W1')).toBe(true)
  })
  it('null workspace is Unattached; only roots appear', () => {
    const g = run1([sess('a', { workspace: null, childIds: ['c'] }), sess('c', { parentId: 'a', rootId: 'a', depth: 1, workspace: null })])
    expect(ids(g)).toEqual(['p:Unattached', 's:a', 'w:unattached'])
  })
})

describe('runs', () => {
  it('attaches via coordinator, with coordinates edge', () => {
    const g = run1([sess('co', { orca: link({ worktreeId: 'W1' }) })], { wts: [wt('W1')], runs: [run('R', { coordinatorSessionId: 'co' })] })
    expect(hasEdge(g, 'w:W1>r:R')).toBe(true)
    expect(g.edges.find((e) => e.id === 'r:R>s:co')?.label).toBe('coordinates')
  })
  it('attaches via session orca.runId', () => {
    const g = run1([sess('x', { orca: link({ worktreeId: 'W2', runId: 'R' }) })], { wts: [wt('W2')], runs: [run('R', { coordinatorSessionId: 'missing' })] })
    expect(hasEdge(g, 'w:W2>r:R')).toBe(true)
    expect(g.edges.some((e) => e.label === 'coordinates')).toBe(false)
  })
  it('falls back to Unattached', () => {
    const g = run1([], { runs: [run('R')] })
    expect(hasEdge(g, 'p:Unattached>w:unattached')).toBe(true)
    expect(hasEdge(g, 'w:unattached>r:R')).toBe(true)
  })
})

describe('scope', () => {
  const sessions = [
    sess('live', { live: true }),
    sess('recent', { lastActivityAt: NOW - 1 }),
    sess('old', { lastActivityAt: NOW - WIN - 1 }),
    sess('att', { lastActivityAt: 0 }),
    sess('lone', { workspace: { key: 'z', name: 'z', path: null, repo: 'zz', branch: null } }),
  ]
  it('active prunes', () => {
    const g = run1(sessions, { attention: [attn({ sessionId: 'att' })], wts: [wt('E')] }, { scope: 'active' })
    expect(ids(g).filter((i) => i.startsWith('s:'))).toEqual(['s:att', 's:live', 's:recent'])
    expect(ids(g).some((i) => i === 'w:E' || i === 'p:zz')).toBe(false)
  })
  it('all keeps everything', () => {
    const g = run1(sessions, { wts: [wt('E')] })
    expect(ids(g).filter((i) => i.startsWith('s:')).length).toBe(5)
    expect(ids(g)).toContain('w:E')
  })
  it('active keeps runs by window, gate, or open tasks', () => {
    const old = { lastActivityAt: 0, statusCounts: { done: 2, failed: 1 } }
    const g = run1([], { runs: [run('stale', old), run('gate', { ...old, hasBlockingGate: true }), run('open', { ...old, statusCounts: { ready: 1 } }), run('fresh', { ...old, lastActivityAt: NOW })] }, { scope: 'active' })
    expect(ids(g).filter((i) => i.startsWith('r:'))).toEqual(['r:fresh', 'r:gate', 'r:open'])
  })
})

describe('filters and collapse', () => {
  it('harness filter applies to sessions', () => {
    const g = run1([sess('a', { harness: 'copilot' }), sess('b')], {}, { harness: 'copilot' })
    expect(ids(g).filter((i) => i.startsWith('s:'))).toEqual(['s:a'])
  })
  it('collapse keeps node and counts', () => {
    const ss = [sess('a', { live: true, state: 'working' }), sess('b', { state: 'error' })]
    const g = run1(ss, {}, { collapsed: new Set(['p:repo']) })
    expect(ids(g)).toEqual(['p:repo'])
    const d = g.data['p:repo']!
    expect(d.kind === 'project' && d.counts).toEqual({ live: 1, working: 1, needsYou: 0, idle: 1, error: 1 })
    const g2 = run1(ss, {}, { collapsed: new Set(['w:k1']) })
    expect(ids(g2)).toEqual(['p:repo', 'w:k1'])
    const w = g2.data['w:k1']!
    expect(w.kind === 'worktree' && w.counts.live).toBe(1)
  })
})

describe('overflow', () => {
  it('replaces idle sessions with one overflow node', () => {
    const ss = [sess('l', { live: true }), ...['a', 'b', 'c', 'd'].map((i) => sess(i))]
    const g = run1(ss, {}, { maxNodes: 4 })
    expect(ids(g)).toEqual(['o:k1', 'p:repo', 's:l', 'w:k1'])
    const o = g.data['o:k1']!
    expect(o.kind === 'overflow' && o.hidden).toBe(4)
    expect(run1(ss, {}, { maxNodes: 50 }).nodes.length).toBe(7)
  })
})

describe('rollup and attention', () => {
  it('rollupState uses priority', () => {
    expect(rollupState([])).toBe('idle')
    const s: AgentState[] = ['idle', 'working', 'error']
    expect(rollupState(s)).toBe('working')
    expect(rollupState([...s, 'blocked'])).toBe('blocked')
  })
  it('needsYou from state, attention in subtree, run gate', () => {
    const g = run1(
      [sess('w', { state: 'waiting' }), sess('p', { childIds: ['c'] }), sess('c', { parentId: 'p', rootId: 'p', depth: 1, state: 'working' }), sess('q')],
      { attention: [attn({ sessionId: 'c' }), attn({ id: 'b', runId: 'R' })], runs: [run('R')] },
    )
    const n = (id: string) => g.data[id]!
    expect(n('s:w').kind === 'session' && (n('s:w') as { needsYou: boolean }).needsYou).toBe(true)
    expect((n('s:p') as { needsYou: boolean }).needsYou).toBe(true)
    expect((n('s:p') as { workingDescendants: number }).workingDescendants).toBe(1)
    expect((n('s:q') as { needsYou: boolean }).needsYou).toBe(false)
    expect((n('r:R') as { needsYou: boolean }).needsYou).toBe(true)
    expect((n('p:repo') as { state: AgentState }).state).toBe('waiting')
  })
})

describe('determinism', () => {
  it('same output regardless of input order, sorted', () => {
    const a = [sess('a', { state: 'working', lastActivityAt: 5 }), sess('b', { state: 'blocked' }), sess('c', { state: 'working', lastActivityAt: 9 })]
    const g1 = run1(a)
    const g2 = run1([...a].reverse())
    expect(g1.nodes.map((n) => n.id)).toEqual(g2.nodes.map((n) => n.id))
    expect(g1.nodes.filter((n) => n.type === 'session').map((n) => n.id)).toEqual(['s:b', 's:c', 's:a'])
  })
})
