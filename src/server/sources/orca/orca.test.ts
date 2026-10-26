import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, SourceDeps } from '../../types.js'
import type { ActivityEvent, HookEntry } from '../../../shared/contract.js'
import { parseStatus, parseTerminals, parseWorktrees } from './parse.js'
import { START_WAIT_MS, createOrcaCliSource } from './cli-source.js'
import { createOrcaHooksSource } from './hooks-source.js'
import { CLI_ALLOWLIST, assertAllowed } from './runner.js'
import {
  ERROR_JSON, FAKE_TOKEN, STATUS_JSON, STATUS_NOT_RUNNING_JSON, TERMINAL_LIST_JSON, WORKTREE_PS_JSON,
  fakeRunner, healthyResponses, hookEntry, writeHooksFile,
} from '../../../../test/fixtures/orca.js'

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

const log = { debug() {}, info() {}, warn() {}, error() {} }
const mkDeps = (over: Partial<Config>, now = () => Date.now()): SourceDeps => ({
  config: { orcaPollMs: 5000, orcaCli: '/bin/orca', hooksFile: null, ...over } as Config,
  log,
  now,
})

describe('parsers', () => {
  it('parses status', () => {
    expect(parseStatus(STATUS_JSON, 5)).toEqual({ running: true, reachable: true, pid: 4242, version: '1.4.0', runtimeState: 'ready', checkedAt: 5, error: null })
    expect(parseStatus(ERROR_JSON, 5).error).toBe('Orca runtime is not reachable')
    expect(parseStatus('garbage', 5).running).toBe(false)
  })
  it('parses worktrees', () => {
    const { value } = parseWorktrees(WORKTREE_PS_JSON)
    expect(value).toHaveLength(3)
    expect(value[0]!.branch).toBe('me/feature-x')
    expect(value[0]!.links).toEqual([{ kind: 'pr', label: '#42', url: 'https://github.com/acme/acme/pull/42' }])
    expect(value[1]!.links).toEqual([{ kind: 'issue', label: '#7', url: null }])
    expect(value[0]!.liveTerminalCount).toBe(2)
  })
  it('parses terminals with redaction', () => {
    const { value } = parseTerminals(TERMINAL_LIST_JSON)
    expect(value).toHaveLength(4)
    expect(value[0]!.paneKey).toBe('tab-1:leaf-1')
    expect(value[3]!.paneKey).toBeNull()
    expect(value[2]!.preview).not.toContain('\u001b')
    expect(value[2]!.preview).not.toContain(FAKE_TOKEN)
    expect(value[0]!.sessionId).toBeNull()
    const long = JSON.stringify({ ok: true, result: { terminals: [{ handle: 'h', preview: 'x'.repeat(1000) }] } })
    expect(parseTerminals(long).value[0]!.preview!.length).toBeLessThanOrEqual(301)
  })
  it('tolerates drift', () => {
    expect(parseWorktrees(JSON.stringify({ ok: true, result: { worktrees: [1, null, { path: '/p', linkedPR: { weird: true }, linkedItems: 'x' }] } })).value).toHaveLength(1)
    expect(parseTerminals(JSON.stringify({ ok: true, result: {} })).value).toEqual([])
    expect(() => parseWorktrees('{')).not.toThrow()
  })
})

