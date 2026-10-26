import type { AgentState, EpochMs, HookEntry, OrchDispatch, StateSource } from '../../shared/contract.js'
import type { Config, HarnessSession } from '../types.js'

export type Thresholds = Config['thresholds']

export interface StateInput {
  session: Pick<HarnessSession, 'transcriptState' | 'lastActivityAt' | 'updatedAt' | 'spawn'>
  /** Hook entry matched to this session by providerSessionId (newest receivedAt). */
  hook: HookEntry | null
  /** Dispatch whose assignee terminal runs this session (worker without hook state). */
  dispatch: OrchDispatch | null
}

export interface DerivedState {
  state: AgentState
  stateSource: StateSource
  /** Hook-provided start time (only for stateSource 'orca-hook'). */
  hookSince: EpochMs | null
  /** Transcript says working but nothing happened for `stalledMs` (Plan §9.3). */
  stalled: boolean
}

const HOOK_STATES = new Set(['blocked', 'waiting', 'working', 'done'])

/** Plan §9.1 — first matching rule wins. Pure: all time comes from `now`. */
export function deriveState(input: StateInput, now: EpochMs, t: Thresholds): DerivedState {
  const { session, hook, dispatch } = input
  const last = session.lastActivityAt ?? session.updatedAt
  const age = now - last
  const none = (state: AgentState, stateSource: StateSource, stalled = false, hookSince: EpochMs | null = null): DerivedState => ({
    state,
    stateSource,
    hookSince,
    stalled,
  })

  // 1. Orca hook
  if (hook && hook.state && HOOK_STATES.has(hook.state)) {
    const received = hook.receivedAt ?? 0
    const transcriptNewer = session.lastActivityAt !== null && session.lastActivityAt > received + 30_000 && age <= t.workingMs
    if (hook.state !== 'working' && transcriptNewer) return none('working', 'transcript')
    switch (hook.state) {
      case 'blocked':
        return none('blocked', 'orca-hook', false, hook.stateStartedAt)
      case 'waiting':
        return none('waiting', 'orca-hook', false, hook.stateStartedAt)
      case 'working':
        return none('working', 'orca-hook', false, hook.stateStartedAt)
      default:
        return none(hook.receivedAt !== null && now - hook.receivedAt > t.idleMs ? 'idle' : 'done', 'orca-hook', false, hook.stateStartedAt)
    }
  }

  // 2. Parent tool call (subagents)
  const spawn = session.spawn
  if (spawn) {
    if (spawn.status === 'running' || spawn.status === 'pending') {
      // A "running" parent tool whose child went silent for stalledMs is not honest evidence.
      if (age <= t.stalledMs) {
        if (session.transcriptState === 'waiting') return none('waiting', 'parent-tool')
        if (session.transcriptState === 'error') return none('error', 'parent-tool')
        return none('working', 'parent-tool')
      }
    } else if (spawn.status === 'completed') {
      return none(age > t.idleMs ? 'idle' : 'done', 'parent-tool')
    } else if (spawn.status === 'error') {
      return none('error', 'parent-tool')
    }
  }

  // 3. Orchestration dispatch
  if (dispatch) {
    if (dispatch.status === 'dispatched') return none('working', 'orchestration')
    if (dispatch.status === 'completed') return none('done', 'orchestration')
    if (dispatch.status === 'failed' || dispatch.status === 'circuit_broken') return none('error', 'orchestration')
  }

  // 4. Transcript
  switch (session.transcriptState) {
    case 'waiting':
      return none('waiting', 'transcript')
    case 'error':
      return none('error', 'transcript')
    case 'working':
      if (age <= t.workingMs) return none('working', 'transcript')
      if (age > t.stalledMs) return none('unknown', 'transcript', true)
      return none('working', 'transcript')
    case 'done':
      return none(age > t.idleMs ? 'idle' : 'done', 'transcript')
    case 'unknown':
      return none(age > t.idleMs ? 'idle' : 'unknown', 'transcript')
  }
  // 5. Nothing
  return none('idle', 'none')
}

/** Plan §9.1 `live`. */
export function isLive(state: AgentState, lastActivityAt: EpochMs | null, updatedAt: EpochMs, now: EpochMs, t: Thresholds): boolean {
  if (state === 'working' || state === 'blocked' || state === 'waiting') return true
  return now - (lastActivityAt ?? updatedAt) <= t.liveMs
}
