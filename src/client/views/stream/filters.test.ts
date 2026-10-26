import { describe, expect, it } from 'vitest'
import type { ActivityEvent } from '../../../shared/contract'
import { effectiveKinds, matchesFilter, matchesQuery, mergeEvents } from './filters'

export function ev(p: Partial<ActivityEvent> & { id: string }): ActivityEvent {
  return {
    rev: 1, harness: 'opencode', sessionId: 's1', rootId: 'r1', messageId: null, ts: 1000, endTs: null, kind: 'tool', status: 'completed',
    title: 'bash · npm test', summary: null, tool: null, files: [], childSessionId: null, usage: null, links: [], source: 't', detailRef: null, ...p,
  }
}

describe('filters', () => {
  it('defaults exclude steps', () => {
    expect(effectiveKinds([]).has('step')).toBe(false)
    expect(effectiveKinds(['step']).has('step')).toBe(true)
  })
  it('matches query across fields', () => {
    expect(matchesQuery(ev({ id: 'a', files: ['/x/App.tsx'] }), 'app.tsx')).toBe(true)
    expect(matchesQuery(ev({ id: 'a' }), 'nomatch')).toBe(false)
    expect(matchesQuery(ev({ id: 'a' }), 'refactor', 'Refactor auth')).toBe(true)
  })
  it('filters errors/harness/kinds', () => {
    const f = { kinds: new Set(['tool' as const]), harness: 'all' as const, errorsOnly: true, query: '' }
    expect(matchesFilter(ev({ id: 'a' }), f)).toBe(false)
    expect(matchesFilter(ev({ id: 'a', status: 'error' }), f)).toBe(true)
    expect(matchesFilter(ev({ id: 'a', status: 'error', harness: 'codex' }), { ...f, harness: 'opencode' })).toBe(false)
    expect(matchesFilter(ev({ id: 'a', status: 'error', kind: 'text' }), f)).toBe(false)
  })
  it('merges with rev dedupe and ts order', () => {
    const out = mergeEvents([ev({ id: 'b', ts: 2 }), ev({ id: 'a', ts: 1, title: 'old' })], [ev({ id: 'a', ts: 1, rev: 2, title: 'new' })])
    expect(out.map((e) => e.id)).toEqual(['a', 'b'])
    expect(out[0]!.title).toBe('new')
  })
})
