import { mkdtempSync, rmSync, statSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityEvent } from '../../../shared/contract.js'
import type { Config, HarnessSource, HarnessUpdate, SourceDeps } from '../../types.js'
import {
  DEAD_PID,
  ENCRYPTED_SENTINEL,
  FAKE_COMMAND_SECRET,
  FAKE_TOKEN,
  OPAQUE_SENTINEL,
  createCopilotFixture,
  seedCopilotFleet,
  type CopilotFleet,
} from '../../../../test/fixtures/copilot.js'
import { createCopilotSource } from './source.js'
import { parseWorkspaceYaml } from './workspace.js'

let tmp: string
let sources: HarnessSource[] = []
const logs: string[] = []

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'copilot-'))
})
afterEach(async () => {
  for (const s of sources) await s.stop()
  sources = []
  logs.length = 0
  rmSync(tmp, { recursive: true, force: true })
})

function make(copilotDir: string | null, over: Partial<Config> = {}, pollMs = 25): { src: HarnessSource; updates: HarnessUpdate[] } {
  const log = { debug: () => {}, info: () => {}, warn: (m: string) => void logs.push(m), error: (m: string) => void logs.push(m) }
  const config = { copilotDir, windowMs: 30 * 86_400_000, mcpServers: [], ...over } as Config
  const deps: SourceDeps = { config, log, now: () => Date.now() }
  const src = createCopilotSource(deps, { pollMs })
  sources.push(src)
  const updates: HarnessUpdate[] = []
  src.subscribe((u) => updates.push(u))
  return { src, updates }
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const t = Date.now()
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('workspace.yaml parser', () => {
  it('parses top-level scalars, quotes and ignores nested/unknown keys', () => {
    const ws = parseWorkspaceYaml(
      ['id: abc', 'cwd: /a/b', 'name: "Hello: \\"world\\""', "client_name: 'cli'", 'user_named: true', 'summary_count: 4', 'created_at: 2026-09-29T08:54:01.360Z', 'nested:', '  name: nope', 'branch: main'].join('\n'),
    )
    expect(ws).toMatchObject({ id: 'abc', cwd: '/a/b', name: 'Hello: "world"', clientName: 'cli', userNamed: true, summaryCount: 4, createdAt: '2026-09-29T08:54:01.360Z' })
  })
})

describe('discovery & safety', () => {
  it('reports disabled / missing and returns empty data', async () => {
    const a = make(null)
    await a.src.start()
    expect(a.src.health().status).toBe('disabled')
    expect(a.src.listSessions(0)).toEqual([])
    const b = make(path.join(tmp, 'nope'))
    await b.src.start()
    expect(b.src.health().status).toBe('missing')
    expect(b.src.getSession('x')).toBeNull()
    expect(b.src.getTranscript('x', { limit: 5 }).messages).toEqual([])
  })

  it('never reads decoy files (unreadable) and never leaks their token', async () => {
    const fleet = seedCopilotFleet(tmp)
    const { src } = make(tmp)
    await src.start()
    const all = JSON.stringify([src.listSessions(0), src.recentActivity({ sinceMs: 0, limit: 1000 }), src.health()])
    expect(all).not.toContain(FAKE_TOKEN)
    expect(logs.filter((l) => /EACCES|config|permission denied/i.test(l))).toEqual([])
    expect(fleet.decoys.length).toBeGreaterThan(0)
    expect(src.listSessions(0)).toHaveLength(2)
    // source code references none of the forbidden files
    const code = ['source.ts', 'model.ts', 'workspace.ts'].map((f) => readFileSync(path.join(__dirname, f), 'utf8')).join('\n')
    for (const bad of ['config.json', 'command-history-state', 'session-store', "'logs'", "'ide'"]) expect(code).not.toContain(bad)
  })

  it('never emits encrypted / opaque reasoning fields or secrets', async () => {
    seedCopilotFleet(tmp)
    const { src } = make(tmp)
    await src.start()
    const ids = src.listSessions(0).map((s) => s.id)
    const blob = JSON.stringify([
      src.recentActivity({ sinceMs: 0, limit: 1000 }),
      ids.map((i) => src.getTranscript(i, { limit: 100 })),
      ids.flatMap((i) => src.recentActivity({ sinceMs: 0, limit: 1000 }).map((e) => src.getPart(e.id))),
    ])
    expect(blob).not.toContain(ENCRYPTED_SENTINEL)
    expect(blob).not.toContain(OPAQUE_SENTINEL)
    expect(blob).not.toContain(FAKE_COMMAND_SECRET)
    expect(blob).not.toContain('transformedContent')
    expect(blob).toContain('[redacted]')
  })
})

describe('session derivation', () => {
  let fleet: CopilotFleet
  let src: HarnessSource
  beforeEach(async () => {
    fleet = seedCopilotFleet(tmp)
    src = make(tmp).src
    await src.start()
  })

  it('finished session', () => {
    const s = src.getSession(fleet.finishedId)!
    expect(s).toMatchObject({
      harness: 'copilot',
      parentId: null,
      agent: 'copilot',
      title: 'Fix the login bug',
      directory: '/work/repo',
      transcriptState: 'done',
      processAlive: false,
      current: null,
      cost: 0,
      model: { providerId: 'github-copilot', modelId: 'claude-sonnet-5.5' },
      lastMessage: 'Fixed the bug.',
    })
    expect(s.lastPrompt).toContain('Please fix the login bug')
    expect(s.facts).toEqual([
      { label: 'Copilot version', value: '1.0.40' },
      { label: 'Premium requests', value: '3' },
      { label: 'Model routing', value: 'claude-sonnet-5.5' },
    ])
  })

  it('live session: waiting on permission, running bash, process alive, title from prompt', () => {
    const s = src.getSession(fleet.liveId)!
    expect(s.title).toBe('Run the full test suite')
    expect(s.transcriptState).toBe('waiting')
    expect(s.processAlive).toBe(true)
    expect(s.directory).toBe('/work/other')
    expect(s.model?.modelId).toBe('gpt-5')
    expect(s.current).toMatchObject({ kind: 'tool', label: 'bash', detail: 'npm run test:all', activityId: `copilot:${fleet.liveId}:tool:${fleet.liveBashCall}` })
  })

  it('stale lock counts as not alive; no name & no prompt → default title; thinking when turn open', async () => {
    const fx = createCopilotFixture(tmp)
    const id = 'cccccccc-0000-4000-8000-000000000003'
    fx.createSession(id, { workspace: false, events: [fx.ev.sessionStart(), fx.ev.turnStart('1')] })
    fx.lock(id, DEAD_PID)
    const s2 = make(tmp).src
    await s2.start()
    const s = s2.getSession(id)!
    expect(s.title).toBe('Copilot session')
    expect(s.processAlive).toBe(false)
    expect(s.transcriptState).toBe('working')
    expect(s.current).toMatchObject({ kind: 'thinking', label: 'Thinking' })
  })

  it('error / abort after the last turn → error; shutdown after turn → not working', async () => {
    const fx = createCopilotFixture(tmp)
    fx.createSession('d1', { events: [fx.ev.sessionStart(), fx.ev.user('hi'), fx.ev.turnStart('1'), fx.ev.error('boom ghp_FAKEsecretInsideCommand0123456789ABCDEF')] })
    fx.createSession('d2', { events: [fx.ev.sessionStart(), fx.ev.turnStart('1'), fx.ev.shutdown()] })
    fx.createSession('d3', { events: [fx.ev.sessionStart()] })
    const s2 = make(tmp).src
    await s2.start()
    expect(s2.getSession('d1')!.transcriptState).toBe('error')
    expect(s2.getSession('d2')!.transcriptState).toBe('unknown')
    expect(s2.getSession('d3')!.transcriptState).toBe('unknown')
    const err = s2.getActivity(['d1'], { limit: 10 }).events.find((e) => e.kind === 'error')!
    expect(err.status).toBe('error')
    expect(JSON.stringify(err)).not.toContain('FAKEsecret')
  })

  it('window: old sessions are listed lazily', async () => {
    fleet.fixture.createSession('old-1', { events: [fleet.fixture.ev.sessionStart(), fleet.fixture.ev.user('ancient')] })
    const old = new Date(Date.now() - 90 * 86_400_000)
    utimesSync(path.join(fleet.fixture.sessionState, 'old-1', 'events.jsonl'), old, old)
    const s2 = make(tmp, { windowMs: 86_400_000 }).src
    await s2.start()
    expect(s2.listSessions(Date.now() - 86_400_000).map((s) => s.id).sort()).toEqual([fleet.finishedId, fleet.liveId].sort())
    // lazy load on demand
    expect(s2.getSession('old-1')!.title).toBe('ancient')
  })
})

describe('event normalization', () => {
  let fleet: CopilotFleet
  let src: HarnessSource
  const evs = (): ActivityEvent[] => src.getActivity([fleet.finishedId], { limit: 500 }).events
  beforeEach(async () => {
    fleet = seedCopilotFleet(tmp)
    src = make(tmp).src
    await src.start()
  })

  it('emits expected kinds with ids merged per tool call', () => {
    const kinds = evs().map((e) => e.kind)
    expect(kinds).toContain('prompt')
    expect(kinds).toContain('thinking')
    expect(kinds).toContain('text')
    expect(kinds).toContain('mcp')
    expect(kinds).toContain('permission')
    expect(kinds.filter((k) => k === 'file-change')).toHaveLength(3)
    const ids = evs().map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const bash = evs().find((e) => e.id === `copilot:${fleet.finishedId}:tool:${fleet.calls.bash}`)!
    expect(bash).toMatchObject({ kind: 'tool', status: 'completed', harness: 'copilot', source: 'copilot.events', rootId: fleet.finishedId })
    expect(bash.tool).toMatchObject({ name: 'bash', category: 'shell', callId: fleet.calls.bash, output: 'all tests passed' })
    expect(bash.tool!.durationMs).toBeGreaterThan(0)
    expect(bash.endTs).not.toBeNull()
    expect(bash.rev).toBeGreaterThanOrEqual(bash.ts)
    expect(bash.title.startsWith('bash · echo ')).toBe(true)
    expect(bash.tool!.input).not.toContain('FAKEsecret')
  })

  it('tool previews, files, MCP and failures', () => {
    const by = (c: string) => evs().find((e) => e.tool?.callId === c)!
    expect(by(fleet.calls.view).tool).toMatchObject({ category: 'read', input: '/work/repo/src/app.ts' })
    expect(by(fleet.calls.view).files).toEqual(['/work/repo/src/app.ts'])
    expect(by(fleet.calls.rg).tool).toMatchObject({ category: 'search', input: 'login' })
    expect(by(fleet.calls.create)).toMatchObject({ kind: 'file-change', title: 'Created /work/repo/src/new.ts' })
    expect(by(fleet.calls.patch)).toMatchObject({ kind: 'file-change', files: ['/work/repo/src/app.ts'] })
    const mcp = by(fleet.calls.mcp)
    expect(mcp).toMatchObject({ kind: 'mcp' })
    expect(mcp.tool).toMatchObject({ name: 'github-mcp-server-get_issue', category: 'mcp', mcpServer: 'github' })
    expect(mcp.links).toContain('https://github.com/acme/repo/issues/42')
    const failed = by(fleet.calls.failed)
    expect(failed).toMatchObject({ kind: 'tool', status: 'error' })
    expect(failed.tool!.error).toBe('exit code 1')
    const prompt = evs().find((e) => e.kind === 'prompt')!
    expect(prompt.links).toEqual(['https://example.com/issues/42'])
  })

  it('permission request resolves in place', () => {
    const perm = evs().find((e) => e.kind === 'permission')!
    expect(perm.id).toBe(`copilot:${fleet.finishedId}:perm:perm-1`)
    expect(perm).toMatchObject({ status: 'completed' })
    expect(perm.title).toContain('bash')
    const live = src.getActivity([fleet.liveId], { limit: 50 }).events.find((e) => e.kind === 'permission')!
    expect(live).toMatchObject({ status: 'pending', title: 'Permission requested · bash' })
  })

  it('getPart returns full redacted detail', () => {
    const p = src.getPart(`copilot:${fleet.finishedId}:tool:${fleet.calls.bash}`)!
    expect(p).toMatchObject({ kind: 'tool', output: 'all tests passed' })
    expect(JSON.stringify(p.input)).not.toContain('FAKEsecret')
    expect(src.getPart('copilot:nope:x')).toBeNull()
    expect(src.getPart('garbage')).toBeNull()
  })
})

describe('queries', () => {
  let fleet: CopilotFleet
  let src: HarnessSource
  beforeEach(async () => {
    fleet = seedCopilotFleet(tmp)
    src = make(tmp).src
    await src.start()
  })

  it('counters and tool stats', () => {
    expect(src.getCounters(fleet.finishedId)).toEqual({ messages: 2, steps: 1, thinking: 1, tools: 8, toolErrors: 1, mcpCalls: 1, fileChanges: 3, filesTouched: 3, subagents: 0 })
    const stats = src.getToolStats([fleet.finishedId])
    expect(stats.find((s) => s.name === 'bash')).toMatchObject({ calls: 2, errors: 1, category: 'shell' })
    expect(stats.find((s) => s.name === 'github-mcp-server-get_issue')).toMatchObject({ category: 'mcp', mcpServer: 'github' })
    expect(src.getTodos(fleet.finishedId)).toEqual([])
    expect(src.getChildren(fleet.finishedId)).toEqual([])
  })

  it('transcript groups by turn and pages by message', () => {
    const t = src.getTranscript(fleet.finishedId, { limit: 10 })
    expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const a = t.messages[1]!
    expect(a.finish).toBe('stop')
    expect(a.items.map((i) => i.kind)).toEqual(['thinking', 'text', 'tool', 'tool', 'tool', 'permission', 'file-change', 'file-change', 'file-change', 'mcp', 'tool', 'text'])
    expect(t.hasMore).toBe(false)
    const p1 = src.getTranscript(fleet.finishedId, { limit: 1 })
    expect(p1.messages.map((m) => m.role)).toEqual(['assistant'])
    expect(p1.hasMore).toBe(true)
    const p2 = src.getTranscript(fleet.finishedId, { limit: 1, before: p1.before! })
    expect(p2.messages.map((m) => m.role)).toEqual(['user'])
    expect(p2.hasMore).toBe(false)
  })

  it('activity paging, kinds filter and recentActivity', () => {
    const all = src.getActivity([fleet.finishedId], { limit: 1000 })
    const p1 = src.getActivity([fleet.finishedId], { limit: 5 })
    expect(p1.hasMore).toBe(true)
    expect(p1.events.map((e) => e.id)).toEqual(all.events.slice(-5).map((e) => e.id))
    const p2 = src.getActivity([fleet.finishedId], { limit: 5, before: p1.before! })
    expect(p2.events.map((e) => e.id)).toEqual(all.events.slice(-10, -5).map((e) => e.id))
    expect(src.getActivity([fleet.finishedId], { limit: 50, kinds: ['mcp'] }).events).toHaveLength(1)
    const recent = src.recentActivity({ sinceMs: 0, limit: 1000 })
    expect(recent.length).toBe(all.events.length + src.getActivity([fleet.liveId], { limit: 100 }).events.length)
    expect(recent.map((e) => e.ts)).toEqual([...recent.map((e) => e.ts)].sort((a, b) => a - b))
  })

  it('file changes and diffs', () => {
    const fc = src.getFileChanges([fleet.finishedId])
    expect(fc.map((c) => [c.kind, c.path, c.additions, c.deletions, c.relPath])).toEqual([
      ['create', '/work/repo/src/new.ts', 1, 0, 'src/new.ts'],
      ['edit', '/work/repo/src/app.ts', 1, 1, 'src/app.ts'],
      ['patch', '/work/repo/src/app.ts', 1, 1, 'src/app.ts'],
    ])
    const id = (c: string) => `copilot:${fleet.finishedId}:tool:${c}`
    expect(src.getDiff(id(fleet.calls.create))).toMatchObject({ format: 'new-file', text: 'export const x = 1\n' })
    expect(src.getDiff(id(fleet.calls.patch))).toMatchObject({ format: 'patch-text' })
    expect(src.getDiff(id(fleet.calls.edit))!.text).toContain('-old\n+new')
    expect(src.getDiff(id(fleet.calls.edit))!.format).toBe('unified')
    expect(src.getDiff(id(fleet.calls.bash))).toBeNull()
    expect(src.getFileChanges([fleet.finishedId], Date.now() + 1000)).toEqual([])
  })
})

describe('incremental tail', () => {
  it('emits only new events, buffers partial lines, detects new sessions, handles rotation', async () => {
    const fx = createCopilotFixture(tmp)
    const id = 'e0e0e0e0-0000-4000-8000-000000000001'
    fx.createSession(id, { events: [fx.ev.sessionStart(), fx.ev.user('first')] })
    fx.lock(id)
    const { src, updates } = make(tmp)
    await src.start()
    expect(src.getSession(id)!.transcriptState).toBe('unknown')

    // partial line: nothing consumed until the newline arrives
    const e1 = fx.ev.turnStart('1')
    const e2 = fx.ev.toolStart('c1', 'bash', { command: 'ls' })
    const line = JSON.stringify(e2)
    fx.append(id, [e1])
    fx.appendRaw(id, line.slice(0, 30))
    await until(() => updates.some((u) => u.type === 'sessions'))
    expect(src.getSession(id)!.transcriptState).toBe('working')
    expect(src.getActivity([id], { limit: 50 }).events.some((e) => e.tool?.callId === 'c1')).toBe(false)
    updates.length = 0
    fx.appendRaw(id, line.slice(30) + '\n')
    await until(() => updates.some((u) => u.type === 'activity'))
    const act = updates.filter((u): u is Extract<HarnessUpdate, { type: 'activity' }> => u.type === 'activity')
    expect(act).toHaveLength(1)
    expect(act[0]!.events.map((e) => e.id)).toEqual([`copilot:${id}:tool:c1`])
    expect(src.getSession(id)!.current?.label).toBe('bash')

    // completion merges into the same activity id with a higher rev
    updates.length = 0
    fx.append(id, [fx.ev.toolComplete('c1', { result: { content: 'a b' } }), fx.ev.turnEnd('1')])
    await until(() => updates.some((u) => u.type === 'activity'))
    const merged = (updates.find((u) => u.type === 'activity') as Extract<HarnessUpdate, { type: 'activity' }>).events
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: `copilot:${id}:tool:c1`, status: 'completed' })
    expect(src.getSession(id)!.transcriptState).toBe('done')

    // lock removal flips processAlive
    updates.length = 0
    fx.unlock(id)
    await until(() => updates.some((u) => u.type === 'sessions'))
    expect(src.getSession(id)!.processAlive).toBe(false)

    // new session directory
    updates.length = 0
    const id2 = 'e1e1e1e1-0000-4000-8000-000000000002'
    fx.createSession(id2, { events: [fx.ev.sessionStart(), fx.ev.user('brand new')] })
    await until(() => updates.some((u) => u.type === 'sessions' && u.sessions.some((s) => s.id === id2)))
    await until(() => updates.some((u) => u.type === 'activity'))
    const created = updates.find((u) => u.type === 'activity') as Extract<HarnessUpdate, { type: 'activity' }>
    expect(created.events.some((e) => e.kind === 'prompt')).toBe(true)
    expect(src.listSessions(0).map((s) => s.id)).toContain(id2)

    // rotation / truncation → reset + full reparse
    updates.length = 0
    fx.rewrite(id, [fx.ev.sessionStart(), fx.ev.user('rotated')])
    await until(() => updates.some((u) => u.type === 'reset'))
    expect(src.getSession(id)!.title).toBe('rotated')
    expect(src.getActivity([id], { limit: 50 }).events.map((e) => e.kind)).toEqual(['prompt'])
  })

  it('isolates a corrupt file and survives bad lines', async () => {
    const fx = createCopilotFixture(tmp)
    fx.createSession('bad', { events: [fx.ev.sessionStart()] })
    fx.appendRaw('bad', 'not json\n{"type":1}\n[]\n')
    fx.append('bad', [fx.ev.user('still works')])
    fx.createSession('good', { events: [fx.ev.sessionStart(), fx.ev.user('fine')] })
    const { src } = make(tmp)
    await src.start()
    expect(src.getSession('bad')!.title).toBe('still works')
    expect(src.getSession('good')!.title).toBe('fine')
    expect(src.health().status).toBe('ok')
  })

  it('start is idempotent and stop halts polling', async () => {
    const fx = createCopilotFixture(tmp)
    fx.createSession('s', { events: [fx.ev.sessionStart(), fx.ev.user('x')] })
    const { src, updates } = make(tmp)
    await src.start()
    await src.start()
    await src.stop()
    fx.append('s', [fx.ev.user('later')])
    await new Promise((r) => setTimeout(r, 120))
    expect(updates).toEqual([])
    expect(statSync(path.join(fx.sessionState, 's', 'events.jsonl')).size).toBeGreaterThan(0)
  })
})

