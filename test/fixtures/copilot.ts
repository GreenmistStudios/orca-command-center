/**
 * Copilot CLI session-state fixture: builds `<root>/session-state/<uuid>/{workspace.yaml,events.jsonl,
 * inuse.<pid>.lock}` on disk with realistic event shapes (data-sources §2), plus decoy files that the
 * source must never read.
 */
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const FAKE_TOKEN = 'ghp_' + 'FAKEdecoyTokenThatMustNeverAppear0123456789'
/** Secret embedded in a bash command: the source must redact it from every output. */
export const FAKE_COMMAND_SECRET = 'ghp_' + 'FAKEsecretInsideCommand0123456789ABCDEF'
export const ENCRYPTED_SENTINEL = 'ENCRYPTED-CONTENT-SENTINEL'
export const OPAQUE_SENTINEL = 'REASONING-OPAQUE-SENTINEL'
export const DEAD_PID = 999999

export interface RawEvent {
  id: string
  parentId: string | null
  timestamp: string
  type: string
  data: Record<string, unknown>
}

export interface WorkspaceInput {
  name?: string
  cwd?: string
  createdAt?: string
  updatedAt?: string
  userNamed?: boolean
  summaryCount?: number
}

export interface CopilotFixture {
  /** The fake ~/.copilot (use as Config.copilotDir). */
  readonly root: string
  readonly sessionState: string
  /** Current fixture clock (ms); advances 1 s per generated event. */
  clock(): number
  setClock(ms: number): void
  /** Build an event envelope without writing it. */
  event(type: string, data?: Record<string, unknown>, opts?: { at?: number; id?: string }): RawEvent
  createSession(id: string, opts?: { workspace?: WorkspaceInput | false; events?: RawEvent[] }): string
  writeWorkspace(id: string, ws: WorkspaceInput): void
  /** Append events as complete JSONL lines. */
  append(id: string, events: RawEvent[]): void
  /** Append raw text (e.g. a partial line without trailing newline). */
  appendRaw(id: string, text: string): void
  /** Overwrite events.jsonl (rotation / truncation). */
  rewrite(id: string, events: RawEvent[]): void
  lock(id: string, pid?: number): string
  unlock(id: string, pid?: number): void
  /** Decoy secret files under the root (config.json with FAKE_TOKEN, session-store.db, logs/, …), chmod 000. */
  addDecoys(): string[]
  removeSession(id: string): void
  /** Event builders. */
  ev: {
    sessionStart(o?: { model?: string; cwd?: string; version?: string }): RawEvent
    user(content: string, o?: { turnId?: string; messageId?: string }): RawEvent
    turnStart(turnId: string): RawEvent
    turnEnd(turnId: string): RawEvent
    assistant(turnId: string, o: { content?: string; reasoning?: string; model?: string }): RawEvent
    toolStart(callId: string, name: string, args: unknown, o?: { turnId?: string; model?: string }): RawEvent
    toolComplete(callId: string, o?: { success?: boolean; result?: unknown; error?: unknown; metrics?: Record<string, unknown> }): RawEvent
    permRequested(requestId: string, o: { toolCallId?: string; kind?: string; command?: string }): RawEvent
    permCompleted(requestId: string, o?: { toolCallId?: string; kind?: string }): RawEvent
    usage(premium: number): RawEvent
    autoMode(chosen: string): RawEvent
    error(message: string): RawEvent
    abort(reason: string): RawEvent
    shutdown(): RawEvent
  }
}

const q = (v: string) => JSON.stringify(v)

function workspaceYaml(id: string, ws: WorkspaceInput): string {
  const lines = [`id: ${id}`]
  if (ws.cwd) lines.push(`cwd: ${ws.cwd}`, `git_root: ${ws.cwd}`, 'branch: main')
  lines.push('client_name: copilot-cli')
  if (ws.name !== undefined) lines.push(`name: ${q(ws.name)}`)
  lines.push(`user_named: ${ws.userNamed ? 'true' : 'false'}`)
  lines.push(`summary_count: ${ws.summaryCount ?? 0}`, 'fork_count: 0')
  if (ws.createdAt) lines.push(`created_at: ${ws.createdAt}`)
  if (ws.updatedAt) lines.push(`updated_at: ${ws.updatedAt}`)
  lines.push('remote_steerable: false')
  return lines.join('\n') + '\n'
}

