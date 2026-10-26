/**
 * Deterministic mock fleet for `?mock=1`. Pure data builders (no timers); `mock.ts` serves it.
 * See `buildMockWorld` for the fleet description (ids, titles, states).
 */
import type {
  ActivityEvent, ActivityKind, ActivityStatus, AgentState, Artifact, AttentionItem, FileChange, FileDiff,
  Harness, HookEntry, OrchDispatch, OrchGate, OrchMessage, OrchRun, OrchRunDetail, OrchTask,
  OrcaSnapshot, ServerMeta, SessionSummary, SourceHealth, StateSource, TerminalInfo, TodoItem,
  ToolCategory, ToolCallInfo, TokenUsage, WorkspaceRef, WorktreeInfo, OrchestrationSummary,
} from '../../shared/contract'

const MIN = 60_000

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Mutable mock world: everything the REST/stream surface serves. */
export interface MockWorld {
  now: number
  sessions: Map<string, SessionSummary>
  events: ActivityEvent[]
  /** messageId → message header (role etc). */
  messages: Map<string, { id: string; sessionId: string; role: 'user' | 'assistant'; createdAt: number; completedAt: number | null; agent: string | null; model: SessionSummary['model']; finish: string | null; error: string | null }>
  details: Map<string, { input: unknown; output: string | null; text: string | null; error: string | null }>
  diffs: Map<string, FileDiff>
  todos: Map<string, TodoItem[]>
  orca: OrcaSnapshot
  runs: OrchRunDetail[]
  attention: AttentionItem[]
  sources: SourceHealth[]
  workspaces: Record<string, WorkspaceRef>
}

export const MOCK_IDS = {
  rootBuild: 'ses_remote_start',
  exploreUsages: 'ses_explore_usages',
  exploreBackoff: 'ses_explore_backoff',
  coderPolicy: 'ses_coder_policy',
  coderViewModel: 'ses_coder_viewmodel',
  coderTests: 'ses_coder_tests',
  reviewer: 'ses_reviewer_diff',
  blocked: 'ses_paparazzi',
  waiting: 'ses_board_coord',
  done: 'ses_theme_refactor',
  idle: 'ses_bitrise_cache',
  copilot: '7c1e5a52-3b9d-4f0e-8a61-d2f4c9b07e13',
  runBoard: 'run_board_01',
  runSpike: 'run_spike_02',
} as const

const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