describe('mcp config', () => {
  it('honours configured mcp server prefixes', async () => {
    const fx = createCopilotFixture(tmp)
    fx.createSession('m', { events: [fx.ev.sessionStart(), fx.ev.turnStart('1'), fx.ev.toolStart('c', 'acme-widgets_list', {}), fx.ev.toolComplete('c')] })
    const { src } = make(tmp, { mcpServers: ['acme-widgets'] })
    await src.start()
    expect(src.getActivity(['m'], { limit: 10 }).events[0]!.tool).toMatchObject({ category: 'mcp', mcpServer: 'acme-widgets', displayName: 'list' })
  })
})


describe('model eviction', () => {
  it('evicts idle models LRU, keeps snapshots, reloads on demand', async () => {
    const fx = createCopilotFixture(tmp)
    const old = new Date(Date.now() - 90 * 86_400_000)
    for (let i = 0; i < 55; i++) {
      fx.createSession(`o-${i}`, { events: [fx.ev.sessionStart(), fx.ev.user(`prompt ${i}`)] })
      utimesSync(path.join(fx.sessionState, `o-${i}`, 'events.jsonl'), old, old)
    }
    const { src } = make(tmp, { windowMs: 86_400_000 })
    await src.start()
    for (let i = 0; i < 55; i++) expect(src.getSession(`o-${i}`)!.title).toBe(`prompt ${i}`)
    await until(() => (src.health().detail ?? '').includes('50 parsed'))
    // evicted (oldest-used) entries still list from snapshot when asked, and reload on demand
    expect(src.listSessions(0)).toHaveLength(55)
    expect(src.getSession('o-0')!.title).toBe('prompt 0')
    expect(src.getCounters('o-0').messages).toBeGreaterThan(0)
  })
})