export function createCopilotFixture(root: string, opts: { startMs?: number } = {}): CopilotFixture {
  const sessionState = path.join(root, 'session-state')
  mkdirSync(sessionState, { recursive: true })
  let clockMs = opts.startMs ?? Date.parse('2026-10-26T09:00:00.000Z')
  let n = 0
  const dirOf = (id: string) => path.join(sessionState, id)
  const eventsOf = (id: string) => path.join(dirOf(id), 'events.jsonl')
  const serialize = (events: RawEvent[]) => events.map((e) => JSON.stringify(e) + '\n').join('')

  const event: CopilotFixture['event'] = (type, data = {}, o = {}) => {
    clockMs = o.at ?? clockMs + 1000
    n++
    return {
      id: o.id ?? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      parentId: null,
      timestamp: new Date(clockMs).toISOString(),
      type,
      data,
    }
  }

  const ev: CopilotFixture['ev'] = {
    sessionStart: (o = {}) =>
      event('session.start', {
        sessionId: 'x',
        version: 1,
        producer: 'copilot-agent',
        copilotVersion: o.version ?? '1.0.40',
        startTime: new Date(clockMs).toISOString(),
        selectedModel: o.model ?? 'auto',
        context: { cwd: o.cwd ?? '/work/repo', gitRoot: o.cwd ?? '/work/repo', branch: 'main' },
        alreadyInUse: false,
        remoteSteerable: false,
      }),
    user: (content, o = {}) =>
      event('user.message', {
        content,
        transformedContent: `<current_datetime>x</current_datetime>${content}`,
        messageId: o.messageId ?? `msg-${n + 1}`,
        interactionId: 'int-1',
        turnId: o.turnId ?? `uturn-${n + 1}`,
      }),
    turnStart: (turnId) => event('assistant.turn_start', { turnId, interactionId: 'int-1' }),
    turnEnd: (turnId) => event('assistant.turn_end', { turnId }),
    assistant: (turnId, o) =>
      event('assistant.message', {
        messageId: `am-${n + 1}`,
        model: o.model ?? 'claude-sonnet-5.5',
        content: o.content ?? '',
        toolRequests: [],
        interactionId: 'int-1',
        turnId,
        reasoningOpaque: o.reasoning ? OPAQUE_SENTINEL : undefined,
        reasoningText: o.reasoning ?? '',
        encryptedContent: ENCRYPTED_SENTINEL,
        reasoningBlocks: o.reasoning ? { provider: 'anthropic', blocks: [{ signature: OPAQUE_SENTINEL, thinking: o.reasoning, type: 'thinking' }] } : undefined,
      }),
    toolStart: (callId, name, args, o = {}) =>
      event('tool.execution_start', { toolCallId: callId, toolName: name, arguments: args, turnId: o.turnId ?? '1', model: o.model ?? 'claude-sonnet-5.5' }),
    toolComplete: (callId, o = {}) =>
      event('tool.execution_complete', {
        toolCallId: callId,
        model: 'claude-sonnet-5.5',
        turnId: '1',
        success: o.success ?? true,
        ...(o.success === false ? { error: o.error ?? { message: 'tool failed', code: 'failure' } } : { result: o.result ?? { content: 'ok', detailedContent: 'ok' } }),
        toolTelemetry: { properties: {}, metrics: o.metrics ?? {}, restrictedProperties: {} },
      }),
    permRequested: (requestId, o) =>
      event('permission.requested', {
        requestId,
        permissionRequest: { kind: o.kind ?? 'shell', toolCallId: o.toolCallId, fullCommandText: o.command ?? 'npm test', intention: 'Run tests', commands: [], possiblePaths: [] },
        promptRequest: { kind: 'commands', toolCallId: o.toolCallId },
        agentMode: 'interactive',
      }),
    permCompleted: (requestId, o = {}) => event('permission.completed', { requestId, toolCallId: o.toolCallId, result: { kind: o.kind ?? 'approved' } }),
    usage: (premium) => event('session.usage_checkpoint', { totalPremiumRequests: premium, totalNanoAiu: 0 }),
    autoMode: (chosen) => event('session.auto_mode_resolved', { chosenModel: chosen, routingMethod: 'router' }),
    error: (message) => event('session.error', { errorType: 'query', message }),
    abort: (reason) => event('abort', { reason }),
    shutdown: () => event('session.shutdown', { shutdownType: 'routine', totalPremiumRequests: 1 }),
  }

  const fx: CopilotFixture = {
    root,
    sessionState,
    clock: () => clockMs,
    setClock: (ms) => {
      clockMs = ms
    },
    event,
    createSession(id, o = {}) {
      mkdirSync(dirOf(id), { recursive: true })
      if (o.workspace !== false) writeFileSync(path.join(dirOf(id), 'workspace.yaml'), workspaceYaml(id, o.workspace ?? {}))
      if (o.events) writeFileSync(eventsOf(id), serialize(o.events))
      return dirOf(id)
    },
    writeWorkspace(id, ws) {
      writeFileSync(path.join(dirOf(id), 'workspace.yaml'), workspaceYaml(id, ws))
    },
    append: (id, events) => appendFileSync(eventsOf(id), serialize(events)),
    appendRaw: (id, text) => appendFileSync(eventsOf(id), text),
    rewrite: (id, events) => writeFileSync(eventsOf(id), serialize(events)),
    lock(id, pid = process.pid) {
      const f = path.join(dirOf(id), `inuse.${pid}.lock`)
      writeFileSync(f, String(pid))
      return f
    },
    unlock(id, pid = process.pid) {
      rmSync(path.join(dirOf(id), `inuse.${pid}.lock`), { force: true })
    },
    addDecoys() {
      const files = [
        path.join(root, 'config.json'),
        path.join(root, 'command-history-state.json'),
        path.join(root, 'session-store.db'),
        path.join(root, 'logs', 'process.log'),
        path.join(root, 'ide', 'lock.json'),
      ]
      for (const f of files) {
        mkdirSync(path.dirname(f), { recursive: true })
        writeFileSync(f, JSON.stringify({ token: FAKE_TOKEN, note: FAKE_TOKEN }))
        chmodSync(f, 0o000)
      }
      return files
    },
    removeSession: (id) => rmSync(dirOf(id), { recursive: true, force: true }),
    ev,
  }
  return fx
}

