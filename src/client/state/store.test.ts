import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockBootstrap } from '../../../test/client/render'
import { createMockBackend, MOCK_IDS, resetMockBackend } from '../api/mock'
import type { ActivityEvent, SessionSummary } from '../../shared/contract'
import { ACTIVITY_RING_MAX, resetOccStore, useOcc } from './store'

const st = () => useOcc.getState()

function ev(id: string, ts: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id, rev: ts, harness: 'opencode', sessionId: MOCK_IDS.coderViewModel, rootId: MOCK_IDS.rootBuild, messageId: null, ts, endTs: null, kind: 'tool', status: 'completed', title: id,
    summary: null, tool: null, files: [], childSessionId: null, usage: null, links: [], source: 't', detailRef: null, ...over,
  }
}

describe('store', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/?mock=1')
    resetMockBackend()
    resetOccStore()
    st().applyBootstrap(mockBootstrap())
  })

  it('selects the default root after bootstrap (most urgent live root)', () => {
    expect(st().ui.selectedRootId).toBe(MOCK_IDS.blocked)
    expect(st().ui.selectedSessionId).toBe(MOCK_IDS.blocked)
    expect(st().bootstrapped).toBe(true)
  })

  it('selecting a child sets the root and clears run/task', () => {
    st().selectRun('run_board_01')
    st().selectSession(MOCK_IDS.coderTests, { activityId: 'x' })
    expect(st().ui.selectedRootId).toBe(MOCK_IDS.rootBuild)
    expect(st().ui.selectedRunId).toBeNull()
    expect(st().ui.selectedActivityId).toBe('x')
  })

  it('adjacent root / cast navigation wraps', () => {
    st().selectRoot(MOCK_IDS.idle)
    st().selectAdjacentRoot(1)
    expect(st().ui.selectedRootId).toBe(MOCK_IDS.blocked)
    st().selectRoot(MOCK_IDS.rootBuild)
    st().selectAdjacentCast(1)
    expect(st().sessions[st().ui.selectedSessionId!].parentId).toBe(MOCK_IDS.rootBuild)
    expect(st().ui.selectedRootId).toBe(MOCK_IDS.rootBuild)
  })

  it('upserts activity by rev and keeps ts order', () => {
    const base = st().activity.order.length
    const t = Date.now() + 10_000
    st().applyStreamEvent({ type: 'activity', seq: 5000, events: [ev('a1', t + 20), ev('a2', t + 10)] })
    expect(st().activity.order.slice(-2)).toEqual(['a2', 'a1'])
    expect(st().activity.order).toHaveLength(base + 2)
    const v = st().activity.version
    st().applyStreamEvent({ type: 'activity', seq: 5001, events: [ev('a1', t + 20, { rev: 1, title: 'stale' })] })
    expect(st().activity.byId.a1.title).toBe('a1') // lower rev ignored
    st().applyStreamEvent({ type: 'activity', seq: 5002, events: [ev('a1', t + 20, { rev: t + 99, title: 'newer' })] })
    expect(st().activity.byId.a1.title).toBe('newer')
    expect(st().activity.version).toBeGreaterThan(v)
    expect(st().activity.order.filter((x) => x === 'a1')).toHaveLength(1)
  })

  it('ignores replayed frames with seq <= current', () => {
    const seq = st().seq
    st().applyStreamEvent({ type: 'activity', seq, events: [ev('old', 1)] })
    expect(st().activity.byId.old).toBeUndefined()
  })

  it('caps the ring at 20k, dropping the oldest', () => {
    const base = Date.now()
    const events = Array.from({ length: ACTIVITY_RING_MAX + 50 }, (_, i) => ev(`bulk${i}`, base + i))
    st().applyStreamEvent({ type: 'activity', seq: 6000, events })
    expect(st().activity.order).toHaveLength(ACTIVITY_RING_MAX)
    expect(st().activity.byId.bulk0).toBeUndefined()
    expect(st().activity.byId[`bulk${ACTIVITY_RING_MAX + 49}`]).toBeDefined()
    expect(Object.keys(st().activity.byId)).toHaveLength(ACTIVITY_RING_MAX)
  })

  it('adds new child sessions and an edge to a loaded tree', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const backend = createMockBackend({ live: false })
    const tree = await backend.get('GET /api/sessions/:id/tree', { path: { id: MOCK_IDS.rootBuild } })
    useOcc.setState({ trees: { [MOCK_IDS.rootBuild]: { status: 'ready', data: tree, error: null, fetchedAt: 1 } } })
    const parent = st().sessions[MOCK_IDS.rootBuild]
    const child: SessionSummary = { ...st().sessions[MOCK_IDS.exploreUsages], id: 'ses_new', parentId: parent.id, title: 'New child', spawn: { ...st().sessions[MOCK_IDS.exploreUsages].spawn!, description: 'Do the thing' } }
    st().applyStreamEvent({ type: 'sessions', seq: 7000, sessions: [child], removed: [] })
    const data = st().trees[MOCK_IDS.rootBuild].data!
    expect(data.nodes.some((n) => n.id === 'ses_new')).toBe(true)
    expect(data.edges.find((e) => e.to === 'ses_new')).toMatchObject({ from: parent.id, label: 'Do the thing' })
    expect(st().sessions.ses_new.title).toBe('New child')
    st().applyStreamEvent({ type: 'sessions', seq: 7001, sessions: [], removed: ['ses_new'] })
    expect(st().sessions.ses_new).toBeUndefined()
    expect(st().trees[MOCK_IDS.rootBuild].data!.edges.some((e) => e.to === 'ses_new')).toBe(false)
  })

  it('merges live events into a loaded transcript (existing and new messages)', async () => {
    await st().fetchTranscript(MOCK_IDS.rootBuild)
    const page = st().transcripts[MOCK_IDS.rootBuild].data!
    expect(page.messages.length).toBeGreaterThan(0)
    const msg = page.messages[page.messages.length - 1]
    const t = Date.now() + 1000
    st().applyStreamEvent({ type: 'activity', seq: 8000, events: [ev('tr1', t, { sessionId: MOCK_IDS.rootBuild, messageId: msg.id }), ev('tr2', t + 1, { sessionId: MOCK_IDS.rootBuild, messageId: 'msg_unknown', kind: 'text' })] })
    const after = st().transcripts[MOCK_IDS.rootBuild].data!
    expect(after.messages.find((m) => m.id === msg.id)!.items.some((i) => i.id === 'tr1')).toBe(true)
    const placeholder = after.messages[after.messages.length - 1]
    expect(placeholder.id).toBe('msg_unknown')
    expect(placeholder.items[0].id).toBe('tr2')
  })

  it('merges into loaded scoped activity', async () => {
    await st().fetchScopedActivity({ rootId: MOCK_IDS.rootBuild })
    const t = Date.now() + 5000
    st().applyStreamEvent({ type: 'activity', seq: 9000, events: [ev('sc1', t, { rootId: MOCK_IDS.rootBuild })] })
    expect(st().scopedActivity[`root:${MOCK_IDS.rootBuild}`].data!.events.some((e) => e.id === 'sc1')).toBe(true)
  })

  it('replaces attention/stats/meta and shallow-merges orca', () => {
    st().applyStreamEvent({ type: 'attention', seq: 9100, items: [] })
    expect(st().attention).toEqual([])
    const wt = st().orca!.worktrees
    st().applyStreamEvent({ type: 'orca', seq: 9101, orca: { terminals: [] } })
    expect(st().orca!.terminals).toEqual([])
    expect(st().orca!.worktrees).toBe(wt)
    expect(st().seq).toBe(9101)
    expect(st().lastEventAt).not.toBeNull()
  })

  it('dedupes in-flight fetches and keeps stale data on error', async () => {
    await Promise.all([st().fetchRun('run_board_01'), st().fetchRun('run_board_01')])
    expect(st().runs.run_board_01.status).toBe('ready')
    await st().fetchRun('nope')
    expect(st().runs.nope.status).toBe('error')
    expect(st().runs.nope.error).toMatch(/not found/)
  })

  it('fetches older transcript pages and merges', async () => {
    await st().fetchTranscript(MOCK_IDS.rootBuild)
    const n = st().transcripts[MOCK_IDS.rootBuild].data!.messages.length
    await st().fetchTranscript(MOCK_IDS.rootBuild, { older: true }) // no more → no-op
    expect(st().transcripts[MOCK_IDS.rootBuild].data!.messages.length).toBe(n)
  })

  it('toggles theme, clamps dock width, persists', () => {
    st().toggleTheme()
    expect(st().ui.theme).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(JSON.parse(localStorage.getItem('occ-theme')!)).toBe('light')
    st().setDockWidth(9999)
    expect(st().ui.dockWidth).toBe(640)
    st().setDockWidth(10)
    expect(st().ui.dockWidth).toBe(320)
    st().toggleWorkspaceCollapsed('k')
    expect(st().ui.collapsedWorkspaces.k).toBe(true)
  })
})