describe('cli source', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('disabled without cli', async () => {
    const runner = fakeRunner(healthyResponses())
    const s = createOrcaCliSource({ ...mkDeps({ orcaCli: null }), runner })
    await s.start()
    expect(s.health().status).toBe('disabled')
    expect(s.status().error).toBe('orca CLI not found')
    expect(runner.calls).toHaveLength(0)
  })

  it('polls, allowlist, emits changes', async () => {
    const runner = fakeRunner(healthyResponses())
    const s = createOrcaCliSource({ ...mkDeps({}), runner })
    const ups: string[] = []
    s.subscribe((u) => ups.push(u.type))
    await s.start()
    expect(ups).toEqual(['status', 'fleet'])
    expect(s.worktrees()).toHaveLength(3)
    expect(s.terminals()).toHaveLength(4)
    expect(s.health()).toMatchObject({ status: 'ok', detail: '3 worktrees · 4 terminals', version: '1.4.0' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(ups).toEqual(['status', 'fleet']) // unchanged
    const set = new Set(runner.calls.map((c) => c.join(' ')))
    expect([...set].sort()).toEqual(CLI_ALLOWLIST.map((a) => a.join(' ')).sort())
    expect(() => assertAllowed(['worktree', 'rm'])).toThrow()
    await s.stop()
  })

  it('start() does not block server boot on a hung first poll', async () => {
    const r = healthyResponses()
    r['status --json'] = (n) => ({ stdout: STATUS_JSON, delayMs: n === 0 ? 10_000 : 0 })
    const runner = fakeRunner(r)
    const s = createOrcaCliSource({ ...mkDeps({}), runner })
    const ups: string[] = []
    s.subscribe((u) => ups.push(u.type))
    let started = false
    void s.start().then(() => { started = true })
    await vi.advanceTimersByTimeAsync(START_WAIT_MS)
    expect(started).toBe(true)
    expect(s.status().checkedAt).toBe(0)
    // Nothing is published while the first poll is unresolved — no false "not running".
    expect(ups).toEqual([])
    await vi.advanceTimersByTimeAsync(12_000)
    expect(s.status().running).toBe(true)
    await s.stop()
  })

  it('does not overlap slow calls', async () => {
    const r = healthyResponses()
    r['status --json'] = (n) => ({ stdout: STATUS_JSON, delayMs: n === 0 ? 12000 : 0 })
    const runner = fakeRunner(r)
    const s = createOrcaCliSource({ ...mkDeps({}), runner })
    const p = s.start()
    await vi.advanceTimersByTimeAsync(11000)
    expect(runner.calls.filter((c) => c[0] === 'status')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(0)
    await p
    await vi.advanceTimersByTimeAsync(4000)
    expect(runner.calls.filter((c) => c[0] === 'status')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(runner.calls.filter((c) => c[0] === 'status')).toHaveLength(2)
    await s.stop()
  })

  it('keeps last good snapshot on failure and recovers', async () => {
    const runner = fakeRunner(healthyResponses())
    const s = createOrcaCliSource({ ...mkDeps({}), runner })
    await s.start()
    runner.setResponses({ ...healthyResponses(), 'status --json': { throws: 'timed out after 3000 ms' } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.health().status).toBe('error')
    expect(s.health().detail).toContain('timed out')
    expect(s.health().detail).toContain('showing data from')
    expect(s.worktrees()).toHaveLength(3)
    runner.setResponses(healthyResponses())
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.health().status).toBe('ok')
    await s.stop()
  })

  it('boot timeout then success within retries: first emitted status is running', async () => {
    const r = healthyResponses()
    r['status --json'] = (n) => (n < 2 ? { throws: 'timed out after 3000 ms' } : { stdout: STATUS_JSON })
    const runner = fakeRunner(r)
    const s = createOrcaCliSource({ ...mkDeps({}), runner })
    const ups: Array<{ type: string; running?: boolean }> = []
    s.subscribe((u) => ups.push({ type: u.type, running: u.type === 'status' ? u.status.running : undefined }))
    const p = s.start()
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(ups[0]).toEqual({ type: 'status', running: true })
    expect(s.status().running).toBe(true)
    await s.stop()
  })

  it('boot: reports unreachable after retries are exhausted', async () => {
    const runner = fakeRunner({ ...healthyResponses(), 'status --json': { throws: 'timed out after 3000 ms' } })
    const s = createOrcaCliSource({ ...mkDeps({}), runner })
    const p = s.start()
    await vi.advanceTimersByTimeAsync(5000)
    await p
    expect(runner.calls.filter((c) => c[0] === 'status')).toHaveLength(4)
    expect(s.status()).toMatchObject({ running: false, reachable: false, error: 'timed out after 3000 ms' })
    await s.stop()
  })

  it('previously running: 1-2 timeouts keep running with error; 3 report not running', async () => {
    const runner = fakeRunner(healthyResponses())
    const s = createOrcaCliSource({ ...mkDeps({}), runner })
    await s.start()
    runner.setResponses({ ...healthyResponses(), 'status --json': { throws: 'timed out after 3000 ms' } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.status()).toMatchObject({ running: true, pid: 4242, error: 'timed out after 3000 ms' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.status()).toMatchObject({ running: true, error: 'timed out after 3000 ms' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.status()).toMatchObject({ running: false, reachable: false, pid: null })
    runner.setResponses(healthyResponses())
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.status()).toMatchObject({ running: true, error: null })
    await s.stop()
  })

  it('clears fleet after 3 non-running polls', async () => {
    const runner = fakeRunner(healthyResponses())
    const s = createOrcaCliSource({ ...mkDeps({}), runner })
    const ups: string[] = []
    await s.start()
    s.subscribe((u) => ups.push(u.type))
    runner.setResponses({ ...healthyResponses(), 'status --json': { stdout: STATUS_NOT_RUNNING_JSON } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.status().running).toBe(false)
    expect(s.worktrees()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.worktrees()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.worktrees()).toHaveLength(0)
    expect(ups).toEqual(['status', 'fleet'])
    await s.stop()
  })
})

describe('hooks source', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'orca-hooks-'))
    file = path.join(dir, 'last-status.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const waitFor = async (cond: () => boolean, ms = 4000) => {
    const t = Date.now()
    while (!cond()) {
      if (Date.now() - t > ms) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  it('disabled without file', async () => {
    const s = createOrcaHooksSource(mkDeps({ hooksFile: null }))
    await s.start()
    expect(s.health().status).toBe('disabled')
  })

  it('baseline, transitions, permission, malformed recovery, never touches endpoint.env', async () => {
    writeFileSync(path.join(dir, 'endpoint.env'), 'SECRET=1')
    const spy = vi.mocked(fs.readFileSync)
    spy.mockClear()
    writeHooksFile(file, [hookEntry()])
    const s = createOrcaHooksSource(mkDeps({ hooksFile: file }))
    const updates: { entries: HookEntry[]; transitions: ActivityEvent[] }[] = []
    s.subscribe((u) => updates.push(u))
    await s.start()
    expect(s.entries()).toHaveLength(1)
    expect(s.entries()[0]).toMatchObject({ agent: 'opencode', hookEvent: 'SessionBusy', state: 'working', providerSessionId: 'ses_fake1', prompt: 'Fix the failing test' })
    expect(JSON.stringify(s.entries())).not.toContain('deadbeef')
    expect(updates[0]!.transitions).toEqual([])
    expect(s.health().detail).toBe('1 panes · 1 working')

    writeHooksFile(file, [hookEntry({ hookEventName: 'SessionIdle', payload: { state: 'done', lastAssistantMessage: 'All done' }, receivedAt: 1_700_000_005_000 })])
    await waitFor(() => updates.length >= 2)
    const t = updates[1]!.transitions[0]!
    expect(t).toMatchObject({ id: 'orca-hook:tab-1:leaf-1:1700000005000', kind: 'state', title: 'Finished turn', summary: 'All done', harness: 'opencode', sessionId: 'ses_fake1', source: 'orca.hooks', rev: 1_700_000_005_000 })

    writeHooksFile(file, [hookEntry({ hookEventName: 'PermissionRequest', payload: { state: 'blocked' }, receivedAt: 1_700_000_009_000 })])
    await waitFor(() => updates.length >= 3)
    expect(updates[2]!.transitions[0]!.kind).toBe('permission')

    writeFileSync(file, '{"version":2,"entr')
    await new Promise((r) => setTimeout(r, 400))
    expect(s.entries()).toHaveLength(1)
    writeHooksFile(file, [hookEntry({ receivedAt: 1_700_000_020_000 })])
    await waitFor(() => updates.length >= 4)
    expect(updates[3]!.transitions).toHaveLength(1)

    const opened = spy.mock.calls.map((c) => String(c[0]))
    expect(opened.every((p) => !p.endsWith('endpoint.env'))).toBe(true)
    await s.stop()
  })

  it('degraded on unknown version', async () => {
    writeHooksFile(file, [hookEntry()], 3)
    const s = createOrcaHooksSource(mkDeps({ hooksFile: file }))
    await s.start()
    expect(s.health().status).toBe('degraded')
    expect(s.health().detail).toBe('hook file version 3, expected 2')
    expect(s.entries()).toHaveLength(1)
    await s.stop()
  })
})
