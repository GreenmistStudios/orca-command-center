import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../../shared/contract'
import { buildMockWorld, MOCK_IDS } from '../../api/mock-data'
import type { FleetInput } from '../fleet/model'
import { buildOversight } from './model'

const NOW = Date.parse('2026-01-15T12:00:00Z')
const WIN = 24 * 3600_000

function mockInput(): FleetInput {
  const w = buildMockWorld({ now: NOW })
  return {
    sessions: Object.fromEntries(w.sessions),
    worktrees: w.orca.worktrees,
    runs: w.runs.map((r) => r.run),
    attention: w.attention,
    now: NOW,
    windowMs: WIN,
  }
}

function sess(id: string, o: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id, harness: 'opencode', parentId: null, rootId: id, depth: 0, title: id, agent: null, model: null, directory: null,
    workspace: { key: 'k1', name: 'ws', path: '/a', repo: 'repo', branch: 'main' },
    createdAt: 0, updatedAt: 0, lastActivityAt: null, state: 'idle', stateSource: 'transcript', stateSince: null,
    live: false, current: null, lastPrompt: null, lastMessage: null,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0,
    childIds: [], descendantCount: 0, spawn: null, orca: null, ...o,
  } as unknown as SessionSummary
}
const input = (sessions: SessionSummary[]): FleetInput => ({
  sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), worktrees: [], runs: [], attention: [], now: NOW, windowMs: WIN,
})

describe('buildOversight', () => {
  it('shows every root agent exactly once, grouped repo → worktree', () => {
    const inp = mockInput()
    const o = buildOversight(inp, { scope: 'all', harness: null })
    const shown = o.repos.flatMap((r) => r.worktrees.flatMap((w) => w.agents.map((a) => a.session.id)))
    const roots = Object.values(inp.sessions).filter((s) => s.parentId == null).map((s) => s.id)
    expect(shown.sort()).toEqual(roots.sort())
    expect(new Set(shown).size).toBe(shown.length)
    // Subagents are summarised on their root, not listed.
    expect(shown).not.toContain(MOCK_IDS.exploreUsages)
    expect(o.totals.agents).toBe(roots.length)
    expect(o.totals.repos).toBe(o.repos.length)
  })

  it('orders repos by urgency: needs-you, then working, then name', () => {
    const o = buildOversight(input([
      sess('a', { workspace: { key: 'ka', name: 'a', path: '/a', repo: 'alpha', branch: 'main' } }),
      sess('w', { state: 'working', live: true, workspace: { key: 'kw', name: 'w', path: '/w', repo: 'working-repo', branch: 'main' } }),
      sess('b', { state: 'blocked', live: true, workspace: { key: 'kb', name: 'b', path: '/b', repo: 'zulu-blocked', branch: 'main' } }),
    ]), { scope: 'all', harness: null })
    expect(o.repos.map((r) => r.name)).toEqual(['zulu-blocked', 'working-repo', 'alpha'])
    expect(o.totals).toMatchObject({ repos: 3, worktrees: 3, agents: 3, working: 1, needsYou: 1 })
  })

  it('is uncapped: never folds idle agents into an overflow', () => {
    const many = Array.from({ length: 300 }, (_, i) => sess(`s${i}`))
    const o = buildOversight(input(many), { scope: 'all', harness: null })
    expect(o.repos[0]!.worktrees[0]!.agents).toHaveLength(300)
  })

  it('respects the harness filter and the active scope', () => {
    const inp = input([
      sess('oc', { live: true }),
      sess('cp', { harness: 'copilot', live: true }),
      sess('old', { live: false, lastActivityAt: NOW - 2 * WIN }),
    ])
    const ids = (o: ReturnType<typeof buildOversight>) => o.repos.flatMap((r) => r.worktrees.flatMap((w) => w.agents.map((a) => a.session.id))).sort()
    expect(ids(buildOversight(inp, { scope: 'all', harness: 'copilot' }))).toEqual(['cp'])
    expect(ids(buildOversight(inp, { scope: 'active', harness: null }))).toEqual(['cp', 'oc'])
    expect(ids(buildOversight(inp, { scope: 'all', harness: null }))).toEqual(['cp', 'oc', 'old'])
  })

  it('returns an empty board with zero totals when there is nothing to show', () => {
    const o = buildOversight(input([]), { scope: 'active', harness: null })
    expect(o.repos).toEqual([])
    expect(o.totals).toMatchObject({ repos: 0, worktrees: 0, agents: 0 })
  })
})
