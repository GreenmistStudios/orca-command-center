import { renameSync, writeFileSync } from 'node:fs'
import type { CliRunner } from '../../src/server/types.js'

/* Sanitized, synthetic fixtures modeled on the real `orca ... --json` envelopes. */

export const STATUS_JSON = JSON.stringify({
  id: 'fx-status',
  ok: true,
  result: {
    target: { kind: 'local' },
    app: { running: true, pid: 4242, desktopWindowStatus: 'available' },
    runtime: { state: 'ready', reachable: true, appVersion: '1.4.0', capabilities: ['a.v1', 'b.v1'] },
  },
})

export const STATUS_NOT_RUNNING_JSON = JSON.stringify({
  id: 'fx-status',
  ok: true,
  result: { app: { running: false, pid: null }, runtime: { state: 'stopped', reachable: false, appVersion: null } },
})

export const ERROR_JSON = JSON.stringify({ id: 'fx-err', ok: false, error: { code: 'runtime_unavailable', message: 'Orca runtime is not reachable' } })

export const WORKTREE_PS_JSON = JSON.stringify({
  id: 'fx-wt',
  ok: true,
  result: {
    worktrees: [
      {
        worktreeId: 'repo-1::/work/acme/feature-x',
        repoId: 'repo-1',
        repo: 'acme',
        path: '/work/acme/feature-x',
        branch: 'refs/heads/me/feature-x',
        isArchived: false,
        isMainWorktree: false,
        displayName: 'feature-x',
        workspaceStatus: 'in-progress',
        status: 'active',
        lastActivityAt: 1_700_000_100_000,
        linkedIssue: null,
        linkedPR: { number: 42, state: 'draft', title: 'feat: x', url: 'https://github.com/acme/acme/pull/42' },
        linkedItems: [{ provider: 'github', type: 'pr', number: 42, url: 'https://github.com/acme/acme/pull/42' }],
        isActive: true,
        liveTerminalCount: 2,
        lastOutputAt: 1_700_000_090_000,
        preview: 'ignored',
      },
      {
        worktreeId: 'repo-1::/work/acme',
        repoId: 'repo-1',
        repo: 'acme',
        path: '/work/acme',
        branch: 'refs/heads/main',
        isArchived: false,
        isMainWorktree: true,
        displayName: 'acme',
        workspaceStatus: 'todo',
        isActive: false,
        liveTerminalCount: 1,
        lastActivityAt: 1_700_000_000_000,
        lastOutputAt: null,
        linkedIssue: 7,
      },
      {
        worktreeId: 'repo-1::/work/acme/old-branch',
        repoId: 'repo-1',
        repo: 'acme',
        path: '/work/acme/old-branch',
        branch: 'refs/heads/me/old-branch',
        isArchived: true,
        isMainWorktree: false,
        displayName: 'old-branch',
        workspaceStatus: 'done',
        isActive: false,
        liveTerminalCount: 0,
        lastActivityAt: 1_699_000_000_000,
        lastOutputAt: null,
      },
    ],
  },
})

export const FAKE_TOKEN = 'ghp_' + 'FAKE0123456789abcdefghijklmnopqrstuv'

export const TERMINAL_LIST_JSON = JSON.stringify({
  id: 'fx-term',
  ok: true,
  result: {
    terminals: [
      {
        handle: 'term_aaaa',
        worktreeId: 'repo-1::/work/acme/feature-x',
        worktreePath: '/work/acme/feature-x',
        branch: 'refs/heads/me/feature-x',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        title: 'opencode',
        connected: true,
        lastOutputAt: 1_700_000_090_000,
        preview: 'Working on the task…',
        agentIdentity: 'opencode',
      },
      {
        handle: 'term_bbbb',
        worktreeId: 'repo-1::/work/acme/feature-x',
        worktreePath: '/work/acme/feature-x',
        tabId: 'tab-2',
        leafId: 'leaf-2',
        title: '~/acme',
        connected: true,
        lastOutputAt: 1_700_000_080_000,
        preview: '$ ls\nREADME.md',
      },
      {
        handle: 'term_cccc',
        worktreeId: 'repo-1::/work/acme',
        worktreePath: '/work/acme',
        tabId: 'tab-3',
        leafId: 'leaf-3',
        title: 'build',
        connected: true,
        lastOutputAt: 1_700_000_070_000,
        preview: `\u001b[32mOK\u001b[0m \u001b[1;31mexport GH_TOKEN=${FAKE_TOKEN}\u001b[0m\n`,
      },
      {
        handle: 'term_dddd',
        worktreeId: 'global-floating-terminal',
        worktreePath: '',
        tabId: 'tab-4',
        leafId: null,
        title: '~',
        connected: false,
        lastOutputAt: null,
        preview: '',
      },
    ],
  },
})