export function toolInfo(
  name: string, category: ToolCategory, input: string | null, output: string | null,
  o: { mcpServer?: string | null; displayName?: string; error?: string | null; durationMs?: number | null; truncated?: boolean } = {},
): ToolCallInfo {
  return {
    name, displayName: o.displayName ?? name, category, mcpServer: o.mcpServer ?? null, callId: `call_${name}_${Math.abs(hashStr(name + (input ?? '')))}`,
    input, output, error: o.error ?? null, durationMs: o.durationMs ?? null, truncated: o.truncated ?? false,
  }
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

const DIFF_POLICY = `diff --git a/app/src/main/java/com/acme/remote/RetryPolicy.kt b/app/src/main/java/com/acme/remote/RetryPolicy.kt
index 4be1a02..9c07d3f 100644
--- a/app/src/main/java/com/acme/remote/RetryPolicy.kt
+++ b/app/src/main/java/com/acme/remote/RetryPolicy.kt
@@ -3,12 +3,24 @@ package com.acme.remote
 import kotlinx.coroutines.delay
 
 class RetryPolicy(
-    private val maxAttempts: Int = 3,
+    private val maxAttempts: Int = 5,
+    private val baseDelayMs: Long = 400,
+    private val maxDelayMs: Long = 8_000,
 ) {
     suspend fun <T> run(block: suspend (attempt: Int) -> Result<T>): Result<T> {
         var last: Result<T>? = null
         repeat(maxAttempts) { attempt ->
             val result = block(attempt)
             if (result.isSuccess) return result
             last = result
-            delay(500)
+            delay(backoff(attempt))
         }
         return last ?: Result.failure(IllegalStateException("no attempts"))
     }
+
+    private fun backoff(attempt: Int): Long =
+        minOf(maxDelayMs, baseDelayMs shl attempt)
 }
`

const DIFF_VM = `--- a/app/src/main/java/com/acme/remote/RemoteStartViewModel.kt
+++ b/app/src/main/java/com/acme/remote/RemoteStartViewModel.kt
@@ -21,7 +21,11 @@ class RemoteStartViewModel(
     fun start() {
         viewModelScope.launch {
-            _state.value = RemoteStartState.Starting
-            _state.value = useCase.start(vin).fold(
+            _state.value = RemoteStartState.Starting(attempt = 1)
+            _state.value = useCase.start(vin) { attempt ->
+                _state.value = RemoteStartState.Starting(attempt)
+            }.fold(
                 onSuccess = { RemoteStartState.Started },
                 onFailure = { RemoteStartState.Failed(it.message) },
             )
`

const PLAN_MD = `# Remote start retry — plan

1. Replace the fixed 500 ms delay with exponential backoff (RetryPolicy).
2. Surface attempt count in RemoteStartViewModel.
3. Cover backoff + cancellation with unit tests.
4. Review against ACME-4412 acceptance criteria.
`

interface SessionSeed {
  id: string; harness?: Harness; parentId?: string | null; title: string; agent: string | null; model?: string | null
  workspace: string; state: AgentState; stateSource?: StateSource; ageMin: number; lastMin: number | null
  orca?: Partial<NonNullable<SessionSummary['orca']>> | null; spawn?: { description: string; type: string; status: ActivityStatus } | null
  facts?: Array<{ label: string; value: string }>
}

/**
 * Builds the mock fleet.
 *
 * Roots: `ses_remote_start` (build, working, 6 subagents), `ses_paparazzi` (blocked, permission via
 * Orca hook), `ses_board_coord` (waiting on a question; coordinator of `run_board_01`),
 * `ses_theme_refactor` (done), `ses_bitrise_cache` (idle), Copilot UUID root (working).
 */
export function buildMockWorld(opts: { now: number; seed?: number; scenario?: 'healthy' | 'degraded' }): MockWorld {
  const now = opts.now
  const rnd = mulberry32(opts.seed ?? 7)
  const scenario = opts.scenario ?? 'healthy'
  const I = MOCK_IDS

  const workspaces: Record<string, WorkspaceRef> = {
    android: { key: 'wt_acme_main', name: 'acme-android', path: '/Users/dev/Development/acme-android', repo: 'acme-android', branch: 'main' },
    ipm: { key: 'wt_ipm_agent', name: 'insights-agent', path: '/Users/dev/Development/insights-agent', repo: 'insights-agent', branch: 'feat/ipm-agent' },
    occ: { key: 'wt_occ_main', name: 'orca-command-center', path: '/Users/dev/Development/orca-command-center', repo: 'orca-command-center', branch: 'main' },
  }

  const world: MockWorld = {
    now, sessions: new Map(), events: [], messages: new Map(), details: new Map(), diffs: new Map(), todos: new Map(),
    orca: null as unknown as OrcaSnapshot, runs: [], attention: [], sources: [], workspaces,
  }

  /* ───────── sessions ───────── */
  const seeds: SessionSeed[] = [
    { id: I.rootBuild, title: 'Implement remote-start retry flow (ACME-4412)', agent: 'build', model: 'claude-opus-5.5', workspace: 'android', state: 'working', stateSource: 'orca-hook', ageMin: 52, lastMin: 0.03,
      orca: { paneKey: 'tab_1:leaf_1', tabId: 'tab_1', terminalHandle: 'term_a1f3', terminalTitle: 'remote-start', worktreeId: 'wt_acme_main', hookEvent: 'PreToolUse', hookState: 'working' },
      facts: [{ label: 'Provider', value: 'anthropic' }, { label: 'Share', value: 'private' }] },
    { id: I.exploreUsages, parentId: I.rootBuild, title: 'Find RemoteStartRepository usages', agent: 'explore', model: 'claude-haiku-4.5', workspace: 'android', state: 'done', stateSource: 'parent-tool', ageMin: 49, lastMin: 44, spawn: { description: 'Find RemoteStartRepository usages', type: 'explore', status: 'completed' } },
    { id: I.exploreBackoff, parentId: I.rootBuild, title: 'Map retry/backoff helpers in :core', agent: 'explore', model: 'claude-haiku-4.5', workspace: 'android', state: 'working', stateSource: 'parent-tool', ageMin: 30, lastMin: 14, spawn: { description: 'Map retry/backoff helpers in :core', type: 'explore', status: 'running' } },
    { id: I.coderPolicy, parentId: I.rootBuild, title: 'Add RetryPolicy to RemoteStartUseCase', agent: 'sonnet-coder', model: 'claude-sonnet-5.5', workspace: 'android', state: 'done', stateSource: 'parent-tool', ageMin: 40, lastMin: 21, spawn: { description: 'Add RetryPolicy to RemoteStartUseCase', type: 'sonnet-coder', status: 'completed' } },
    { id: I.coderViewModel, parentId: I.rootBuild, title: 'Update RemoteStartViewModel state', agent: 'sonnet-coder', model: 'claude-sonnet-5.5', workspace: 'android', state: 'working', stateSource: 'parent-tool', ageMin: 18, lastMin: 0.05, spawn: { description: 'Update RemoteStartViewModel state', type: 'sonnet-coder', status: 'running' } },
    { id: I.coderTests, parentId: I.rootBuild, title: 'Write unit tests for RetryPolicy', agent: 'sonnet-coder', model: 'claude-sonnet-5.5', workspace: 'android', state: 'error', stateSource: 'parent-tool', ageMin: 16, lastMin: 7, spawn: { description: 'Write unit tests for RetryPolicy', type: 'sonnet-coder', status: 'error' } },
    { id: I.reviewer, parentId: I.rootBuild, title: 'Review diff against ACME-4412', agent: 'pm-reviewer', model: 'claude-opus-5.5', workspace: 'android', state: 'done', stateSource: 'parent-tool', ageMin: 9, lastMin: 5, spawn: { description: 'Review diff against ACME-4412', type: 'pm-reviewer', status: 'completed' } },
    { id: I.blocked, title: 'Fix flaky paparazzi snapshot tests', agent: 'build', model: 'claude-sonnet-5.5', workspace: 'ipm', state: 'blocked', stateSource: 'orca-hook', ageMin: 95, lastMin: 3,
      orca: { paneKey: 'tab_2:leaf_1', tabId: 'tab_2', terminalHandle: 'term_b72c', terminalTitle: 'paparazzi', worktreeId: 'wt_ipm_agent', hookEvent: 'PermissionRequest', hookState: 'blocked' } },
    { id: I.waiting, title: 'Coordinate "Demo task board" run', agent: 'orchestrator', model: 'claude-opus-5.5', workspace: 'ipm', state: 'waiting', stateSource: 'orca-hook', ageMin: 130, lastMin: 6,
      orca: { paneKey: 'tab_3:leaf_1', tabId: 'tab_3', terminalHandle: 'term_c09d', terminalTitle: 'coordinator', worktreeId: 'wt_ipm_agent', hookEvent: 'Notification', hookState: 'waiting', runId: I.runBoard, role: 'coordinator' } },
    { id: I.done, title: 'Refactor theme tokens to oklch', agent: 'build', model: 'gpt-5.4-codex', workspace: 'occ', state: 'done', stateSource: 'orca-hook', ageMin: 210, lastMin: 38,
      orca: { paneKey: 'tab_4:leaf_1', tabId: 'tab_4', terminalHandle: 'term_d41e', terminalTitle: 'theme', worktreeId: 'wt_occ_main', hookEvent: 'Stop', hookState: 'done' } },
    { id: I.idle, title: 'Investigate Bitrise cache misses', agent: 'build', model: 'claude-sonnet-5.5', workspace: 'android', state: 'idle', stateSource: 'transcript', ageMin: 400, lastMin: 190 },
    { id: I.copilot, harness: 'copilot', title: 'Add PR template checks to CI', agent: null, model: 'gpt-5.5', workspace: 'occ', state: 'working', stateSource: 'orca-hook', ageMin: 25, lastMin: 0.1,
      orca: { paneKey: 'tab_5:leaf_1', tabId: 'tab_5', terminalHandle: 'term_e5a0', terminalTitle: 'copilot', worktreeId: 'wt_occ_main', hookEvent: 'PostToolUse', hookState: 'working' },
      facts: [{ label: 'Premium requests', value: '12' }, { label: 'Session file', value: '~/.copilot/session-state/7c1e5a52…' }] },
  ]

  for (const sd of seeds) {
    const ws = workspaces[sd.workspace]
    const live = sd.state === 'working' || sd.state === 'blocked' || sd.state === 'waiting'
    const parent = sd.parentId ? seeds.find((x) => x.id === sd.parentId)! : null
    const orcaBase = sd.orca
      ? { paneKey: null, tabId: null, terminalHandle: null, terminalTitle: null, worktreeId: null, hookEvent: null, hookState: null, hookAt: now - 3 * MIN, runId: null, taskId: null, dispatchId: null, role: null, ...sd.orca }
      : null
    const s: SessionSummary = {
      id: sd.id, harness: sd.harness ?? 'opencode', parentId: sd.parentId ?? null, rootId: sd.parentId ? parent!.id : sd.id, depth: sd.parentId ? 1 : 0,
      title: sd.title, agent: sd.agent, model: sd.model ? { providerId: sd.harness === 'copilot' ? 'github-copilot' : 'anthropic', modelId: sd.model } : null,
      directory: ws.path, workspace: ws, createdAt: now - sd.ageMin * MIN, updatedAt: now - (sd.lastMin ?? sd.ageMin) * MIN,
      lastActivityAt: sd.lastMin == null ? null : now - sd.lastMin * MIN, archivedAt: null,
      state: sd.state, stateSource: sd.stateSource ?? 'transcript', stateSince: now - Math.min(sd.ageMin, sd.lastMin ?? 5) * MIN - 40_000,
      live, current: null, lastPrompt: null, lastMessage: null, counters: null, tokens: { ...ZERO_TOKENS }, cost: 0,
      childIds: [], descendantCount: 0,
      spawn: sd.spawn ? { parentSessionId: sd.parentId!, activityId: '', callId: null, description: sd.spawn.description, subagentType: sd.spawn.type, status: sd.spawn.status } : null,
      orca: orcaBase, facts: sd.facts ?? [{ label: 'Version', value: '1.18.7' }],
    }
    world.sessions.set(s.id, s)
  }

  /* ───────── event scripting ───────── */
  let seq = 0
  const msgCounter = new Map<string, number>()
  class Script {
    t: number
    msg: string | null = null
    constructor(readonly sid: string, startMinAgo: number) { this.t = now - startMinAgo * MIN }
    private get s() { return world.sessions.get(this.sid)! }
    advance(ms = 2000 + rnd() * 9000) { this.t += ms; return this }
    private idFor(): string {
      const n = ++seq
      return this.s.harness === 'copilot' ? `copilot:${this.sid}:${n}` : `opencode:prt_${this.sid.slice(4, 12)}_${n}`
    }
    message(role: 'user' | 'assistant', error: string | null = null) {
      const n = (msgCounter.get(this.sid) ?? 0) + 1
      msgCounter.set(this.sid, n)
      this.msg = `msg_${this.sid.slice(4, 12)}_${String(n).padStart(3, '0')}`
      world.messages.set(this.msg, { id: this.msg, sessionId: this.sid, role, createdAt: this.t, completedAt: role === 'assistant' ? this.t + 30_000 : this.t, agent: this.s.agent, model: this.s.model, finish: role === 'assistant' ? 'stop' : null, error })
      return this
    }
    push(p: Partial<ActivityEvent> & { kind: ActivityKind; title: string }, detail?: { input?: unknown; output?: string | null; text?: string | null; error?: string | null }): ActivityEvent {
      const id = p.id ?? this.idFor()
      const ev: ActivityEvent = {
        id, rev: p.endTs ?? this.t, harness: this.s.harness, sessionId: this.sid, rootId: this.s.rootId, messageId: this.msg, ts: this.t, endTs: null,
        status: null, summary: null, tool: null, files: [], childSessionId: null, usage: null, links: [], source: this.s.harness === 'copilot' ? 'copilot.events' : 'opencode.part', detailRef: null, ...p,
      }
      if (detail) { world.details.set(id, { input: detail.input ?? null, output: detail.output ?? null, text: detail.text ?? null, error: detail.error ?? null }); ev.detailRef = id }
      world.events.push(ev)
      return ev
    }
    prompt(text: string) {
      this.message('user')
      this.push({ kind: 'prompt', title: text.slice(0, 80), summary: text }, { text })
      return this.advance(1500)
    }
    think(text: string, dur = 4000 + rnd() * 6000) {
      this.push({ kind: 'thinking', title: 'Thinking', summary: text, status: 'completed', endTs: this.t + dur }, { text })
      return this.advance(dur)
    }
    say(text: string, links: string[] = []) {
      this.push({ kind: 'text', title: text.split('\n')[0].slice(0, 100), summary: text, status: 'completed', links }, { text })
      return this.advance()
    }
    tool(name: string, category: ToolCategory, input: string, output: string | null, o: { status?: ActivityStatus; dur?: number; error?: string | null; files?: string[] } = {}) {
      const dur = o.dur ?? 300 + rnd() * 3500
      const status = o.status ?? 'completed'
      this.push({
        kind: 'tool', title: `${name} · ${input}`.slice(0, 140), status, endTs: status === 'running' ? null : this.t + dur, files: o.files ?? [],
        summary: output?.slice(0, 200) ?? null, tool: toolInfo(name, category, input, output?.slice(0, 800) ?? null, { error: o.error, durationMs: status === 'running' ? null : Math.round(dur) }),
      }, { input: { command: input }, output, error: o.error ?? null })
      return this.advance(Math.min(dur, 4000))
    }
    mcp(server: string, tool: string, input: string, output: string | null, o: { status?: ActivityStatus; dur?: number; error?: string | null; links?: string[] } = {}) {
      const dur = o.dur ?? 600 + rnd() * 2500
      const status = o.status ?? 'completed'
      this.push({
        kind: 'mcp', title: `${server} · ${tool}`, status, endTs: status === 'running' ? null : this.t + dur, links: o.links ?? [], summary: output?.slice(0, 200) ?? null,
        tool: toolInfo(`${server}_${tool}`, 'mcp', input, output?.slice(0, 800) ?? null, { mcpServer: server, displayName: tool, error: o.error, durationMs: status === 'running' ? null : Math.round(dur) }),
      }, { input: JSON.parse(input.startsWith('{') ? input : '{}'), output, error: o.error ?? null })
      return this.advance(Math.min(dur, 4000))
    }
    edit(path: string, diff: string, o: { kind?: 'edit' | 'write'; status?: ActivityStatus } = {}) {
      const kind = o.kind ?? 'edit'
      const ev = this.push({
        kind: 'file-change', title: `${kind === 'write' ? 'Wrote' : 'Edited'} ${path.split('/').slice(-2).join('/')}`, status: o.status ?? 'completed', endTs: this.t + 400, files: [path],
        tool: toolInfo(kind, kind, path, 'ok', { durationMs: 400 }),
      }, { input: { filePath: path }, output: 'Edit applied successfully.' })
      world.diffs.set(ev.id, { id: ev.id, path, format: kind === 'write' ? 'new-file' : 'unified', text: diff, note: null, truncated: false })
      return this.advance(800)
    }
    todo(items: Array<[string, string]>) {
      const list: TodoItem[] = items.map(([content, status], i) => ({ id: `todo_${this.sid.slice(4, 10)}_${i}`, content, status, priority: i === 0 ? 'high' : 'medium', position: i }))
      world.todos.set(this.sid, list)
      this.push({ kind: 'todo', title: `Updated todos (${list.filter((x) => x.status === 'completed').length}/${list.length} done)`, status: 'completed', summary: list.map((x) => `[${x.status}] ${x.content}`).join('\n') }, { text: list.map((x) => x.content).join('\n') })
      return this.advance()
    }
    step(input: number, output: number, cost: number) {
      this.push({ kind: 'step', title: 'Step finished', status: 'completed', usage: { tokens: { input, output, reasoning: Math.round(output * 0.3), cacheRead: input * 3, cacheWrite: Math.round(input * 0.1) }, cost } })
      return this.advance(500)
    }
    subagent(childId: string) {
      const c = world.sessions.get(childId)!
      const ev = this.push({
        kind: 'subagent', title: `task · ${c.spawn!.description}`, status: c.spawn!.status, endTs: c.spawn!.status === 'running' ? null : this.t + 60_000, childSessionId: childId,
        summary: c.spawn!.description, tool: toolInfo('task', 'subagent', c.spawn!.description, null, { displayName: c.spawn!.subagentType ?? 'task' }),
      }, { input: { description: c.spawn!.description, subagent_type: c.spawn!.subagentType } })
      c.spawn!.activityId = ev.id
      return this.advance()
    }
    state(from: string, to: string, hook?: string) {
      this.push({ kind: 'state', title: `${from} → ${to}`, summary: hook ?? null, source: 'orca.hooks', id: `orca-hook:${this.s.orca?.paneKey ?? 'pane'}:${Math.round(this.t)}` })
      return this.advance(1000)
    }
    permission(title: string, summary: string, status: ActivityStatus = 'pending') {
      this.push({ kind: 'permission', title, summary, status, source: 'orca.hooks', id: `orca-hook:${this.s.orca?.paneKey ?? 'pane'}:perm${Math.round(this.t)}` })
      return this.advance(1000)
    }
    error(title: string, summary: string) {
      this.push({ kind: 'error', title, summary, status: 'error' }, { text: summary, error: summary })
      return this.advance()
    }
    orch(subject: string, body: string, id: string) {
      this.push({ kind: 'orchestration', title: subject, summary: body, status: 'completed', id, source: 'orca.orchestration' })
      return this.advance()
    }
  }

  const ROOT = '/Users/dev/Development/acme-android'
  const f = (p: string) => `${ROOT}/${p}`

  /* ── main build root ── */
  {
    const s = new Script(I.rootBuild, 51)
    s.prompt('Implement the remote-start retry flow per ACME-4412: exponential backoff, surface the attempt count in the ViewModel, add tests, then open a PR.')
    s.message('assistant')
    s.think('The ticket asks for retry with backoff.\nFirst read ACME-4412 for acceptance criteria.\nThen find every call site of RemoteStartRepository so the policy can be injected once.', 7000)
    s.mcp('atlassian', 'jira_get_issue', '{"issueKey":"ACME-4412"}', 'ACME-4412 · Remote start: retry on transient failure\nStatus: In Progress · Assignee: you\nAC: 1) up to 5 attempts 2) exponential backoff capped at 8s 3) UI shows attempt N', { links: ['https://ford.atlassian.net/browse/ACME-4412'] })
    s.todo([['Read ticket + map call sites', 'completed'], ['Implement RetryPolicy', 'completed'], ['Update ViewModel state', 'in_progress'], ['Unit tests', 'in_progress'], ['Review + open PR', 'pending']])
    s.tool('grep', 'search', 'RemoteStartRepository', f('app/src/main/java/com/acme/remote/RemoteStartUseCase.kt:14\n') + f('app/src/main/java/com/acme/remote/RemoteStartViewModel.kt:9'))
    s.subagent(I.exploreUsages)
    s.subagent(I.exploreBackoff)
    s.tool('read', 'read', f('app/src/main/java/com/acme/remote/RetryPolicy.kt'), 'class RetryPolicy(private val maxAttempts: Int = 3) { … }', { files: [f('app/src/main/java/com/acme/remote/RetryPolicy.kt')] })
    s.step(14_200, 640, 0.18)
    s.subagent(I.coderPolicy)
    s.edit(f('app/src/main/java/com/acme/remote/RetryPolicy.kt'), DIFF_POLICY)
    s.edit(f('Plan.md'), PLAN_MD, { kind: 'write' })
    s.subagent(I.coderViewModel)
    s.subagent(I.coderTests)
    s.tool('bash', 'shell', './gradlew :app:testDebugUnitTest --tests "*RetryPolicyTest"', 'e: RetryPolicyTest.kt:31:18 Unresolved reference: advanceTimeBy\n> Task :app:compileDebugUnitTestKotlin FAILED\nBUILD FAILED in 41s', { status: 'error', error: 'exit code 1', dur: 41_000 })
    s.mcp('bitrise', 'get_build_log', '{"buildSlug":"a1b2c3","tail":200}', null, { status: 'error', error: 'HTTP 404: build log not available yet', dur: 900 })
    s.subagent(I.reviewer)
    s.step(21_900, 1_150, 0.31)
    s.mcp('github', 'create_pull_request', '{"owner":"acme-org","repo":"acme-android","title":"feat: retry remote start with backoff","head":"feat/ACME-4412"}', 'Created PR #812', { links: ['https://github.com/acme-org/acme-android/pull/812'] })
    s.say('Opened https://github.com/acme-org/acme-android/pull/812 with the retry policy and ViewModel changes. Still waiting on the unit tests subagent — it hit a **compile error** in `RetryPolicyTest`.\n\n- RetryPolicy: 5 attempts, 400 ms base, 8 s cap\n- ViewModel: exposes `Starting(attempt)`', ['https://github.com/acme-org/acme-android/pull/812'])
    s.step(26_500, 980, 0.27)
  }
  {
    const s = new Script(I.exploreUsages, 49)
    s.prompt('Find every usage of RemoteStartRepository and report file:line.')
    s.message('assistant')
    s.tool('grep', 'search', 'RemoteStartRepository', f('app/src/main/java/com/acme/remote/RemoteStartUseCase.kt:14\n') + f('app/src/main/java/com/acme/remote/RemoteStartViewModel.kt:9\n') + f('feature/dashboard/src/main/java/DashboardModule.kt:44'))
    s.say('RemoteStartRepository is used in 3 places: the use case (line 14), the ViewModel (line 9), and the Hilt module in :feature:dashboard (line 44).')
    s.step(5_100, 220, 0.01)
  }
  {
    const s = new Script(I.exploreBackoff, 30)
    s.prompt('List existing retry/backoff helpers in :core we could reuse.')
    s.message('assistant')
    s.think('Search :core for delay( and backoff.\nCheck whether kotlinx-coroutines-retry is on the classpath.')
    s.tool('glob', 'search', 'core/**/*Retry*.kt', f('core/src/main/java/com/acme/core/net/RetryInterceptor.kt'))
    s.tool('read', 'read', f('core/src/main/java/com/acme/core/net/RetryInterceptor.kt'), 'class RetryInterceptor : Interceptor { … fixed 3 retries … }', { files: [f('core/src/main/java/com/acme/core/net/RetryInterceptor.kt')] })
  }
  {
    const s = new Script(I.coderPolicy, 40)
    s.prompt('Add a RetryPolicy with exponential backoff (5 attempts, 400ms base, 8s cap) and use it in RemoteStartUseCase.')
    s.message('assistant')
    s.tool('read', 'read', f('app/src/main/java/com/acme/remote/RemoteStartUseCase.kt'), 'class RemoteStartUseCase(private val repo: RemoteStartRepository) { … }', { files: [f('app/src/main/java/com/acme/remote/RemoteStartUseCase.kt')] })
    s.edit(f('app/src/main/java/com/acme/remote/RetryPolicy.kt'), DIFF_POLICY)
    s.say('RetryPolicy now backs off 400 ms → 8 s over 5 attempts; RemoteStartUseCase delegates to it.')
    s.step(9_800, 540, 0.09)
  }
  {
    const s = new Script(I.coderViewModel, 18)
    s.prompt('Expose the retry attempt number from RemoteStartViewModel as RemoteStartState.Starting(attempt).')
    s.message('assistant')
    s.think('RemoteStartState.Starting is an object today.\nNeed to convert it to a data class and fix the Compose call sites.')
    s.tool('read', 'read', f('app/src/main/java/com/acme/remote/RemoteStartViewModel.kt'), 'class RemoteStartViewModel(…) : ViewModel() { … }', { files: [f('app/src/main/java/com/acme/remote/RemoteStartViewModel.kt')] })
    s.edit(f('app/src/main/java/com/acme/remote/RemoteStartViewModel.kt'), DIFF_VM)
    s.step(7_300, 410, 0.07)
  }
  {
    const s = new Script(I.coderTests, 16)
    s.prompt('Write unit tests for RetryPolicy: success on 3rd attempt, gives up after 5, respects the 8s cap.')
    s.message('assistant')
    s.tool('bash', 'shell', './gradlew :app:testDebugUnitTest --tests "*RetryPolicyTest"', 'e: RetryPolicyTest.kt:31:18 Unresolved reference: advanceTimeBy', { status: 'error', error: 'exit code 1', dur: 38_000 })
    s.tool('bash', 'shell', './gradlew :app:testDebugUnitTest --tests "*RetryPolicyTest" --info', 'e: RetryPolicyTest.kt:31:18 Unresolved reference: advanceTimeBy', { status: 'error', error: 'exit code 1', dur: 36_000 })
    s.tool('bash', 'shell', './gradlew :app:dependencies --configuration debugUnitTestRuntimeClasspath', 'FAILED: Could not resolve org.jetbrains.kotlinx:kotlinx-coroutines-test', { status: 'error', error: 'exit code 1', dur: 12_000 })
    s.error('Tests failed to compile', 'Unresolved reference: advanceTimeBy (kotlinx-coroutines-test is missing from the :app test classpath).')
  }
  {
    const s = new Script(I.reviewer, 9)
    s.prompt('Review the working-tree diff against the acceptance criteria in ACME-4412.')
    s.message('assistant')
    s.mcp('atlassian', 'jira_get_issue', '{"issueKey":"ACME-4412"}', 'AC: 1) up to 5 attempts 2) exponential backoff capped at 8s 3) UI shows attempt N')
    s.tool('bash', 'shell', 'git diff --stat', ' RetryPolicy.kt | 14 +++++++++++---\n RemoteStartViewModel.kt | 8 ++++++--\n 2 files changed, 17 insertions(+), 5 deletions(-)')
    s.say('AC 1 and 2 are met. AC 3 is met in the ViewModel but the Compose screen does not render the attempt yet — flag for follow-up.')
  }

  /* ── blocked (permission) ── */
  {
    const s = new Script(I.blocked, 94)
    s.prompt('The paparazzi snapshot tests are flaky on CI. Find the cause and fix them.')
    s.message('assistant')
    s.tool('bash', 'shell', 'git log --oneline -5 -- app/src/test', 'a1b2c3d snapshots: bump paparazzi 1.3.4\n9f8e7d6 snapshots: add dark variants')
    s.think('Likely font rendering nondeterminism between JDK builds.\nRe-record locally and diff against CI artifacts.')
    s.state('working', 'blocked', 'PermissionRequest')
    s.permission('Permission requested: bash', './gradlew recordPaparazziDebug --rerun-tasks')
  }
  /* ── waiting (question) coordinator ── */
  {
    const s = new Script(I.waiting, 128)
    s.prompt('Coordinate the "Demo task board" build: schema → API → UI, persisting card order.')
    s.message('assistant')
    s.orch('Task t1 dispatched', 'Define board schema → term_w1', 'orch:msg_board_01')
    s.orch('Task t2 completed', 'worker_done: API routes with tests', 'orch:msg_board_02')
    s.orch('Decision needed: persist ordering', 'SQLite or localStorage for card order?', 'orch:msg_board_03')
    s.push({ kind: 'tool', title: 'question · Persist card ordering where?', status: 'pending', tool: toolInfo('question', 'question', 'Persist card ordering where? [SQLite | localStorage]', null) }, { input: { question: 'Persist card ordering where?', options: ['SQLite', 'localStorage'] } })
  }
  /* ── done ── */
  {
    const s = new Script(I.done, 209)
    s.prompt('Convert the theme tokens in styles/theme.css to oklch and verify contrast.')
    s.message('assistant')
    s.tool('read', 'read', '/Users/dev/Development/orca-command-center/src/client/styles/theme.css', ':root { --field: #f4f4f5; … }')
    s.edit('/Users/dev/Development/orca-command-center/src/client/styles/theme.css', `--- a/src/client/styles/theme.css
+++ b/src/client/styles/theme.css
@@ -1,4 +1,4 @@
 :root {
-  --field: #f4f4f5;
+  --field: oklch(95.5% .003 286.3);
   --radius: .625rem;
 }
`)
    s.say('All tokens are now oklch; contrast checks pass AA in both themes.')
    s.step(8_000, 300, 0.05)
  }
  /* ── idle ── */
  {
    const s = new Script(I.idle, 399)
    s.prompt('Why are Bitrise cache restores missing on the android-release workflow?')
    s.message('assistant')
    s.mcp('bitrise', 'get_build_log', '{"buildSlug":"d4e5f6","tail":200}', null, { status: 'error', error: 'HTTP 404: build log not available yet' })
    s.mcp('bitrise', 'list_builds', '{"app":"acme-android","limit":5}', '5 builds: 3 succeeded, 2 failed (cache miss)')
    s.say('Cache keys include the Gradle wrapper checksum which changed in the last bump, so every build misses. Suggest pinning the key to `gradle/libs.versions.toml`.')
    s.step(11_000, 700, 0.12)
  }
  /* ── copilot ── */
  {
    const s = new Script(I.copilot, 24)
    s.prompt('Add a CI check that fails PRs without a filled-in template.')
    s.message('assistant')
    s.think('Add a GitHub Actions workflow that parses the PR body.\nUse actions/github-script.')
    s.tool('view', 'read', '.github/PULL_REQUEST_TEMPLATE.md', '## Summary\n## Testing')
    s.edit('/Users/dev/Development/orca-command-center/.github/workflows/pr-template.yml', 'name: PR template\non: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/github-script@v7\n', { kind: 'write' })
    s.say('Added `.github/workflows/pr-template.yml`; it fails when the Summary section is empty.')
  }

  /* ───────── derive session aggregates ───────── */
  recomputeAll(world)

  // current activity for live sessions
  const cur = (id: string, label: string, detail: string, kind: ActivityKind = 'tool') => {
    const s = world.sessions.get(id)!
    s.current = { kind, label, detail, since: now - 4000, activityId: null }
  }
  cur(I.rootBuild, 'bash', 'npm test')
  cur(I.coderViewModel, 'edit', 'RemoteStartViewModel.kt', 'file-change')
  cur(I.exploreBackoff, 'Thinking', null as unknown as string, 'thinking')
  cur(I.copilot, 'view', '.github/workflows/pr-template.yml')
  cur(I.blocked, 'bash', './gradlew recordPaparazziDebug', 'permission')
  cur(I.waiting, 'question', 'Persist card ordering where?', 'tool')
  world.sessions.get(I.exploreBackoff)!.current!.detail = null
  for (const sid of [I.exploreBackoff]) world.sessions.get(sid)!.live = true
  // fix lastMessage/lastPrompt
  for (const s of world.sessions.values()) {
    const evs = world.events.filter((e) => e.sessionId === s.id)
    s.lastPrompt = evs.find((e) => e.kind === 'prompt')?.summary ?? null
    s.lastMessage = [...evs].reverse().find((e) => e.kind === 'text')?.summary ?? null
  }

  /* ───────── orca snapshot ───────── */
  const worktrees: WorktreeInfo[] = Object.values(workspaces).map((w, i) => ({
    id: w.key, repoId: `repo_${i}`, repo: w.repo, path: w.path!, branch: w.branch, displayName: w.name, status: 'active', workspaceStatus: 'in-progress',
    isActive: i === 0, isMainWorktree: w.branch === 'main', liveTerminalCount: [...world.sessions.values()].filter((s) => s.workspace?.key === w.key && s.orca?.terminalHandle && s.depth === 0).length,
    lastActivityAt: now - i * 3 * MIN, lastOutputAt: now - i * 2 * MIN,
    links: i === 0 ? [{ kind: 'pr', label: 'PR #812', url: 'https://github.com/acme-org/acme-android/pull/812' }, { kind: 'issue', label: 'ACME-4412', url: 'https://ford.atlassian.net/browse/ACME-4412' }] : [],
  }))
  const terminals: TerminalInfo[] = [...world.sessions.values()].filter((s) => s.orca?.terminalHandle).map((s) => ({
    handle: s.orca!.terminalHandle!, worktreeId: s.orca!.worktreeId, worktreePath: s.workspace?.path ?? null, tabId: s.orca!.tabId, leafId: 'leaf_1', paneKey: s.orca!.paneKey,
    title: s.orca!.terminalTitle, agentIdentity: s.harness === 'copilot' ? 'copilot' : 'opencode', connected: true, lastOutputAt: now - 5000, preview: `${s.title.slice(0, 60)} …`, sessionId: s.id,
  }))
  const hooks: HookEntry[] = [...world.sessions.values()].filter((s) => s.orca?.paneKey).map((s) => ({
    paneKey: s.orca!.paneKey!, tabId: s.orca!.tabId, worktreeId: s.orca!.worktreeId, agent: s.harness === 'copilot' ? 'copilot' : 'opencode', hookEvent: s.orca!.hookEvent, state: s.orca!.hookState,
    prompt: s.lastPrompt, lastAssistantMessage: s.lastMessage, providerSessionId: s.id, receivedAt: s.orca!.hookAt, stateStartedAt: s.stateSince,
  }))
  const orcaRunning = scenario === 'healthy'
  world.orca = {
    status: { running: orcaRunning, reachable: orcaRunning, pid: orcaRunning ? 97499 : null, version: orcaRunning ? '1.4.2' : null, runtimeState: orcaRunning ? 'ready' : null, checkedAt: now, error: orcaRunning ? null : 'orca CLI: runtime not found' },
    worktrees, terminals, hooks,
  }

  /* ───────── orchestration ───────── */
  buildRuns(world, now)

  /* ───────── attention ───────── */
  world.attention = [
    { id: `permission:${I.blocked}`, kind: 'permission', severity: 'high', sessionId: I.blocked, runId: null, taskId: null, title: 'insights-agent · build needs permission', detail: 'bash: ./gradlew recordPaparazziDebug --rerun-tasks', since: now - 3 * MIN, source: 'orca-hook' },
    { id: `question:${I.waiting}`, kind: 'question', severity: 'high', sessionId: I.waiting, runId: I.runBoard, taskId: null, title: 'insights-agent · orchestrator asked a question', detail: 'Persist card ordering where? [SQLite | localStorage]', since: now - 6 * MIN, source: 'transcript' },
    { id: `gate:${I.runBoard}:g1`, kind: 'gate', severity: 'high', sessionId: null, runId: I.runBoard, taskId: 't4', title: "Run 'Demo task board' is blocked on a decision", detail: 'Persist ordering in SQLite or localStorage?', since: now - 6 * MIN, source: 'orchestration' },
    { id: `error:${I.coderTests}`, kind: 'error', severity: 'medium', sessionId: I.coderTests, runId: null, taskId: null, title: 'acme-android · 3 tool errors in the last 10 min', detail: 'Unresolved reference: advanceTimeBy', since: now - 7 * MIN, source: 'transcript' },
    { id: `stalled:${I.exploreBackoff}`, kind: 'stalled', severity: 'medium', sessionId: I.exploreBackoff, runId: null, taskId: null, title: 'Map retry/backoff helpers in :core · no activity for 14 min while working', detail: null, since: now - 14 * MIN, source: 'transcript' },
    { id: `failed-task:${I.runBoard}:t6`, kind: 'failed-task', severity: 'medium', runId: I.runBoard, taskId: 't6', sessionId: null, title: "Task 'Write docs' failed (2 attempts)", detail: 'circuit breaker opened after repeated worker crash', since: now - 20 * MIN, source: 'orchestration' },
  ]

  /* ───────── sources ───────── */
  const ok = (id: SourceHealth['id'], label: string, path: string | null, version: string | null): SourceHealth => ({ id, label, status: 'ok', path, version, detail: null, lastReadAt: now - 1500, lastChangeAt: now - 4000 })
  world.sources = [
    ok('opencode', 'opencode.db', '~/.local/share/opencode/opencode.db', '1.18.7'),
    ok('copilot', 'copilot', '~/.copilot/session-state', '0.0.402'),
    ok('orca-cli', 'orca-cli', '/usr/local/bin/orca', '1.4.2'),
    ok('orca-hooks', 'hooks', '~/Library/Application Support/orca/agent-hooks/last-status.json', null),
    ok('orca-orchestration', 'orchestration', '~/Library/Application Support/orca/orchestration.db', 'v43'),
  ]
  if (scenario === 'degraded') {
    world.sources[1] = { ...world.sources[1], status: 'missing', detail: 'Copilot CLI not found (~/.copilot) — Copilot sessions hidden.' }
    world.sources[2] = { ...world.sources[2], status: 'error', detail: 'orca CLI exited with code 1: runtime not found' }
    world.sources[4] = { ...world.sources[4], status: 'degraded', version: 'v44', detail: 'orchestration.db is from a newer Orca schema (v44).' }
    world.sources[0] = { ...world.sources[0], status: 'degraded', detail: 'session.workspace_id column missing — grouping by directory.' }
  }
  return world
}

function buildRuns(world: MockWorld, now: number) {
  const I = MOCK_IDS
  const mk = (id: string, runId: string, title: string, status: string, deps: string[], extra: Partial<OrchTask> = {}): OrchTask => ({
    id, runId, parentId: null, title, specPreview: `Spec for “${title}”: implement, add tests, and report back with a worker_done message.`, specTruncated: false,
    status, deps, createdAt: now - 125 * MIN, completedAt: status === 'completed' ? now - 60 * MIN : null, resultPreview: status === 'completed' ? 'Done — see worker_done message.' : null,
    createdByHandle: 'term_c09d', attemptCount: 0, latestDispatchId: null, ...extra,
  })
  const tasks = [
    mk('t1', I.runBoard, 'Define board schema', 'completed', [], { attemptCount: 1, latestDispatchId: 'd1' }),
    mk('t2', I.runBoard, 'Build API routes', 'completed', ['t1'], { attemptCount: 2, latestDispatchId: 'd3' }),
    mk('t3', I.runBoard, 'Kanban board UI', 'dispatched', ['t2'], { attemptCount: 1, latestDispatchId: 'd4' }),
    mk('t4', I.runBoard, 'Persist card ordering', 'blocked', ['t2'], { attemptCount: 0 }),
    mk('t5', I.runBoard, 'End-to-end tests', 'pending', ['t3', 't4']),
    mk('t6', I.runBoard, 'Write docs', 'failed', ['t1'], { attemptCount: 2, latestDispatchId: 'd6' }),
  ]
  const d = (id: string, taskId: string, status: string, handle: string, startMin: number, endMin: number | null, extra: Partial<OrchDispatch> = {}): OrchDispatch => ({
    id, runId: I.runBoard, taskId, status, assigneeHandle: handle, assigneeSessionId: null, dispatchedAt: now - startMin * MIN, completedAt: endMin == null ? null : now - endMin * MIN,
    lastHeartbeatAt: endMin == null ? now - 12_000 : now - endMin * MIN, failureCount: 0, lastFailure: null, terminationReason: null, depth: 1, workerState: status === 'completed' ? 'succeeded' : status === 'dispatched' ? 'ready' : 'failed', ...extra,
  })
  const dispatches = [
    d('d1', 't1', 'completed', 'term_w1', 120, 100),
    d('d2', 't2', 'failed', 'term_w2', 99, 90, { failureCount: 1, lastFailure: 'worker exited: lint failed', terminationReason: 'worker_crash' }),
    d('d3', 't2', 'completed', 'term_w2', 89, 62),
    d('d4', 't3', 'dispatched', 'term_w3', 55, null),
    d('d5', 't6', 'failed', 'term_w4', 50, 44, { failureCount: 1, lastFailure: 'worker crash', terminationReason: 'worker_crash' }),
    d('d6', 't6', 'circuit_broken', 'term_w4', 40, 36, { failureCount: 2, lastFailure: 'worker crash', terminationReason: 'circuit_breaker' }),
  ]
  const msg = (n: number, type: string, from: string, to: string, subject: string, body: string, taskId: string | null, ageMin: number): OrchMessage => ({
    id: `msg_board_${n}`, runId: I.runBoard, sequence: n, from, to, subject, bodyPreview: body, type, priority: type === 'decision_gate' || type === 'escalation' ? 'high' : 'normal', threadId: null, taskId, createdAt: now - ageMin * MIN,
  })
  const messages = [
    msg(1, 'dispatch', 'term_c09d', 'term_w1', 'Task t1: Define board schema', 'Create the SQLite schema for boards/cards.', 't1', 120),
    msg(2, 'worker_done', 'term_w1', 'term_c09d', 'Task t1 complete', 'Schema + migration written; tests pass.', 't1', 100),
    msg(3, 'dispatch', 'term_c09d', 'term_w2', 'Task t2: Build API routes', 'CRUD routes for boards and cards.', 't2', 99),
    msg(4, 'escalation', 'term_w2', 'term_c09d', 'Task t2 attempt 1 failed', 'Worker exited: lint failed.', 't2', 90),
    msg(5, 'worker_done', 'term_w2', 'term_c09d', 'Task t2 complete', 'Routes done; 14 tests.', 't2', 62),
    msg(6, 'dispatch', 'term_c09d', 'term_w3', 'Task t3: Kanban board UI', 'Build the board UI.', 't3', 55),
    msg(7, 'status', 'term_w3', 'term_c09d', 'Task t3 progress', 'Columns and cards render; drag-and-drop next.', 't3', 20),
    msg(8, 'decision_gate', 'term_c09d', 'user', 'Decision: persist ordering', 'SQLite or localStorage for card order?', 't4', 6),
    msg(9, 'heartbeat', 'term_w3', 'term_c09d', 'heartbeat', 'alive', 't3', 0.2),
  ]
  const gates: OrchGate[] = [{ id: 'g1', runId: I.runBoard, taskId: 't4', question: 'Persist card ordering in SQLite or localStorage?', options: ['SQLite', 'localStorage'], status: 'open', resolution: null, createdAt: now - 6 * MIN, resolvedAt: null, blocking: true }]
  const counts = (ts: OrchTask[]) => ts.reduce<Record<string, number>>((m, t) => ((m[t.status] = (m[t.status] ?? 0) + 1), m), {})
  const run1: OrchRun = {
    id: I.runBoard, objective: 'Demo task board', coordinatorHandle: 'term_c09d', coordinatorSessionId: I.waiting, legacy: false, createdAt: now - 126 * MIN, updatedAt: now - MIN, lastActivityAt: now - 12_000,
    taskCount: tasks.length, statusCounts: counts(tasks), dispatchCount: dispatches.length, messageCount: messages.length, hasBlockingGate: true,
  }
  const t2tasks = ['Compare Recharts', 'Compare visx', 'Compare uPlot'].map((title, i) => mk(`s${i + 1}`, I.runSpike, title, 'ready', [], { createdAt: now - 10 * MIN, createdByHandle: 'term_f7b1' }))
  const run2: OrchRun = {
    id: I.runSpike, objective: 'Spike: evaluate three charting libraries', coordinatorHandle: 'term_f7b1', coordinatorSessionId: null, legacy: false, createdAt: now - 10 * MIN, updatedAt: now - 9 * MIN, lastActivityAt: now - 9 * MIN,
    taskCount: 3, statusCounts: counts(t2tasks), dispatchCount: 0, messageCount: 0, hasBlockingGate: false,
  }
  world.runs = [
    { run: run1, tasks, dispatches, messages, gates },
    { run: run2, tasks: t2tasks, dispatches: [], messages: [], gates: [] },
  ]
  // wire the coordinator ↔ worker linkage into the session summary
  const coord = world.sessions.get(I.waiting)!
  if (coord.orca) coord.orca = { ...coord.orca, runId: I.runBoard, role: 'coordinator' }
}

/** Recompute counters, tokens, cost, child lists for every session from the event list. */
export function recomputeAll(world: MockWorld) {
  for (const s of world.sessions.values()) { s.childIds = []; s.descendantCount = 0 }
  for (const s of world.sessions.values()) {
    if (s.parentId) world.sessions.get(s.parentId)?.childIds.push(s.id)
  }
  for (const s of world.sessions.values()) {
    s.childIds.sort((a, b) => world.sessions.get(a)!.createdAt - world.sessions.get(b)!.createdAt)
    if (s.parentId == null) s.descendantCount = s.childIds.length
  }
  for (const s of world.sessions.values()) recomputeSession(world, s.id)
}

export function recomputeSession(world: MockWorld, id: string) {
  const s = world.sessions.get(id)
  if (!s) return
  const evs = world.events.filter((e) => e.sessionId === id)
  const tokens: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let cost = 0
  const files = new Set<string>()
  const msgs = new Set<string>()
  let tools = 0, toolErrors = 0, mcp = 0, fileChanges = 0, steps = 0, thinking = 0
  for (const e of evs) {
    if (e.messageId) msgs.add(e.messageId)
    if (e.usage) { cost += e.usage.cost; for (const k of Object.keys(tokens) as Array<keyof TokenUsage>) tokens[k] += e.usage.tokens[k] }
    if (e.kind === 'step') steps++
    if (e.kind === 'thinking') thinking++
    if (e.kind === 'mcp') mcp++
    if (e.kind === 'file-change') fileChanges++
    if (e.tool && e.kind !== 'subagent') { tools++; if (e.status === 'error') toolErrors++ }
    e.files.forEach((f) => files.add(f))
  }
  s.tokens = tokens
  s.cost = Math.round(cost * 100) / 100
  s.counters = { messages: msgs.size, steps, thinking, tools, toolErrors, mcpCalls: mcp, fileChanges, filesTouched: files.size, subagents: s.childIds.length }
}

/** Build `FileChange` rows from file-change events. */
export function fileChangesOf(world: MockWorld): FileChange[] {
  const out: FileChange[] = []
  for (const e of world.events) {
    if (e.kind !== 'file-change' || !e.sessionId || !e.rootId || !e.files[0]) continue
    const s = world.sessions.get(e.sessionId)
    const diff = world.diffs.get(e.id)
    let add: number | null = null, del: number | null = null
    if (diff?.text) {
      const lines = diff.text.split('\n')
      if (diff.format === 'new-file') { add = lines.filter((l) => l !== '').length; del = 0 }
      else { add = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length; del = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length }
    }
    const root = s?.workspace?.path ?? null
    out.push({
      id: e.id, sessionId: e.sessionId, rootId: e.rootId, harness: e.harness, ts: e.ts, path: e.files[0], workspaceRoot: root,
      relPath: root && e.files[0].startsWith(root) ? e.files[0].slice(root.length + 1) : null, kind: diff?.format === 'new-file' ? 'write' : 'edit', tool: e.tool?.name ?? null, status: e.status ?? 'completed', additions: add, deletions: del,
    })
  }
  return out
}

export function artifactsOf(world: MockWorld): Artifact[] {
  const out: Artifact[] = []
  for (const c of fileChangesOf(world)) {
    if (c.path.endsWith('.md') || c.path.endsWith('.yml')) {
      out.push({ id: `art:${c.id}`, kind: c.path.endsWith('.md') ? 'document' : 'new-file', label: c.path.split('/').pop()!, path: c.path, url: null, sessionId: c.sessionId, rootId: c.rootId, ts: c.ts, source: 'file-change' })
    }
  }
  for (const e of world.events) {
    for (const u of e.links) {
      if (!e.sessionId || !e.rootId) continue
      out.push({ id: `art:${e.id}:${u}`, kind: /\/pull\/\d+/.test(u) ? 'pull-request' : 'url', label: /\/pull\/(\d+)/.exec(u) ? `PR #${/\/pull\/(\d+)/.exec(u)![1]}` : u.replace(/^https?:\/\//, ''), path: null, url: u, sessionId: e.sessionId, rootId: e.rootId, ts: e.ts, source: e.source })
    }
  }
  // de-dupe by (kind,url|path)
  const seen = new Set<string>()
  return out.filter((a) => { const k = `${a.kind}:${a.url ?? a.path}`; if (seen.has(k)) return false; seen.add(k); return true })
}

export function orchestrationSummary(world: MockWorld, scenario: 'healthy' | 'degraded'): OrchestrationSummary {
  const degraded = scenario === 'degraded'
  return {
    available: true, schemaVersion: degraded ? 44 : 43, testedSchemaVersion: 43,
    degraded: degraded ? ['Worker heartbeat times are unavailable (worker_dispatches.last_heartbeat_at column missing).', 'Decision-gate options are shown as plain text.'] : [],
    runs: world.runs.map((r) => r.run),
  }
}

export function metaOf(world: MockWorld, scenario: 'healthy' | 'degraded', bootId: string, now: number): ServerMeta {
  return {
    app: 'orca-command-center', version: '0.1.0', bootId, startedAt: world.now - 3 * MIN, now, host: '127.0.0.1', port: 4270, readOnly: true, windowMs: 24 * 3_600_000,
    sources: world.sources, orca: world.orca.status,
  }
}

export type { SourceHealth }
