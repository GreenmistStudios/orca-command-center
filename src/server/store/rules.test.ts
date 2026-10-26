import { describe, expect, it } from 'vitest'
import type { ActivityEvent, FileChange, OrchRunDetail, SessionSummary } from '../../shared/contract.js'
import { deriveArtifacts } from './artifacts.js'
import { computeAttention } from './attention.js'
import { JoinIndex } from './join.js'
import { Ring } from './ring.js'
import { computeStats, histogramOf } from './stats.js'

const NOW = 1_000_000_000_000
const T = { liveMs: 600_000, idleMs: 1_800_000, stalledMs: 600_000, workingMs: 120_000 }

const ev = (id: string, ts: number, p: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id, rev: ts, harness: 'opencode', sessionId: 's1', rootId: 's1', messageId: null, ts, endTs: null, kind: 'tool', status: 'completed',
  title: id, summary: null, tool: null, files: [], childSessionId: null, usage: null, links: [], source: 'opencode.part', detailRef: null, ...p,
})
const sess = (id: string, p: Partial<SessionSummary> = {}): SessionSummary => ({
  id, harness: 'opencode', parentId: null, rootId: id, depth: 0, title: `T ${id}`, agent: 'build', model: { providerId: null, modelId: 'm1' }, directory: '/d',
  workspace: { key: '/d', name: 'proj', path: '/d', repo: null, branch: null }, createdAt: NOW - 1e6, updatedAt: NOW - 1000, lastActivityAt: NOW - 1000, archivedAt: null,
  state: 'working', stateSource: 'transcript', stateSince: NOW - 5000, live: true, current: null, lastPrompt: null, lastMessage: null, counters: null,
  tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 0, cacheWrite: 0 }, cost: 0.5, childIds: [], descendantCount: 0, spawn: null, orca: null, facts: [], ...p,
})
const fc = (id: string, path: string, kind: FileChange['kind'], p: Partial<FileChange> = {}): FileChange => ({
  id, sessionId: 's1', rootId: 's1', harness: 'opencode', ts: NOW, path, workspaceRoot: null, relPath: null, kind, tool: 'write', status: 'completed', additions: null, deletions: null, ...p,
})

describe('ring', () => {
  it('upserts by id keeping the highest rev, sorted by ts', () => {
    const r = new Ring(100)
    r.upsert(ev('a', 20))
    r.upsert(ev('b', 10))
    r.upsert({ ...ev('a', 20), rev: 99, title: 'new' })
    expect(r.upsert({ ...ev('a', 20), rev: 5, title: 'stale' })).toBeNull()
    expect(r.all().map((e) => [e.id, e.title])).toEqual([['b', 'b'], ['a', 'new']])
  })
  it('evicts the oldest beyond capacity', () => {
    const r = new Ring(3)
    for (let i = 0; i < 6; i++) r.upsert(ev(`e${i}`, i))
    expect(r.all().map((e) => e.id)).toEqual(['e3', 'e4', 'e5'])
    expect(r.get('e0')).toBeUndefined()
  })
  it('handles bulk upserts', () => {
    const r = new Ring(1000)
    r.upsertMany(Array.from({ length: 100 }, (_, i) => ev(`e${i}`, 1000 - i)))
    expect(r.all()[0]!.id).toBe('e99')
    r.upsertMany([{ ...ev('e99', 1), rev: 7 }])
    expect(r.size).toBe(100)
  })
  it('queries with filters and cursors', () => {
    const r = new Ring(100)
    for (let i = 0; i < 10; i++) r.upsert(ev(`e${i}`, i * 10, { sessionId: i % 2 ? 's2' : 's1', kind: i % 3 ? 'tool' : 'text' }))
    const p1 = r.query({ limit: 3 })
    expect(p1.events.map((e) => e.id)).toEqual(['e7', 'e8', 'e9'])
    expect(p1.hasMore).toBe(true)
    const p2 = r.query({ limit: 3, before: p1.before! })
    expect(p2.events.map((e) => e.id)).toEqual(['e4', 'e5', 'e6'])
    expect(r.query({ limit: 50, sessionIds: ['s2'] }).events.map((e) => e.id)).toEqual(['e1', 'e3', 'e5', 'e7', 'e9'])
    expect(r.query({ limit: 50, kinds: ['text'] }).events.map((e) => e.id)).toEqual(['e0', 'e3', 'e6', 'e9'])
    expect(r.query({ limit: 50, sinceMs: 70 }).events.map((e) => e.id)).toEqual(['e7', 'e8', 'e9'])
    expect(r.query({ limit: 50 }).hasMore).toBe(false)
  })
})

