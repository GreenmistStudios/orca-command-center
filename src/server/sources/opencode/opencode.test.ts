import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '../../../shared/contract.js'
import { openReadOnly, OPENCODE_DENIED_TABLES, type ReadOnlyDb } from '../../lib/sqlite.js'
import type { HarnessUpdate, Logger } from '../../types.js'
import {
  createOpenCodeFixture,
  FAKE_SECRETS,
  FLEET,
  seedRealisticFleet,
  type OpenCodeFixture,
} from '../../../../test/fixtures/opencode.js'
import { benchConfig } from './bench-config.js'
import { createOpenCodeSource, type OpenCodeSource } from './index.js'

const NOW = 1_800_000_000_000
const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }
const P = FLEET.parts

let dir: string
let fx: OpenCodeFixture
let src: OpenCodeSource
let clock = NOW
let sql: Array<{ sql: string; params: unknown[] }> = []
let updates: HarnessUpdate[] = []

function wrap(db: ReadOnlyDb): ReadOnlyDb {
  return {
    ...db,
    all: ((s: string, ...p: unknown[]) => (sql.push({ sql: s, params: p }), db.all(s, ...(p as never[])))) as ReadOnlyDb['all'],
    get: ((s: string, ...p: unknown[]) => (sql.push({ sql: s, params: p }), db.get(s, ...(p as never[])))) as ReadOnlyDb['get'],
    explain: db.explain,
    dataVersion: () => db.dataVersion(),
  }
}