describe('liveness without per-tick relisting', () => {
  it('lock added then removed flips alive', async () => {
    const fx = createCopilotFixture(tmp)
    fx.createSession('l', { events: [fx.ev.sessionStart(), fx.ev.user('hi')] })
    const { src } = make(tmp)
    await src.start()
    expect(src.getSession('l')!.processAlive).toBe(false)
    fx.lock('l', process.pid)
    await until(() => src.getSession('l')!.processAlive === true)
    fx.unlock('l', process.pid)
    await until(() => src.getSession('l')!.processAlive === false)
  })
})

describe('usage extraction', () => {
  it('maps calls, sums tokens, drops sensitive data, honours sinceMs', async () => {
    const fleet = seedCopilotFleet(tmp)
    const { src } = make(tmp)
    await src.start()
    const s = src.getUsageSamples!([fleet.finishedId, fleet.liveId])
    expect(s.map((x) => x.id)).toEqual(expect.arrayContaining([`copilot:${fleet.finishedId}:call:mc-1`]))
    const a = s.find((x) => x.id.endsWith('mc-1'))!
    expect(a.tokens).toEqual({ input: 600, cacheRead: 400, cacheWrite: 0, reasoning: 20, output: 100 })
    expect(a).toMatchObject({ aiu: 2, ttftMs: 350, durationMs: 3000, cost: null, agent: 'copilot', source: 'copilot.model_call_success', model: { providerId: 'github-copilot', modelId: 'claude-sonnet-5.5' } })
    expect([...s].sort((x, y) => x.ts - y.ts)).toEqual(s)
    expect(src.getUsageSamples!([fleet.finishedId], { sinceMs: a.ts + 1 })).toHaveLength(1)
    const fin = src.getSession(fleet.finishedId)!
    expect(fin.tokens).toEqual({ input: 600 + 500, cacheRead: 1400, cacheWrite: 0, reasoning: 20, output: 100 + 80 })
    expect(fin.cost).toBe(0)
    const all = JSON.stringify([s, src.listSessions(0), src.recentActivity({ sinceMs: 0, limit: 1000 })])
    expect(all).not.toContain('SECRET_PROMPT_SENTINEL')
    expect(all).not.toContain('123456')
  })

  it('emits live in-flight estimates and samples', async () => {
    const fleet = seedCopilotFleet(tmp)
    const { src, updates } = make(tmp)
    await src.start()
    const fx = fleet.fixture
    fx.append(fleet.liveId, [fx.ev.modelCallSuccess({ prompt: 100, completion: 10, nanoAiu: 1e9, callId: 'live-2', turn: 1 })])
    await until(() => updates.some((u) => u.type === 'usage' && u.samples.length > 0))
    const us = updates.filter((u): u is Extract<HarnessUpdate, { type: 'usage' }> => u.type === 'usage')
    expect(us.flatMap((u) => u.samples).map((x) => x.id)).toEqual([`copilot:${fleet.liveId}:call:live-2`])
    expect(us.flatMap((u) => u.estimates).at(-1)).toMatchObject({ inFlight: false, sessionId: fleet.liveId })
    fx.append(fleet.liveId, [fx.ev.modelCallStarted({ turn: 2 })])
    await until(() => updates.some((u) => u.type === 'usage' && u.estimates.some((x) => x.inFlight)))
    fx.append(fleet.liveId, [fx.ev.abort('stop')])
    await until(() => updates.filter((u) => u.type === 'usage').some((u) => u.estimates.some((x) => !x.inFlight && x.startedAt > 0) && u !== us[0]))
  })

  it('shows shutdown facts', async () => {
    const fx = createCopilotFixture(tmp)
    fx.createSession('s1', { events: [fx.ev.sessionStart(), fx.ev.shutdown({ systemTokens: 1200, toolDefinitionsTokens: 3400, conversationTokens: 56000, totalApiDurationMs: 4200 })] })
    const { src } = make(tmp)
    await src.start()
    const facts = src.getSession('s1')!.facts
    expect(facts).toContainEqual({ label: 'Context (system · tools · conversation)', value: '1,200 · 3,400 · 56,000' })
    expect(facts).toContainEqual({ label: 'API time', value: '4200 ms' })
  })
})