describe('artifacts (Plan §9.4)', () => {
  const scope = { rootOf: (id: string) => id }
  it('classifies writes/creates', () => {
    const a = deriveArtifacts([], [
      fc('1', '/repo/Plan.md', 'write'),
      fc('2', '/repo/src/new.ts', 'create'),
      fc('3', '/repo/out/Report.html', 'create'),
      fc('4', '/repo/src/old.ts', 'write'),
      fc('5', '/repo/src/edited.ts', 'edit'),
      fc('6', '/repo/notes.md', 'edit'),
      fc('7', '/repo/data.json', 'create', { status: 'error' }),
    ], scope)
    expect(a.map((x) => [x.kind, x.label]).sort()).toEqual([['document', 'Plan.md'], ['new-file', 'new.ts'], ['report', 'Report.html']])
    expect(a.find((x) => x.label === 'Plan.md')).toMatchObject({ path: '/repo/Plan.md', sessionId: 's1', rootId: 's1' })
  })
  it('extracts PR links (deduped, GHE hosts) and text urls (capped)', () => {
    const pr = 'https://github.com/acme/app/pull/42'
    const ghe = 'https://ghe.example.com/org/repo/pull/7'
    const events = [
      ev('t1', 1, { kind: 'tool', links: [pr] }),
      ev('t2', 2, { kind: 'text', links: [pr, ghe, 'https://example.com/a'] }),
      ev('t3', 3, { kind: 'tool', links: ['https://example.com/tool-only'] }),
      ev('t4', 4, { kind: 'thinking', links: ['https://example.com/think'] }),
    ]
    const a = deriveArtifacts(events, [], scope)
    expect(a.filter((x) => x.kind === 'pull-request').map((x) => x.url).sort()).toEqual([ghe, pr].sort())
    expect(a.find((x) => x.url === pr)!.label).toBe('PR #42 · acme/app')
    expect(a.filter((x) => x.kind === 'url').map((x) => x.url)).toEqual(['https://example.com/a'])
    const many = Array.from({ length: 80 }, (_, i) => ev(`m${i}`, i, { kind: 'text', links: [`https://example.com/${i}`] }))
    expect(deriveArtifacts(many, [], scope).filter((x) => x.kind === 'url')).toHaveLength(50)
  })
  it('turns image attachments into image artifacts (filename only)', () => {
    const a = deriveArtifacts([ev('i', 1, { kind: 'prompt', title: 'Attachment · mock.png' }), ev('j', 2, { kind: 'prompt', title: 'Attachment · notes.txt' })], [], scope)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ kind: 'image', label: 'mock.png', path: null, url: null })
  })
})