export type FakeResponse = { stdout?: string; stderr?: string; exitCode?: number | null; delayMs?: number; throws?: string }
export type FakeResponses = Record<string, FakeResponse | FakeResponse[] | ((n: number) => FakeResponse)>

/**
 * Fake CliRunner. Keys are `args.join(' ')`, e.g. 'status --json'. An array is consumed in order
 * (last repeats); a function receives the 0-based call count. Unknown commands throw.
 */
export function fakeRunner(responses: FakeResponses): CliRunner & { calls: string[][]; setResponses(r: FakeResponses): void } {
  let current = responses
  const counts = new Map<string, number>()
  const calls: string[][] = []
  const runner = (async (_exe: string, args: string[]) => {
    calls.push([...args])
    const key = args.join(' ')
    const spec = current[key]
    if (!spec) throw new Error(`fakeRunner: no response for "${key}"`)
    const n = counts.get(key) ?? 0
    counts.set(key, n + 1)
    const r = typeof spec === 'function' ? spec(n) : Array.isArray(spec) ? spec[Math.min(n, spec.length - 1)]! : spec
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs))
    if (r.throws) throw new Error(r.throws)
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode === undefined ? 0 : r.exitCode }
  }) as unknown as CliRunner & { calls: string[][]; setResponses(r: FakeResponses): void }
  runner.calls = calls
  runner.setResponses = (r) => {
    current = r
  }
  return runner
}

/** Healthy responses for all three commands. */
export function healthyResponses(): FakeResponses {
  return {
    'status --json': { stdout: STATUS_JSON },
    'worktree ps --json': { stdout: WORKTREE_PS_JSON },
    'terminal list --json': { stdout: TERMINAL_LIST_JSON },
  }
}

export interface RawHookEntry {
  paneKey: string
  tabId: string
  worktreeId: string
  source: string
  agentPresence: { agent: string }
  hookEventName: string
  providerSession: { key: string; id: string }
  payload: { state: string; prompt?: string; agentType?: string; lastAssistantMessage?: string }
  receivedAt: number
  stateStartedAt: number
  hostTurn: { owner: string; currentTurnKey: string }
  launchTokenHash: string
  [k: string]: unknown
}

/** Builds a realistic hook entry (incl. launchTokenHash / hostTurn that must be ignored). */
export function hookEntry(partial: Partial<RawHookEntry> & { paneKey?: string } = {}): RawHookEntry {
  const paneKey = partial.paneKey ?? 'tab-1:leaf-1'
  return {
    paneKey,
    tabId: paneKey.split(':')[0]!,
    worktreeId: 'repo-1::/work/acme/feature-x',
    source: 'opencode',
    agentPresence: { agent: 'opencode' },
    hookEventName: 'SessionBusy',
    providerSession: { key: 'session_id', id: 'ses_fake1' },
    payload: { state: 'working', prompt: 'Fix the failing test', agentType: 'opencode' },
    receivedAt: 1_700_000_000_000,
    stateStartedAt: 1_700_000_000_000,
    hostTurn: { owner: 'host', currentTurnKey: 'turn-fake' },
    launchTokenHash: 'deadbeef-fake-hash',
    ...partial,
  }
}

/** Atomic write (temp + rename) of `{version, entries, authorityCommitments}` like Orca does. */
export function writeHooksFile(path: string, entries: RawHookEntry[], version: number = 2): void {
  const map: Record<string, RawHookEntry> = {}
  for (const e of entries) map[e.paneKey] = e
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, JSON.stringify({ version, entries: map, authorityCommitments: { fake: { hash: 'x' } } }))
  renameSync(tmp, path)
}