export interface CopilotFleet {
  fixture: CopilotFixture
  finishedId: string
  liveId: string
  /** Tool call ids in the finished session. */
  calls: Record<'bash' | 'view' | 'rg' | 'create' | 'patch' | 'mcp' | 'failed' | 'edit', string>
  liveBashCall: string
  livePermissionRequest: string
  decoys: string[]
}

/**
 * finishedId: done session (workspace name "Fix the login bug"; bash, view, rg, create, edit, apply_patch,
 *   github-mcp-server-get_issue, one failed tool; no lock) → transcriptState 'done', processAlive false.
 * liveId: no workspace name; open turn, running bash and a pending permission request, live lock
 *   (process.pid) → transcriptState 'waiting', processAlive true, current = bash.
 * All timestamps lie within the last ~10 minutes of `now`.
 */
export function seedCopilotFleet(root: string, opts: { now?: number } = {}): CopilotFleet {
  const now = opts.now ?? Date.now()
  const fx = createCopilotFixture(root, { startMs: now - 10 * 60_000 })
  const finishedId = 'aaaaaaaa-0000-4000-8000-000000000001'
  const liveId = 'bbbbbbbb-0000-4000-8000-000000000002'
  const calls = { bash: 'call-bash', view: 'call-view', rg: 'call-rg', create: 'call-create', patch: 'call-patch', mcp: 'call-mcp', failed: 'call-failed', edit: 'call-edit' } as const
  const e = fx.ev
  const patch = '*** Begin Patch\n*** Update File: /work/repo/src/app.ts\n@@\n-old line\n+new line\n*** End Patch\n'

  fx.createSession(finishedId, {
    workspace: { name: 'Fix the login bug', cwd: '/work/repo', createdAt: new Date(now - 10 * 60_000).toISOString(), updatedAt: new Date(now - 5 * 60_000).toISOString(), userNamed: true },
    events: [
      e.sessionStart({ model: 'auto', cwd: '/work/repo' }),
      e.autoMode('claude-sonnet-5.5'),
      e.user('Please fix the login bug in src/app.ts. See https://example.com/issues/42'),
      e.turnStart('1'),
      e.assistant('1', { reasoning: 'I should look at the file first.', content: 'Looking at the code.' }),
      e.toolStart(calls.view, 'view', { path: '/work/repo/src/app.ts', view_range: [1, 40] }),
      e.toolComplete(calls.view, { result: { content: 'line 1\nline 2', detailedContent: 'line 1\nline 2' } }),
      e.toolStart(calls.rg, 'rg', { pattern: 'login', path: '/work/repo' }),
      e.toolComplete(calls.rg, { result: { content: 'src/app.ts:3: login()' } }),
      e.toolStart(calls.bash, 'bash', { command: `echo ${FAKE_COMMAND_SECRET} && npm test`, description: 'Run tests' }),
      e.permRequested('perm-1', { toolCallId: calls.bash, kind: 'shell', command: 'npm test' }),
      e.permCompleted('perm-1', { toolCallId: calls.bash }),
      e.toolComplete(calls.bash, { result: { content: 'all tests passed', detailedContent: 'all tests passed' } }),
      e.toolStart(calls.create, 'create', { path: '/work/repo/src/new.ts', file_text: 'export const x = 1\n' }),
      e.toolComplete(calls.create, { metrics: { linesAdded: 1, linesRemoved: 0 } }),
      e.toolStart(calls.edit, 'edit', { path: '/work/repo/src/app.ts', old_str: 'old', new_str: 'new' }),
      e.toolComplete(calls.edit, { metrics: { linesAdded: 1, linesRemoved: 1 } }),
      e.toolStart(calls.patch, 'apply_patch', patch),
      e.toolComplete(calls.patch),
      e.toolStart(calls.mcp, 'github-mcp-server-get_issue', { owner: 'acme', repo: 'repo', issue_number: 42 }),
      e.toolComplete(calls.mcp, { result: { content: '{"title":"Login broken","html_url":"https://github.com/acme/repo/issues/42"}' } }),
      e.toolStart(calls.failed, 'bash', { command: 'false' }),
      e.toolComplete(calls.failed, { success: false, error: { message: 'exit code 1' } }),
      e.assistant('1', { content: 'Fixed the bug.' }),
      e.turnEnd('1'),
      e.usage(3),
    ],
  })

  const liveBashCall = 'call-live-bash'
  const livePermissionRequest = 'perm-live'
  fx.createSession(liveId, {
    workspace: { cwd: '/work/other', createdAt: new Date(now - 4 * 60_000).toISOString(), updatedAt: new Date(now - 60_000).toISOString() },
    events: [
      e.sessionStart({ model: 'gpt-5', cwd: '/work/other' }),
      e.user('Run the full test suite'),
      e.turnStart('1'),
      e.assistant('1', { reasoning: 'Running tests.', model: 'gpt-5' }),
      e.toolStart(liveBashCall, 'bash', { command: 'npm run test:all', description: 'Run all tests' }, { model: 'gpt-5' }),
      e.permRequested(livePermissionRequest, { toolCallId: liveBashCall, kind: 'shell', command: 'npm run test:all' }),
    ],
  })
  fx.lock(liveId)
  const decoys = fx.addDecoys()
  return { fixture: fx, finishedId, liveId, calls, liveBashCall, livePermissionRequest, decoys }
}