describe('attention (Plan §9.3)', () => {
  const run = (p: Partial<OrchRunDetail> = {}): OrchRunDetail => ({
    run: { id: 'r1', objective: 'Ship it', coordinatorHandle: null, coordinatorSessionId: null, legacy: false, createdAt: NOW - 1000, updatedAt: NOW - 1000, lastActivityAt: NOW - 1000, taskCount: 1, statusCounts: {}, dispatchCount: 0, messageCount: 0, hasBlockingGate: false },
    tasks: [], dispatches: [], messages: [], gates: [], ...p,
  })
  const base = { stalled: new Set<string>(), runs: [] as OrchRunDetail[], toolErrors: new Map(), latestPermission: new Map(), now: NOW, thresholds: T }

  it('emits permission/question/error/stalled/tool-errors with stable ids', () => {
    const items = computeAttention({
      ...base,
      sessions: [
        sess('b', { state: 'blocked', stateSince: NOW - 10 }),
        sess('w', { state: 'waiting', stateSince: NOW - 20 }),
        sess('e', { state: 'error', live: false, lastActivityAt: NOW - 1000 }),
        sess('old-e', { state: 'error', live: false, lastActivityAt: NOW - T.liveMs - 1, updatedAt: NOW - T.liveMs - 1 }),
        sess('st', { state: 'unknown' }),
        sess('te', { state: 'working' }),
        sess('ok', { state: 'working' }),
      ],
      stalled: new Set(['st']),
      toolErrors: new Map([['te', [ev('x', NOW - 100, { status: 'error' })]]]),
    })
    expect(items.map((i) => i.id).sort()).toEqual(['error:e', 'permission:b', 'question:w', 'stalled:st', 'tool-errors:te'].sort())
    expect(items.map((i) => i.severity)).toEqual(['high', 'high', 'high', 'medium', 'medium'])
  })

  it('treats a Copilot waiting session with a pending permission as a permission request', () => {
    const items = computeAttention({
      ...base,
      sessions: [sess('c', { harness: 'copilot', state: 'waiting' }), sess('c2', { harness: 'copilot', state: 'waiting' })],
      latestPermission: new Map([['c', ev('p', NOW - 5, { kind: 'permission', status: 'pending', title: 'Permission requested · bash' })]]),
    })
    expect(items.map((i) => i.id).sort()).toEqual(['permission:c', 'question:c2'])
    expect(items.find((i) => i.id === 'permission:c')!.detail).toBe('Permission requested · bash')
  })

  it('emits gates, and failed tasks only for active runs', () => {
    const gate = { id: 'g1', runId: 'r1', taskId: 't1', question: 'Which?', options: [], status: 'pending', resolution: null, createdAt: NOW - 10, resolvedAt: null, blocking: true }
    const failed = run({
      tasks: [{ id: 't1', runId: 'r1', parentId: null, title: 'Do it', specPreview: '', specTruncated: false, status: 'failed', deps: [], createdAt: null, completedAt: null, resultPreview: null, createdByHandle: null, attemptCount: 2, latestDispatchId: null }],
      dispatches: [{ id: 'd1', runId: 'r1', taskId: 't2', status: 'circuit_broken', assigneeHandle: null, assigneeSessionId: null, dispatchedAt: null, completedAt: null, lastHeartbeatAt: null, failureCount: 3, lastFailure: 'boom', terminationReason: null, depth: null, workerState: null }],
      gates: [gate, { ...gate, id: 'g2', blocking: false }],
    })
    const items = computeAttention({ ...base, sessions: [], runs: [failed] })
    expect(items.map((i) => i.id).sort()).toEqual(['failed-task:t1', 'failed-task:t2', 'gate:g1'])
    expect(items.find((i) => i.id === 'failed-task:t1')!.title).toBe("Task 'Do it' failed (2 attempts)")
    expect(items.find((i) => i.id === 'gate:g1')).toMatchObject({ kind: 'gate', severity: 'high', title: "Run 'Ship it' is blocked on a decision" })
    const stale = run({ ...failed, run: { ...failed.run, lastActivityAt: NOW - 3 * 86400_000, updatedAt: NOW - 3 * 86400_000, createdAt: NOW - 3 * 86400_000 } })
    expect(computeAttention({ ...base, sessions: [], runs: [stale] }).map((i) => i.id)).toEqual(['gate:g1'])
  })
})

