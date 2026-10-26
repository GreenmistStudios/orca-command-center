import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError, api, buildUrl } from './client'
import { createMockBackend, MOCK_IDS } from './mock'
import { connectStream } from './sse'
import { FakeEventSource } from '../../../test/client/setup'
import type { StreamEvent } from '../../shared/contract'

afterEach(() => { vi.restoreAllMocks(); history.replaceState(null, '', '/'); FakeEventSource.instances.length = 0 })

describe('buildUrl', () => {
  it('encodes path ids and drops undefined params', () => {
    expect(buildUrl('GET /api/sessions/:id/tree', { path: { id: 'a/b c' } })).toBe('/api/sessions/a%2Fb%20c/tree')
    expect(buildUrl('GET /api/activity', { params: { rootId: 'r', before: undefined, limit: 5 } })).toBe('/api/activity?rootId=r&limit=5')
  })
})

describe('api.get', () => {
  it('throws ApiRequestError with code/message on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'nope', code: 'not_found' }), { status: 404 })))
    await expect(api.get('GET /api/sessions/:id', { path: { id: 'x' } })).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'nope' })
    await expect(api.get('GET /api/sessions/:id', { path: { id: 'x' } })).rejects.toBeInstanceOf(ApiRequestError)
    vi.unstubAllGlobals()
  })
})

