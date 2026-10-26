import { describe, expect, it } from 'vitest'
import type { HookEntry, OrchDispatch, SpawnInfo } from '../../shared/contract.js'
import { deriveState, isLive, type StateInput } from './state.js'

const T = { liveMs: 600_000, idleMs: 1_800_000, stalledMs: 600_000, workingMs: 120_000 }
const NOW = 1_000_000_000_000
const ago = (ms: number) => NOW - ms

const hook = (p: Partial<HookEntry> = {}): HookEntry => ({
  paneKey: 'a:b',
  tabId: 'a',
  worktreeId: null,
  agent: 'opencode',
  hookEvent: 'SessionBusy',
  state: 'working',
  prompt: null,
  lastAssistantMessage: null,
  providerSessionId: 's',
  receivedAt: ago(1000),
  stateStartedAt: ago(5000),
  ...p,
})
const spawn = (status: SpawnInfo['status']): SpawnInfo => ({ parentSessionId: 'p', activityId: 'a', callId: null, description: 'd', subagentType: null, status })
const disp = (status: string): OrchDispatch => ({
  id: 'd', runId: 'r', taskId: 't', status, assigneeHandle: 'h', assigneeSessionId: null, dispatchedAt: null, completedAt: null,
  lastHeartbeatAt: null, failureCount: 0, lastFailure: null, terminationReason: null, depth: null, workerState: null,
})
const input = (o: { ts?: StateInput['session']['transcriptState']; last?: number | null; updated?: number; spawn?: SpawnInfo | null; hook?: HookEntry | null; dispatch?: OrchDispatch | null }): StateInput => ({
  session: { transcriptState: o.ts ?? 'done', lastActivityAt: o.last === undefined ? ago(1000) : o.last, updatedAt: o.updated ?? ago(1000), spawn: o.spawn ?? null },
  hook: o.hook ?? null,
  dispatch: o.dispatch ?? null,
})

describe('deriveState (Plan §9.1)', () => {
  const cases: Array<[string, StateInput, string, string]> = [
    ['hook blocked', input({ hook: hook({ state: 'blocked' }) }), 'blocked', 'orca-hook'],
    ['hook waiting', input({ hook: hook({ state: 'waiting' }) }), 'waiting', 'orca-hook'],
    ['hook working', input({ hook: hook({ state: 'working' }), ts: 'done' }), 'working', 'orca-hook'],
    ['hook done (fresh)', input({ hook: hook({ state: 'done', receivedAt: ago(60_000) }), last: ago(60_000) }), 'done', 'orca-hook'],
    ['hook done (old) → idle', input({ hook: hook({ state: 'done', receivedAt: ago(T.idleMs + 1) }), last: ago(T.idleMs + 1) }), 'idle', 'orca-hook'],
    ['hook blocked but transcript active after +30 s → working', input({ hook: hook({ state: 'blocked', receivedAt: ago(60_000) }), last: ago(5000), ts: 'working' }), 'working', 'transcript'],
    ['hook blocked, transcript newer by < 30 s → hook wins', input({ hook: hook({ state: 'blocked', receivedAt: ago(10_000) }), last: ago(5000) }), 'blocked', 'orca-hook'],
    ['hook blocked, transcript newer but older than workingMs → hook wins', input({ hook: hook({ state: 'blocked', receivedAt: ago(400_000) }), last: ago(200_000) }), 'blocked', 'orca-hook'],
    ['hook unknown state falls through', input({ hook: hook({ state: 'weird' }), ts: 'waiting' }), 'waiting', 'transcript'],
    ['spawn running', input({ spawn: spawn('running'), ts: 'done' }), 'working', 'parent-tool'],
    ['spawn pending', input({ spawn: spawn('pending'), ts: 'done' }), 'working', 'parent-tool'],
    ['spawn running + transcript waiting', input({ spawn: spawn('running'), ts: 'waiting' }), 'waiting', 'parent-tool'],
    ['spawn running + transcript error', input({ spawn: spawn('running'), ts: 'error' }), 'error', 'parent-tool'],
    ['spawn running but silent for stalledMs → transcript rules', input({ spawn: spawn('running'), ts: 'working', last: ago(T.stalledMs + 1) }), 'unknown', 'transcript'],
    ['spawn completed', input({ spawn: spawn('completed'), ts: 'working' }), 'done', 'parent-tool'],
    ['spawn completed (old) → idle', input({ spawn: spawn('completed'), last: ago(T.idleMs + 1) }), 'idle', 'parent-tool'],
    ['spawn error', input({ spawn: spawn('error') }), 'error', 'parent-tool'],
    ['dispatch dispatched', input({ dispatch: disp('dispatched'), ts: 'done' }), 'working', 'orchestration'],
    ['dispatch completed', input({ dispatch: disp('completed'), ts: 'working' }), 'done', 'orchestration'],
    ['dispatch failed', input({ dispatch: disp('failed') }), 'error', 'orchestration'],
    ['dispatch circuit_broken', input({ dispatch: disp('circuit_broken') }), 'error', 'orchestration'],
    ['dispatch pending falls through', input({ dispatch: disp('pending'), ts: 'done' }), 'done', 'transcript'],
    ['transcript waiting', input({ ts: 'waiting' }), 'waiting', 'transcript'],
    ['transcript error', input({ ts: 'error' }), 'error', 'transcript'],
    ['transcript working fresh', input({ ts: 'working', last: ago(30_000) }), 'working', 'transcript'],
    ['transcript working 5 min quiet', input({ ts: 'working', last: ago(300_000) }), 'working', 'transcript'],
    ['transcript working silent > stalledMs', input({ ts: 'working', last: ago(T.stalledMs + 1) }), 'unknown', 'transcript'],
    ['transcript done', input({ ts: 'done' }), 'done', 'transcript'],
    ['transcript done old → idle', input({ ts: 'done', last: ago(T.idleMs + 1) }), 'idle', 'transcript'],
    ['transcript unknown fresh', input({ ts: 'unknown' }), 'unknown', 'transcript'],
    ['transcript unknown old → idle', input({ ts: 'unknown', last: ago(T.idleMs + 1) }), 'idle', 'transcript'],
    ['null lastActivityAt uses updatedAt', input({ ts: 'done', last: null, updated: ago(T.idleMs + 1) }), 'idle', 'transcript'],
  ]
  it.each(cases)('%s', (_n, inp, state, source) => {
    const d = deriveState(inp, NOW, T)
    expect([d.state, d.stateSource]).toEqual([state, source])
  })

  it('flags stalled only for silent working transcripts', () => {
    expect(deriveState(input({ ts: 'working', last: ago(T.stalledMs + 1) }), NOW, T).stalled).toBe(true)
    expect(deriveState(input({ ts: 'working', last: ago(1000) }), NOW, T).stalled).toBe(false)
  })

  it('reports the hook state start time', () => {
    expect(deriveState(input({ hook: hook({ stateStartedAt: 42 }) }), NOW, T).hookSince).toBe(42)
  })
})

describe('isLive', () => {
  it('is true for working/blocked/waiting regardless of age', () => {
    for (const s of ['working', 'blocked', 'waiting'] as const) expect(isLive(s, ago(9e9), ago(9e9), NOW, T)).toBe(true)
  })
  it('is true for recent activity, false otherwise', () => {
    expect(isLive('done', ago(T.liveMs - 1), 0, NOW, T)).toBe(true)
    expect(isLive('done', ago(T.liveMs + 1), 0, NOW, T)).toBe(false)
    expect(isLive('idle', null, ago(1000), NOW, T)).toBe(true)
  })
})