describe('stats (Plan §9.5)', () => {
  it('aggregates sessions, counters, tokens and breakdowns', () => {
    const sessions = [sess('a', { state: 'working' }), sess('b', { depth: 1, state: 'blocked', live: true, agent: 'explore', model: null }), sess('c', { state: 'done', live: false, harness: 'copilot' })]
    const st = computeStats(
      sessions,
      (id) => (id === 'a' ? { messages: 1, steps: 1, thinking: 2, tools: 10, toolErrors: 1, mcpCalls: 3, fileChanges: 4, filesTouched: 2, subagents: 1 } : null),
      [
        { name: 'bash', category: 'shell', mcpServer: null, calls: 5, errors: 1 },
        { name: 'get_issue', category: 'mcp', mcpServer: 'github', calls: 2, errors: 0 },
        { name: 'bash', category: 'shell', mcpServer: null, calls: 4, errors: 0 },
      ],
      [ev('old', NOW - 3 * 3600_000), ev('e2', NOW - 90_000, { kind: 'thinking' }), ev('e3', NOW - 90_000, { kind: 'file-change', status: 'error' }), ev('e1', NOW - 30_000, { kind: 'mcp' })],
      86_400_000,
      NOW,
    )
    expect(st.sessions).toEqual({ total: 3, roots: 2, live: 2, working: 1, blocked: 1, waiting: 0, error: 0 })
    expect(st.activity).toMatchObject({ toolCalls: 10, toolErrors: 1, mcpCalls: 3, thinking: 2, fileChanges: 4, filesTouched: 2, subagents: 1 })
    expect(st.tokens.input).toBe(3)
    expect(st.cost).toBeCloseTo(1.5)
    expect(st.byHarness.map((h) => [h.harness, h.sessions])).toEqual([['opencode', 2], ['copilot', 1]])
    expect(st.byAgent.map((a) => a.agent)).toEqual(['build', 'explore'])
    expect(st.topTools[0]).toMatchObject({ name: 'bash', calls: 9, errors: 1 })
    expect(st.mcpServers).toEqual([{ server: 'github', calls: 2, errors: 0, tools: 1 }])
    expect(st.histogram).toHaveLength(60)
    expect(st.histogram[59]).toMatchObject({ mcp: 1, tools: 1 })
    expect(st.histogram[58]).toMatchObject({ thinking: 1, edits: 1, errors: 1 })
    expect(histogramOf([], NOW).reduce((n, b) => n + b.tools, 0)).toBe(0)
  })
})

describe('join (data-sources §6)', () => {
  const wt = (id: string, path: string) => ({ id, repoId: 'r', repo: 'acme', path, branch: 'b', displayName: null, status: null, workspaceStatus: null, isActive: true, isMainWorktree: false, liveTerminalCount: 0, lastActivityAt: null, lastOutputAt: null, links: [] })
  it('uses the longest worktree prefix and falls back to the directory', () => {
    const j = new JoinIndex({ hooks: [], terminals: [], worktrees: [wt('w1', '/work/acme'), wt('w2', '/work/acme/feature-x')], runs: [], summaryRuns: [] })
    expect(j.workspaceByDirectory('/work/acme/feature-x/src')!.key).toBe('w2')
    expect(j.workspaceByDirectory('/work/acme/other')!.key).toBe('w1')
    expect(j.workspaceByDirectory('/work/acme-two')).toMatchObject({ key: '/work/acme-two', name: 'acme-two', repo: null })
    expect(j.workspaceByDirectory(null)).toBeNull()
  })
  it('newest hook wins per session', () => {
    const h = (pane: string, at: number) => ({ paneKey: pane, tabId: null, worktreeId: null, agent: null, hookEvent: null, state: 'working', prompt: null, lastAssistantMessage: null, providerSessionId: 's', receivedAt: at, stateStartedAt: null })
    const j = new JoinIndex({ hooks: [h('p1', 5), h('p2', 9)], terminals: [], worktrees: [], runs: [], summaryRuns: [] })
    expect(j.hookBySession.get('s')!.paneKey).toBe('p2')
  })
})