describe('connectStream', () => {
  it('maps open/error to connection states and ignores malformed frames', () => {
    const states: string[] = []
    const events: StreamEvent[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = connectStream({ since: 5, onEvent: (e) => events.push(e), onState: (s) => states.push(s) })
    const es = FakeEventSource.instances[0]
    expect(es.url).toBe('/api/stream?since=5')
    es.onopen?.(new Event('open'))
    es.readyState = 0
    es.onerror?.(new Event('error'))
    es.onmessage?.({ data: 'not json' } as MessageEvent<string>)
    es.onmessage?.({ data: JSON.stringify({ type: 'stats', seq: 6 }) } as MessageEvent<string>)
    expect(states).toEqual(['live', 'reconnecting'])
    expect(events).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    h.close()
    expect(es.readyState).toBe(2)
  })
})

describe('mock backend', () => {
  const b = createMockBackend({ now: 1_800_000_000_000, live: false })

  it('bootstraps a fleet exercising every state', () => {
    const boot = b.bootstrap()
    const states = new Set(boot.sessions.map((s) => s.state))
    for (const s of ['working', 'blocked', 'waiting', 'error', 'done', 'idle']) expect(states.has(s as never)).toBe(true)
    expect(boot.sessions.filter((s) => s.parentId == null)).toHaveLength(6)
    expect(boot.sessions.filter((s) => s.parentId === MOCK_IDS.rootBuild)).toHaveLength(6)
    expect(boot.orca.status.pid).toBe(97499)
    expect(new Set(boot.attention.map((a) => a.kind))).toEqual(new Set(['permission', 'question', 'gate', 'error', 'stalled', 'failed-task']))
    expect(boot.stats.histogram).toHaveLength(60)
    expect(new Set(boot.activity.map((e) => e.kind)).size).toBeGreaterThanOrEqual(10)
    expect(boot.orchestration.runs).toHaveLength(2)
    expect(boot.activity.some((e) => e.links.some((l) => l.includes('/pull/812')))).toBe(true)
    expect(boot.activity.some((e) => e.tool?.name === 'atlassian_jira_get_issue')).toBe(true)
  })

  it('serves every route consistently', async () => {
    const tree = await b.get('GET /api/sessions/:id/tree', { path: { id: MOCK_IDS.coderTests } })
    expect(tree.rootId).toBe(MOCK_IDS.rootBuild)
    expect(tree.nodes).toHaveLength(7)
    expect(tree.edges).toHaveLength(6)
    const detail = await b.get('GET /api/sessions/:id', { path: { id: MOCK_IDS.coderTests } })
    expect(detail.ancestors.map((a) => a.id)).toEqual([MOCK_IDS.rootBuild])
    const tp = await b.get('GET /api/sessions/:id/transcript', { path: { id: MOCK_IDS.rootBuild }, params: { limit: 2 } })
    expect(tp.messages).toHaveLength(2)
    expect(tp.hasMore).toBe(false)
    const fc = await b.get('GET /api/file-changes', { params: { rootId: MOCK_IDS.rootBuild } })
    expect(fc.changes.length).toBeGreaterThan(1)
    const diff = await b.get('GET /api/file-changes/:id/diff', { path: { id: fc.changes[0].id } })
    expect(diff.text).toBeTruthy()
    const ev = (await b.get('GET /api/activity', { params: { sessionId: MOCK_IDS.rootBuild, kinds: 'mcp' } })).events
    expect(ev.length).toBeGreaterThan(0)
    const part = await b.get('GET /api/parts/:id', { path: { id: ev[0].detailRef! } })
    expect(part.kind).toBe('mcp')
    expect((await b.get('GET /api/artifacts', { params: {} })).artifacts.some((a) => a.kind === 'pull-request')).toBe(true)
    const run = await b.get('GET /api/orchestration/runs/:id', { path: { id: MOCK_IDS.runBoard } })
    expect(run.tasks).toHaveLength(6)
    expect(run.gates[0].blocking).toBe(true)
    expect((await b.get('GET /api/orchestration/tasks/:id', { path: { id: 't3' } })).dispatches).toHaveLength(1)
    await expect(b.get('GET /api/sessions/:id', { path: { id: 'zzz' } })).rejects.toMatchObject({ status: 404 })
  })

  it('pages transcripts older', async () => {
    const full = await b.get('GET /api/sessions/:id/transcript', { path: { id: MOCK_IDS.rootBuild }, params: { limit: 1 } })
    expect(full.hasMore).toBe(true)
    const older = await b.get('GET /api/sessions/:id/transcript', { path: { id: MOCK_IDS.rootBuild }, params: { limit: 1, before: full.before! } })
    expect(older.messages[0].id).not.toBe(full.messages[0].id)
  })

  it('emits increasing seq frames on tick', () => {
    const frames: StreamEvent[] = []
    const off = b.connect((e) => frames.push(e))
    b.tick(); b.tick(); b.tickSlow(); b.tickStats()
    off()
    const seqs = frames.filter((f) => f.type !== 'hello').map((f) => f.seq)
    expect(seqs.length).toBeGreaterThanOrEqual(5)
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(frames.some((f) => f.type === 'activity')).toBe(true)
  })
})

describe('connectStream reconnect', () => {
  it('reconnects with backoff after CLOSED, resuming from the last seq, and resets backoff on open', () => {
    vi.useFakeTimers()
    const states: string[] = []
    const h = connectStream({ since: 1, onEvent: () => {}, onState: (s) => states.push(s) })
    FakeEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: 'stats', seq: 9 }) } as MessageEvent<string>)
    const fail = (i: number) => { const es = FakeEventSource.instances[i]; es.readyState = 2; es.onerror?.(new Event('error')) }
    fail(0)
    expect(states).toContain('offline')
    vi.advanceTimersByTime(999); expect(FakeEventSource.instances).toHaveLength(1)
    vi.advanceTimersByTime(1); expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1].url).toBe('/api/stream?since=9')
    fail(1)
    vi.advanceTimersByTime(1999); expect(FakeEventSource.instances).toHaveLength(2)
    vi.advanceTimersByTime(1); expect(FakeEventSource.instances).toHaveLength(3)
    FakeEventSource.instances[2].onopen?.(new Event('open'))
    expect(states.at(-1)).toBe('live')
    fail(2)
    vi.advanceTimersByTime(1000); expect(FakeEventSource.instances).toHaveLength(4)
    h.close()
    fail(3)
    vi.advanceTimersByTime(60_000); expect(FakeEventSource.instances).toHaveLength(4)
    vi.useRealTimers()
  })
})