async function boot(opts: { windowMs?: number } = {}) {
  src = createOpenCodeSource(
    { config: benchConfig(fx.path, { windowMs: opts.windowMs ?? 3600_000, pollMs: 3_600_000 }), log, now: () => clock },
    { openDb: (p) => wrap(openReadOnly(p, { deniedTables: OPENCODE_DENIED_TABLES })) },
  )
  src.subscribe((u) => updates.push(u))
  await src.start()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'occ-oc-'))
  fx = createOpenCodeFixture(dir)
  clock = NOW
  sql = []
  updates = []
})
afterEach(async () => {
  await src?.stop()
  fx.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const allEvents = () => updates.flatMap((u) => (u.type === 'activity' ? u.events : []))

describe('lifecycle & health', () => {
  it('reports disabled / missing without throwing', async () => {
    const a = createOpenCodeSource({ config: benchConfig(null), log, now: () => NOW })
    await a.start()
    expect(a.health().status).toBe('disabled')
    expect(a.listSessions(0)).toEqual([])
    const b = createOpenCodeSource({ config: benchConfig(join(dir, 'nope.db')), log, now: () => NOW })
    await b.start()
    expect(b.health().status).toBe('missing')
    await a.stop()
    await b.stop()
  })

  it('errors when session/part are missing', async () => {
    const f = join(dir, 'bad.db')
    const w = new DatabaseSync(f)
    w.exec('CREATE TABLE message (id text)')
    w.close()
    const s = createOpenCodeSource({ config: benchConfig(f), log, now: () => NOW })
    await s.start()
    expect(s.health().status).toBe('error')
    await s.stop()
  })

  it('is healthy with an event log and exposes cursor in detail', async () => {
    seedRealisticFleet(fx, NOW)
    await boot()
    const h = src.health()
    expect(h).toMatchObject({ id: 'opencode', label: 'OpenCode', status: 'ok', version: 'event-log' })
    expect(h.detail).toMatch(/4 sessions in window · cursor \d+/)
  })

  it('falls back to polling when the event table is missing', async () => {
    seedRealisticFleet(fx, NOW)
    fx.db.exec('DROP TABLE event')
    await boot()
    expect(src.health()).toMatchObject({ status: 'degraded', version: 'polling' })
    expect(src.health().detail).toContain('no event log; polling sessions')
    // a new streaming update
    clock = NOW + 1000
    fx.updatePart(P.streamText, { type: 'text', text: 'Running the tests now, done', time: { start: NOW - 5000 } }, NOW + 900)
    fx.updateSession(FLEET.root, { updated: NOW + 900 })
    src.tick()
    const ev = allEvents().filter((e) => e.id === `opencode:${P.streamText}`)
    expect(ev).toHaveLength(1)
    expect(ev[0]!.summary).toContain('done')
    expect(updates.some((u) => u.type === 'sessions')).toBe(true)
  })
})

describe('sessions', () => {
  beforeEach(async () => {
    seedRealisticFleet(fx, NOW)
    await boot()
  })

  it('maps rows, resolves roots, spawn linkage and derived fields', () => {
    const root = src.getSession(FLEET.root)!
    expect(root).toMatchObject({
      harness: 'opencode',
      parentId: null,
      agent: 'build',
      title: 'Implement the command center',
      directory: '/repo/app',
      processAlive: null,
      transcriptState: 'working',
      model: { providerId: 'github-copilot', modelId: 'claude-opus-5.5' },
      cost: 1.25,
    })
    expect(root.tokens.cacheRead).toBe(50_000)
    expect(root.current).toMatchObject({ kind: 'tool', label: 'bash', detail: 'npm test' })
    expect(root.lastPrompt).toBe('Please build the command center and open a PR.')
    expect(root.lastMessage).toBe('Running the tests now')
    expect(root.facts).toEqual(
      expect.arrayContaining([
        { label: 'Version', value: 'v1.19.3' },
        { label: 'Files changed', value: '3' },
      ]),
    )
    const done = src.getSession(FLEET.childDone)!
    expect(done.title).toBe('Validate the schema')
    expect(done.agent).toBe('sonnet-coder')
    expect(done.parentId).toBe(FLEET.root)
    expect(done.transcriptState).toBe('done')
    expect(done.spawn).toMatchObject({
      parentSessionId: FLEET.root,
      activityId: `opencode:${P.taskDone}`,
      callId: 'call_task1',
      description: 'Validate the schema',
      subagentType: 'sonnet-coder',
      status: 'completed',
    })
    const live = src.getSession(FLEET.childLive)!
    expect(live.transcriptState).toBe('working')
    expect(live.current).toMatchObject({ kind: 'thinking', label: 'Thinking' })
    expect(live.spawn?.status).toBe('running')
    const q = src.getSession(FLEET.rootQuestion)!
    expect(q.transcriptState).toBe('waiting')
    expect(q.current).toMatchObject({ kind: 'tool', label: 'question', detail: 'Postgres or SQLite?' })
  })

  it('lists window sessions plus ancestors, newest first; getSession works outside the window', () => {
    const ids = src.listSessions(NOW - 100_000).map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining([FLEET.root, FLEET.childLive, FLEET.rootQuestion]))
    expect(ids).not.toContain(FLEET.rootOld)
    // only the live child is within 10s → its parent root is added as ancestor
    const only = src.listSessions(NOW - 5000).map((s) => s.id)
    expect(only).toContain(FLEET.childLive)
    expect(only).toContain(FLEET.root)
    expect(src.getSession(FLEET.rootOld)?.transcriptState).toBe('done')
    expect(src.getSession('ses_missing')).toBeNull()
    expect(src.getChildren(FLEET.root).map((s) => s.id).sort()).toEqual([FLEET.childDone, FLEET.childLive].sort())
  })

  it('counters, tool stats, todos', () => {
    const c = src.getCounters(FLEET.root)
    expect(c).toMatchObject({ messages: 3, steps: 1, thinking: 1, subagents: 2, mcpCalls: 2, toolErrors: 1, fileChanges: 2 })
    expect(c.tools).toBe(10)
    expect(c.filesTouched).toBe(3) // app.ts, Plan.md, other.ts
    const stats = src.getToolStats([FLEET.root, FLEET.childDone])
    expect(stats[0]!.calls).toBeGreaterThanOrEqual(stats[stats.length - 1]!.calls)
    expect(stats.find((s) => s.name === 'atlassian_jira_get_issue')).toMatchObject({ category: 'mcp', mcpServer: 'atlassian', calls: 1 })
    expect(stats.find((s) => s.name === 'bitrise_get_build_log')).toMatchObject({ errors: 1 })
    expect(src.getTodos(FLEET.root).map((t) => [t.content, t.status, t.position])).toEqual([
      ['Write adapter', 'in_progress', 0],
      ['Write tests', 'pending', 1],
    ])
  })
})

describe('event tail', () => {
  it('emits coalesced activity, touched sessions and todos in one tick', async () => {
    seedRealisticFleet(fx, NOW)
    await boot()
    updates = []
    // streaming update x3 + a todowrite completion + message completion
    const t = NOW + 5000
    clock = t
    for (const text of ['Run', 'Running tests', 'Tests are green.']) {
      fx.appendEvent({
        aggregateId: FLEET.root,
        type: 'message.part.updated.1',
        data: { sessionID: FLEET.root, part: { id: P.streamText, sessionID: FLEET.root, messageID: FLEET.messages.asstLive, type: 'text', text, time: { start: NOW - 5000, end: text.endsWith('.') ? t : undefined } }, time: t },
      })
    }
    fx.appendEvent({
      aggregateId: FLEET.root,
      type: 'message.part.updated.1',
      data: {
        sessionID: FLEET.root,
        part: { id: 'prt_new_todo', sessionID: FLEET.root, messageID: FLEET.messages.asstLive, type: 'tool', callID: 'c9', tool: 'todowrite', state: { status: 'completed', input: { todos: [{ content: 'x', status: 'pending', priority: 'low' }] }, output: '[]', time: { start: t - 10, end: t } } },
        time: t,
      },
    })
    fx.setTodos(FLEET.root, [{ content: 'Ship it', status: 'pending' }])
    fx.appendEvent({
      aggregateId: FLEET.root,
      type: 'message.part.updated.1',
      data: { sessionID: FLEET.root, part: { id: P.bashRunning, sessionID: FLEET.root, messageID: FLEET.messages.asstLive, type: 'tool', callID: 'call_bash2', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok', time: { start: NOW - 10_000, end: t } } }, time: t },
    })
    fx.appendEvent({
      aggregateId: FLEET.root,
      type: 'message.updated.1',
      data: { sessionID: FLEET.root, info: { id: FLEET.messages.asstLive, sessionID: FLEET.root, role: 'assistant', agent: 'build', modelID: 'claude-opus-5.5', providerID: 'github-copilot', time: { created: NOW - 30_000, completed: t }, finish: 'stop', cost: 0.1, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } },
    })
    fx.appendEvent({ aggregateId: FLEET.root, type: 'weird.event.1', data: { x: 1 } })
    fx.db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?,?,?,?,?)').run('evt_bad', FLEET.root, 9999, 'message.part.updated.1', '{not json')

    src.tick()
    const types = updates.map((u) => u.type)
    expect(types).toEqual(['sessions', 'activity', 'todos'])
    const ev = allEvents()
    expect(ev.filter((e) => e.id === `opencode:${P.streamText}`)).toHaveLength(1)
    expect(ev.find((e) => e.id === `opencode:${P.streamText}`)).toMatchObject({ summary: 'Tests are green.', status: 'completed', source: 'opencode.event' })
    expect(ev.map((e) => e.ts)).toEqual([...ev.map((e) => e.ts)].sort((a, b) => a - b))
    const sess = (updates[0] as Extract<HarnessUpdate, { type: 'sessions' }>).sessions
    const root = sess.find((s) => s.id === FLEET.root)!
    expect(root.transcriptState).toBe('done')
    expect(root.current).toBeNull()
    expect(root.lastMessage).toBe('Tests are green.')
    const todos = updates[2] as Extract<HarnessUpdate, { type: 'todos' }>
    expect(todos.sessionId).toBe(FLEET.root)
    expect(todos.todos.map((x) => x.content)).toEqual(['Ship it'])
    expect(src.health().detail).toMatch(/1 unknown events/)
    expect(src.health().detail).toMatch(/1 malformed events/)
    // a second tick with no change emits nothing
    updates = []
    src.tick()
    expect(updates).toEqual([])
  })

  it('updates spawn status when the parent task part changes', async () => {
    seedRealisticFleet(fx, NOW)
    await boot()
    updates = []
    fx.appendEvent({
      aggregateId: FLEET.root,
      type: 'message.part.updated.1',
      data: { sessionID: FLEET.root, part: { id: P.taskLive, sessionID: FLEET.root, messageID: FLEET.messages.asstDone, type: 'tool', callID: 'call_task2', tool: 'task', state: { status: 'completed', input: { description: 'Explore the repo', subagent_type: 'explore' }, output: 'done', metadata: { sessionId: FLEET.childLive }, time: { start: NOW - 61_000, end: NOW } } }, time: NOW },
    })
    src.tick()
    const s = updates.flatMap((u) => (u.type === 'sessions' ? u.sessions : [])).find((x) => x.id === FLEET.childLive)!
    expect(s.spawn?.status).toBe('completed')
    expect(allEvents()[0]).toMatchObject({ kind: 'subagent', childSessionId: FLEET.childLive })
  })

  it('does not query anything (besides data_version) when nothing changed', async () => {
    seedRealisticFleet(fx, NOW)
    await boot()
    sql = []
    src.tick()
    src.tick()
    expect(sql).toEqual([])
    // a write by "another process" is noticed
    fx.appendSessionEvent(FLEET.root)
    src.tick()
    expect(sql.length).toBeGreaterThan(0)
  })

  it('emits reset and re-seeds when the cursor is rewound', async () => {
    seedRealisticFleet(fx, NOW)
    await boot()
    updates = []
    fx.db.exec('DELETE FROM event WHERE rowid > 2')
    src.tick()
    expect(updates[0]).toEqual({ type: 'reset', reason: 'event log rewound' })
    expect(src.health().detail).toMatch(/cursor 2$/)
  })

  it('handles new sessions via session.created.1', async () => {
    seedRealisticFleet(fx, NOW)
    await boot()
    updates = []
    fx.addSession({ id: 'ses_new', title: 'Fresh', agent: 'build', created: NOW + 10, updated: NOW + 10 })
    fx.appendSessionEvent('ses_new', 'session.created.1')
    src.tick()
    const s = updates.flatMap((u) => (u.type === 'sessions' ? u.sessions : [])).find((x) => x.id === 'ses_new')
    expect(s).toMatchObject({ title: 'Fresh', transcriptState: 'unknown' })
  })
})

describe('transcript, activity, parts, diffs, file changes', () => {
  beforeEach(async () => {
    seedRealisticFleet(fx, NOW)
    await boot()
  })

  it('pages the transcript newest-first by cursor and returns oldest → newest', () => {
    const p1 = src.getTranscript(FLEET.root, { limit: 2 })
    expect(p1.messages.map((m) => m.id)).toEqual([FLEET.messages.asstDone, FLEET.messages.asstLive])
    expect(p1.hasMore).toBe(true)
    const p2 = src.getTranscript(FLEET.root, { limit: 2, before: p1.before! })
    expect(p2.messages.map((m) => m.id)).toEqual([FLEET.messages.user])
    expect(p2.hasMore).toBe(false)
    expect(p2.before).toBeNull()
    const asst = p1.messages[0]!
    expect(asst).toMatchObject({ role: 'assistant', agent: 'build', finish: 'tool-calls', cost: 0.6 })
    expect(asst.tokens?.cacheRead).toBe(4000)
    expect(asst.items.length).toBe(13)
    expect(p2.messages[0]!.items.map((i) => i.kind)).toEqual(['prompt', 'prompt'])
  })

  it('marks synthetic text in the transcript but skips it in activity', () => {
    fx.addPart({ id: 'prt_syn', messageId: FLEET.messages.user, sessionId: FLEET.root, created: NOW - 888_000, data: { type: 'text', text: 'injected context', synthetic: true } })
    const items = src.getTranscript(FLEET.root, { limit: 10 }).messages.flatMap((m) => m.items)
    expect(items.find((i) => i.id === 'opencode:prt_syn')?.title).toBe('(synthetic) injected context')
    const act = src.getActivity([FLEET.root], { limit: 100 }).events
    expect(act.find((i) => i.id === 'opencode:prt_syn')).toBeUndefined()
  })

  it('pages activity with kinds filter and cursor', () => {
    const page1 = src.getActivity([FLEET.root], { limit: 5 })
    expect(page1.events).toHaveLength(5)
    expect(page1.hasMore).toBe(true)
    expect(page1.events.map((e) => e.ts)).toEqual([...page1.events.map((e) => e.ts)].sort((a, b) => a - b))
    const page2 = src.getActivity([FLEET.root], { limit: 100, before: page1.before! })
    const ids1 = new Set(page1.events.map((e) => e.id))
    expect(page2.events.every((e) => !ids1.has(e.id))).toBe(true)
    expect(page1.events.length + page2.events.length).toBe(src.getActivity([FLEET.root], { limit: 1000 }).events.length)
    const mcp = src.getActivity([FLEET.root, FLEET.childDone], { kinds: ['mcp'], limit: 50 })
    expect(mcp.events.map((e) => e.tool?.name).sort()).toEqual(['atlassian_jira_get_issue', 'bitrise_get_build_log'])
    expect(mcp.hasMore).toBe(false)
    const multi = src.getActivity([FLEET.root, FLEET.childDone, FLEET.childLive], { limit: 1000 }).events
    expect(multi.some((e) => e.sessionId === FLEET.childDone)).toBe(true)
    expect(multi.every((e) => e.rootId === FLEET.root)).toBe(true)
  })

  it('recentActivity comes from the event log, oldest → newest, without steps', () => {
    const r = src.recentActivity({ sinceMs: NOW - 120_000, limit: 100 })
    const streams = r.filter((e) => e.id === `opencode:${P.streamText}`)
    expect(streams).toHaveLength(1)
    expect(r.every((e) => e.kind !== 'step')).toBe(true)
    expect(r.map((e) => e.ts)).toEqual([...r.map((e) => e.ts)].sort((a, b) => a - b))
    expect(r.find((e) => e.id === `opencode:${P.questionTool}`)?.status).toBe('running')
    expect(src.recentActivity({ sinceMs: NOW - 120_000, limit: 2 })).toHaveLength(2)
  })

  it('part detail redacts, drops signatures and data urls', () => {
    const bash = src.getPart(P.bashDone)!
    expect(JSON.stringify(bash)).not.toContain(FLEET.commandSecret)
    expect(bash.input).toMatchObject({ command: expect.stringContaining('GH_TOKEN=') })
    expect(bash.output).toContain('#42')
    expect(bash.output).not.toContain('\u001b')
    const r = src.getPart(P.reasoning)!
    expect(r.text).toContain('schema')
    expect(JSON.stringify(r.metadata)).not.toContain('SIGNATURE_BLOB')
    const file = src.getPart(P.userFile)!
    expect(JSON.stringify(file)).not.toContain('base64')
    expect(src.getPart(P.read)!.output).toContain('secretish')
    expect(src.getPart(P.bitrise)).toMatchObject({ kind: 'mcp', error: expect.stringContaining('404') })
    expect(src.getPart('prt_missing')).toBeNull()
  })

  it('diffs: unified, new-file, patch-text, none', () => {
    const edit = src.getDiff(`opencode:${P.edit}`)!
    expect(edit.format).toBe('unified')
    expect(edit.text).toContain('+new line')
    expect(edit.path).toBe('/repo/app/src/app.ts')
    const wr = src.getDiff(`opencode:${P.write}`)!
    expect(wr).toMatchObject({ format: 'new-file', path: '/repo/app/Plan.md' })
    expect(wr.text).toContain('Step one')
    const snap = src.getDiff(`opencode:${P.patch}`)!
    expect(snap.format).toBe('none')
    expect(snap.note).toBe('Snapshot abc1234 — diff not recorded in the transcript')
    fx.addPart({
      id: 'prt_ap',
      messageId: FLEET.messages.asstLive,
      sessionId: FLEET.root,
      created: NOW,
      data: { type: 'tool', callID: 'c', tool: 'apply_patch', state: { status: 'completed', input: { patchText: '*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n+c\n*** Add File: y.ts\n+hello\n*** Delete File: z.ts\n*** End Patch' }, output: 'ok', time: { start: NOW, end: NOW } } },
    })
    const ap = src.getDiff('opencode:prt_ap')!
    expect(ap.format).toBe('patch-text')
    expect(ap.text).toContain('*** Update File')
    expect(src.getDiff('opencode:nope')).toBeNull()
    const fcs = src.getFileChanges([FLEET.root]).filter((f) => f.id.startsWith('opencode:prt_ap'))
    expect(fcs.map((f) => [f.relPath, f.kind, f.additions, f.deletions])).toEqual([
      ['src/x.ts', 'patch', 2, 1],
      ['y.ts', 'create', 1, 0],
      ['z.ts', 'delete', 0, 0],
    ])
    expect(fcs[0]!.id).toBe('opencode:prt_ap#0')
    expect(src.getDiff(fcs[1]!.id)!.format).toBe('patch-text')
  })

  it('file changes: kinds, +/- counts, dedupe vs patch parts', () => {
    const fcs = src.getFileChanges([FLEET.root])
    expect(fcs.map((f) => [f.relPath, f.kind, f.tool, f.additions, f.deletions])).toEqual([
      ['src/app.ts', 'edit', 'edit', 2, 1],
      ['Plan.md', 'create', 'write', 4, 0],
      ['src/other.ts', 'patch', null, null, null],
    ])
    expect(fcs[0]).toMatchObject({ workspaceRoot: '/repo/app', sessionId: FLEET.root, rootId: FLEET.root, harness: 'opencode', status: 'completed', path: '/repo/app/src/app.ts' })
    expect(src.getFileChanges([FLEET.root], NOW - 10_000)).toEqual([])
  })
})

describe('normalization', () => {
  beforeEach(async () => {
    seedRealisticFleet(fx, NOW)
    await boot()
  })
  const ev = (id: string): ActivityEvent => src.getActivity([FLEET.root], { limit: 1000 }).events.find((e) => e.id === `opencode:${id}`)!

  it('covers every part type and tool category', () => {
    expect(ev(P.userText)).toMatchObject({ kind: 'prompt', detailRef: P.userText })
    expect(ev(P.userFile)).toMatchObject({ kind: 'prompt', title: 'Attachment · mock.png', summary: null, detailRef: null })
    expect(ev(P.reasoning)).toMatchObject({ kind: 'thinking', title: 'Thinking', status: 'completed', summary: expect.stringContaining('schema') })
    expect(ev(P.reasoning).endTs).toBe(NOW - 876_000)
    expect(ev(P.bashDone)).toMatchObject({ kind: 'tool', status: 'completed', tool: { category: 'shell', durationMs: 2000 } })
    expect(ev(P.bashRunning)).toMatchObject({ kind: 'tool', status: 'running', summary: 'PASS src/a.test.ts\n', title: 'bash · npm test' })
    expect(ev(P.read)).toMatchObject({ kind: 'tool', title: 'read · src/app.ts', summary: null, files: ['/repo/app/src/app.ts'] })
    expect(ev(P.read).tool!.output).toBeNull()
    expect(ev(P.edit)).toMatchObject({ kind: 'file-change', title: 'edit · src/app.ts', files: ['/repo/app/src/app.ts'] })
    expect(ev(P.write)).toMatchObject({ kind: 'file-change', title: 'write · Plan.md' })
    expect(ev(P.jira)).toMatchObject({ kind: 'mcp', title: expect.stringMatching(/^jira_get_issue · /), tool: { mcpServer: 'atlassian', displayName: 'jira_get_issue', category: 'mcp' } })
    expect(ev(P.bitrise)).toMatchObject({ kind: 'mcp', status: 'error', tool: { error: 'Request failed: 404 build not found' } })
    expect(ev(P.taskDone)).toMatchObject({ kind: 'subagent', title: 'sonnet-coder · Validate the schema', childSessionId: FLEET.childDone })
    expect(ev(P.todowrite)).toMatchObject({ kind: 'todo', title: 'todowrite · 2 todos' })
    expect(ev(P.stepFinish)).toMatchObject({ kind: 'step', title: 'Step · tool-calls · 5.0k tokens', usage: { cost: 0.6, tokens: { input: 100, cacheRead: 4000, cacheWrite: 300 } } })
    expect(ev(P.patch)).toMatchObject({ kind: 'file-change', title: 'Snapshot · 2 files changed', files: ['/repo/app/src/app.ts', '/repo/app/src/other.ts'] })
    expect(ev(P.prText)).toMatchObject({ kind: 'text', links: [FLEET.prUrl.replace(/\/$/, '')] })
    expect(ev(P.questionTool)).toBeUndefined() // other session
    // step-start never becomes an event
    expect(src.getActivity([FLEET.root], { limit: 1000 }).events.find((e) => e.id.includes('step_start'))).toBeUndefined()
    const q = src.getActivity([FLEET.rootQuestion], { limit: 10 }).events.find((e) => e.id.includes(P.questionTool))!
    expect(q).toMatchObject({ kind: 'tool', title: 'question · Postgres or SQLite?', status: 'running', tool: { category: 'question' } })
  })

  it('redacts secrets in commands and strips ANSI; never emits data urls', () => {
    const b = ev(P.bashDone)
    expect(b.title).not.toContain(FLEET.commandSecret)
    expect(b.tool!.input).not.toContain(FLEET.commandSecret)
    expect(b.tool!.input).toContain('GH_TOKEN=')
    expect(b.summary).toBe('#42 Add command center\n#41 Fix lint')
    const everything = JSON.stringify([
      src.getActivity([FLEET.root], { limit: 1000 }),
      src.getTranscript(FLEET.root, { limit: 100 }),
      src.recentActivity({ sinceMs: 0, limit: 1000 }),
    ])
    expect(everything).not.toContain('base64')
    expect(everything).not.toContain(FLEET.commandSecret)
    expect(everything).not.toContain('SIGNATURE_BLOB')
  })

  it('truncates titles and summaries to the contract limits', () => {
    fx.addPart({ id: 'prt_big', messageId: FLEET.messages.asstLive, sessionId: FLEET.root, created: NOW, data: { type: 'text', text: 'x'.repeat(5000), time: { start: NOW, end: NOW } } })
    const e = src.getActivity([FLEET.root], { limit: 1000 }).events.find((x) => x.id === 'opencode:prt_big')!
    expect(Array.from(e.title).length).toBeLessThanOrEqual(140)
    expect(Array.from(e.summary!).length).toBeLessThanOrEqual(601)
  })

  it('classifies MCP servers by shared prefixes seen across tools', () => {
    for (const [i, name] of ['acme_alpha', 'acme_beta'].entries()) {
      fx.addPart({ id: `prt_acme${i}`, messageId: FLEET.messages.asstLive, sessionId: FLEET.root, created: NOW + i, data: { type: 'tool', callID: 'c', tool: name, state: { status: 'completed', input: { a: 1 }, output: 'ok', time: { start: NOW, end: NOW } } } })
    }
    fx.addPart({ id: 'prt_goal', messageId: FLEET.messages.asstLive, sessionId: FLEET.root, created: NOW, data: { type: 'tool', callID: 'c', tool: 'get_goal', state: { status: 'completed', input: {}, output: 'ok', time: { start: NOW, end: NOW } } } })
    const evs = src.getActivity([FLEET.root], { limit: 1000 }).events
    expect(evs.find((e) => e.id === 'opencode:prt_acme0')!.tool).toMatchObject({ category: 'mcp', mcpServer: 'acme', displayName: 'alpha' })
    expect(evs.find((e) => e.id === 'opencode:prt_goal')!.tool).toMatchObject({ category: 'plugin', mcpServer: null })
  })
})

describe('safety: denied tables, query plans', () => {
  it('never mentions a denied table in any SQL, and never leaks fake secrets', async () => {
    seedRealisticFleet(fx, NOW)
    const seen: string[] = []
    const orig = DatabaseSync.prototype.prepare
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, s: string) {
      seen.push(s)
      return orig.call(this, s)
    })
    await boot()
    const out: unknown[] = []
    src.subscribe((u) => out.push(u))
    const all = [FLEET.root, FLEET.childDone, FLEET.childLive, FLEET.rootQuestion, FLEET.rootOld]
    for (const id of all) {
      out.push(src.getSession(id), src.getChildren(id), src.getCounters(id), src.getTodos(id), src.getTranscript(id, { limit: 50 }), src.getActivity([id], { limit: 100 }), src.getFileChanges([id]))
    }
    out.push(src.listSessions(0), src.getToolStats(all), src.recentActivity({ sinceMs: 0, limit: 500 }), src.health())
    for (const p of Object.values(P)) out.push(src.getPart(p), src.getDiff(`opencode:${p}`))
    fx.appendSessionEvent(FLEET.root)
    src.tick()
    const json = JSON.stringify(out)
    for (const secret of FAKE_SECRETS) expect(json).not.toContain(secret)
    const joined = seen.join('\n').toLowerCase()
    expect(seen.length).toBeGreaterThan(10)
    for (const t of OPENCODE_DENIED_TABLES) {
      expect(joined).not.toMatch(new RegExp(`(?<![a-z0-9_])${t}(?![a-z0-9_])`))
    }
  })

  it('uses indexed access (SEARCH, never SCAN) for part/message/event', async () => {
    seedRealisticFleet(fx, NOW)
    await boot()
    for (const id of [FLEET.root, FLEET.childDone, FLEET.rootQuestion]) {
      src.getSession(id)
      src.getCounters(id)
      src.getToolStats([id])
      src.getTranscript(id, { limit: 2 })
      src.getTranscript(id, { limit: 2, before: `${NOW}:msg_zzz` })
      src.getActivity([id], { limit: 3 })
      src.getActivity([id], { limit: 3, before: `${NOW}:prt_zzz`, sinceMs: 1 })
      src.getFileChanges([id], 1)
    }
    src.getPart(P.edit)
    src.getDiff(`opencode:${P.edit}`)
    src.recentActivity({ sinceMs: 0, limit: 10 })
    fx.appendSessionEvent(FLEET.root)
    fx.appendPartEvent(P.bashRunning)
    src.tick()
    const db = openReadOnly(fx.path, { deniedTables: OPENCODE_DENIED_TABLES })
    const big = /\b(part|message|event)\b/i
    const checked = new Set<string>()
    for (const { sql: s, params } of sql) {
      if (checked.has(s) || !big.test(s.replace(/'[^']*'/g, ''))) continue
      checked.add(s)
      const plan = db.explain(s, ...(params as never[]))
      for (const line of plan) {
        expect(line, `${s}\n${plan.join('\n')}`).not.toMatch(/^SCAN (part|message|event)\b/)
      }
      expect(plan.some((l) => /^SEARCH (part|message|event)\b/.test(l)), `${s}\n${plan.join('\n')}`).toBe(true)
    }
    db.close()
    expect(checked.size).toBeGreaterThan(12)
  })
})
