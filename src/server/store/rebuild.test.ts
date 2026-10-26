import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessSession, HarnessSource, HarnessUpdate } from '../types.js'
import type { StreamPayload } from '../../shared/contract.js'

const state = vi.hoisted(() => ({ sessions: [] as HarnessSession[], lookups: 0, listener: null as null | ((u: HarnessUpdate) => void) }))

vi.mock('./sources.js', () => {
  const src = {
    id: 'opencode',
    harness: 'opencode',
    async start() {},
    async stop() {},
    health: () => ({ id: 'opencode', label: 'x', status: 'ok', path: null, version: null, detail: null, lastReadAt: null, lastChangeAt: null }),
    subscribe(l: (u: HarnessUpdate) => void) {
      state.listener = l
      return () => {}
    },
    listSessions: () => state.sessions,
    getSession: (id: string) => {
      state.lookups++
      return state.sessions.find((s) => s.id === id) ?? null
    },
    getChildren: () => [],
    getCounters: () => ({ messages: 0, toolCalls: 0, errors: 0, filesTouched: 0 }),
    getToolStats: () => [],
    getTodos: () => [],
    getTranscript: () => ({ items: [], before: null }),
    getActivity: () => ({ events: [], before: null }),
    recentActivity: () => [],
    getPart: () => null,
    getDiff: () => null,
    getFileChanges: () => [],
  } as unknown as HarnessSource
  return {
    buildSources: () => ({ harnesses: [src], cli: null, hooks: null, orch: null, all: [src], disabled: [] }),
    allHealth: () => [src.health()],
  }
})

const { createStore } = await import('./store.js')
const { benchConfig } = await import('../sources/opencode/bench-config.js')

const NOW = 1_800_000_000_000
const mk = (id: string, parentId: string | null, updatedAt = NOW - 1000): HarnessSession => ({
  id,
  harness: 'opencode',
  parentId,
  title: id,
  agent: null,
  model: null,
  directory: '/tmp/x',
  createdAt: NOW - 10_000,
  updatedAt,
  lastActivityAt: updatedAt,
  archivedAt: null,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } as never,
  cost: 0,
  spawn: null,
  transcriptState: 'done',
  current: null,
  lastPrompt: null,
  lastMessage: null,
  processAlive: null,
  facts: [],
})

function build(clock: { t: number }) {
  const published: StreamPayload[] = []
  const hub = { publish: (p: StreamPayload) => void published.push(p), seq: 0, bootId: 'b' }
  const config = { ...benchConfig('/nonexistent.db', {}), windowMs: 3_600_000 }
  const store = createStore({ config, log: { debug() {}, info() {}, warn() {}, error() {} }, now: () => clock.t, hub, version: 't' })
  return { store, published }
}

afterEach(() => {
  vi.useRealTimers()
  state.sessions = []
  state.lookups = 0
})

describe('rebuild performance and publishing', () => {
  it('full rebuild of ~700 sessions with a 300-descendant root is fast', async () => {
    const list = [mk('root', null)]
    for (let i = 0; i < 300; i++) list.push(mk(`d${i}`, i < 20 ? 'root' : `d${i % 20}`))
    for (let i = 0; i < 400; i++) list.push(mk(`r${i}`, null))
    state.sessions = list
    const clock = { t: NOW }
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { store } = build(clock)
    await store.start()
    expect(store.bootstrap().sessions.find((s) => s.id === 'root')!.descendantCount).toBe(300)
    const t0 = performance.now()
    vi.advanceTimersByTime(15_000) // one clock tick = full rebuild of every session
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(200)
    await store.stop()
  })

  it('clock tick evicts stale sessions and unlinks them from the parent', async () => {
    const clock = { t: NOW }
    state.sessions = [mk('p', null, NOW - 100), mk('c', 'p', NOW - 100)]
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { store, published } = build(clock)
    await store.start()
    expect(store.bootstrap().sessions.find((s) => s.id === 'p')!.childIds).toEqual(['c'])
    // child ages out of the window, parent stays fresh via update
    clock.t = NOW + 7_200_000
    state.listener!({ type: 'sessions', sessions: [mk('p', null, clock.t)] })
    published.length = 0
    vi.advanceTimersByTime(31_000) // first tick refreshes liveness, second evicts
    const p = store.bootstrap().sessions.find((s) => s.id === 'p')!
    expect(p.childIds).toEqual([])
    expect(p.descendantCount).toBe(0)
    await store.stop()
  })

  it('publishes only changed sessions on rebuild', async () => {
    const clock = { t: NOW }
    state.sessions = [mk('a', null), mk('b', null)]
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { store, published } = build(clock)
    await store.start()
    published.length = 0
    state.listener!({ type: 'sessions', sessions: [{ ...mk('a', null), title: 'renamed', updatedAt: NOW - 500 }] })
    const ids = published.flatMap((p) => (p.type === 'sessions' ? p.sessions.map((s) => s.id) : []))
    expect(ids).toContain('a')
    expect(ids).not.toContain('b')
    await store.stop()
  })

  it('caches unknown ids until the TTL expires', async () => {
    const clock = { t: NOW }
    state.sessions = [mk('a', null)]
    const { store } = build(clock)
    await store.start()
    const before = state.lookups
    store.sessionDetail('ghost')
    store.sessionDetail('ghost')
    expect(state.lookups).toBe(before + 1)
    clock.t += 6 * 60_000
    store.sessionDetail('ghost')
    expect(state.lookups).toBe(before + 2)
    await store.stop()
  })
})
