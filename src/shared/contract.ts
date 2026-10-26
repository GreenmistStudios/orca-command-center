/**
 * Orca Command Center — shared server/client contract.
 *
 * Single source of truth for every type that crosses the HTTP/SSE boundary. Authored by the
 * product plan (Plan.md §10). Implementation tasks MUST NOT rename or remove fields here. If a
 * task genuinely needs a new field, add it as OPTIONAL and call it out in the task report.
 *
 * Conventions
 * - All timestamps are epoch milliseconds (`EpochMs`). Sources convert ISO / SQL strings.
 * - Every user-visible string that originated in an agent transcript has already been
 *   redacted (secrets) and truncated by the server. The client never receives raw `data:` URLs.
 * - `null` means "unknown / not recorded", never "zero".
 */

export type EpochMs = number

/* ────────────────────────────── Harnesses ────────────────────────────── */

/** The agent runtime ("harness") that produced a session. */
export type Harness = 'opencode' | 'copilot' | 'claude' | 'codex' | 'unknown'

export const HARNESS_META: Record<Harness, { label: string; monogram: string }> = {
  opencode: { label: 'OpenCode', monogram: 'OC' },
  copilot: { label: 'Copilot CLI', monogram: 'CP' },
  claude: { label: 'Claude Code', monogram: 'CC' },
  codex: { label: 'Codex', monogram: 'CX' },
  unknown: { label: 'Unknown', monogram: '??' },
}

/* ────────────────────────────── Agent state ──────────────────────────── */

/**
 * What an agent session is doing right now.
 * - working: generating or running tools
 * - blocked: waiting on a permission decision from the user
 * - waiting: asked the user a question / awaiting input
 * - error:   last turn ended in an error
 * - done:    finished its turn recently
 * - idle:    no activity for a while (see Plan.md §9.1 thresholds)
 * - unknown: cannot be determined honestly (e.g. a "working" transcript that went silent)
 */
export type AgentState = 'working' | 'blocked' | 'waiting' | 'error' | 'done' | 'idle' | 'unknown'

/** Lower = more urgent. Used to sort the fleet rail and attention. */
export const AGENT_STATE_PRIORITY: Record<AgentState, number> = {
  blocked: 0,
  waiting: 1,
  working: 2,
  error: 3,
  unknown: 4,
  done: 5,
  idle: 6,
}

/** Where a session's `state` came from — shown in the UI as provenance. */
export type StateSource = 'orca-hook' | 'transcript' | 'parent-tool' | 'orchestration' | 'none'

/* ─────────────────────────── Activity taxonomy ───────────────────────── */

export type ToolCategory =
  | 'shell'
  | 'read'
  | 'search'
  | 'edit'
  | 'write'
  | 'patch'
  | 'web'
  | 'subagent'
  | 'todo'
  | 'question'
  | 'skill'
  | 'mcp'
  | 'plugin'
  | 'other'

/**
 * One row in the activity stream.
 * - prompt:        a user / task prompt (user message text, subagent task prompt)
 * - thinking:      model reasoning
 * - text:          assistant visible text
 * - tool:          a non-MCP tool call (shell, read, search, web, question, skill, plugin…)
 * - mcp:           a tool call served by an MCP server
 * - file-change:   edit / write / create / patch of files (tool call or step snapshot)
 * - subagent:      a call that spawned a child agent session (OpenCode `task` tool)
 * - todo:          the agent updated its todo list
 * - step:          an LLM step finished (tokens + cost). Hidden by default in the UI.
 * - state:         an agent state transition observed by Orca hooks (busy → idle …)
 * - permission:    a permission request (or its resolution)
 * - error:         message-level / session-level error (API error, abort). Tool failures are
 *                  NOT this kind — they keep their tool kind with status 'error'.
 * - orchestration: an Orca orchestration message (worker_done, question, escalation, gate…)
 */
export type ActivityKind =
  | 'prompt'
  | 'thinking'
  | 'text'
  | 'tool'
  | 'mcp'
  | 'file-change'
  | 'subagent'
  | 'todo'
  | 'step'
  | 'state'
  | 'permission'
  | 'error'
  | 'orchestration'

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  'prompt',
  'thinking',
  'text',
  'tool',
  'mcp',
  'file-change',
  'subagent',
  'todo',
  'step',
  'state',
  'permission',
  'error',
  'orchestration',
]

export type ActivityStatus = 'pending' | 'running' | 'completed' | 'error'

/** Server-side truncation budgets. The client may rely on these as upper bounds. */
export const LIMITS = {
  titleChars: 140,
  summaryChars: 600,
  toolInputChars: 400,
  toolOutputChars: 800,
  promptChars: 280,
  linksPerEvent: 5,
  partDetailBytes: 262_144,
  diffBytes: 524_288,
  bootstrapActivity: 500,
  activityPageMax: 5_000,
  transcriptPageDefault: 40,
  transcriptPageMax: 200,
} as const

/* ─────────────────────────────── Usage ───────────────────────────────── */

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelRef {
  providerId: string | null
  modelId: string
}

/* ─────────────────────────────── Activity ────────────────────────────── */

export interface ToolCallInfo {
  /** Raw tool name as the harness recorded it, e.g. "bash", "atlassian_jira_get_issue". */
  name: string
  /** Name for display: MCP server prefix removed, e.g. "jira_get_issue". */
  displayName: string
  category: ToolCategory
  /** MCP server name when category === 'mcp', e.g. "atlassian". */
  mcpServer: string | null
  callId: string | null
  /** Compact, redacted one-line input preview (command / file path / pattern / JSON). */
  input: string | null
  /** Redacted, ANSI-stripped output preview. */
  output: string | null
  error: string | null
  durationMs: number | null
  /** True if input or output was cut. Full content: GET /api/parts/:detailRef */
  truncated: boolean
}

export interface ActivityEvent {
  /**
   * Globally unique and stable across updates of the same underlying item:
   * `${harness}:${nativeId}` (e.g. "opencode:prt_…", "copilot:<sessionId>:<toolCallId>"),
   * `orca-hook:${paneKey}:${receivedAt}`, `orch:${messageId}`.
   */
  id: string
  /** Increases on each update of the same id (source update time in ms). Keep the highest. */
  rev: number
  harness: Harness
  sessionId: string | null
  rootId: string | null
  messageId: string | null
  /** Start time. */
  ts: EpochMs
  /** End time when the item has a duration (tool call, thinking block). */
  endTs: EpochMs | null
  kind: ActivityKind
  status: ActivityStatus | null
  /** One-line headline, ≤ LIMITS.titleChars, e.g. "bash · npm test", "Edited src/app.ts". */
  title: string
  /** Preview text ≤ LIMITS.summaryChars (thinking text, assistant text, tool output…). */
  summary: string | null
  tool: ToolCallInfo | null
  /** Absolute paths touched by this item (edit/write/patch/read). */
  files: string[]
  /** For kind 'subagent': the spawned child session id once known. */
  childSessionId: string | null
  /** For kind 'step' (and assistant messages): usage. */
  usage: { tokens: TokenUsage; cost: number } | null
  /** http(s) URLs found in the FULL text/output (≤ LIMITS.linksPerEvent). Feeds artifacts. */
  links: string[]
  /** Provenance tag, e.g. "opencode.part", "opencode.event", "orca.hooks", "copilot.events". */
  source: string
  /** Id for GET /api/parts/:id (full detail), or null when no detail exists. */
  detailRef: string | null
}

export interface ActivityPage {
  /** Ordered oldest → newest. */
  events: ActivityEvent[]
  /** Opaque cursor for the next (older) page, or null. */
  before: string | null
  hasMore: boolean
}

/* ─────────────────────────────── Sessions ────────────────────────────── */

export interface SessionCounters {
  messages: number
  steps: number
  thinking: number
  tools: number
  toolErrors: number
  mcpCalls: number
  fileChanges: number
  filesTouched: number
  subagents: number
}

export interface CurrentActivity {
  kind: ActivityKind
  /** e.g. "bash", "Thinking", "jira_get_issue", "Writing response" */
  label: string
  /** e.g. the command, file path, or MCP server */
  detail: string | null
  since: EpochMs
  activityId: string | null
}

/** Present on subagent sessions: the parent tool call that spawned it. */
export interface SpawnInfo {
  parentSessionId: string
  activityId: string
  callId: string | null
  description: string
  subagentType: string | null
  status: ActivityStatus
}

/** Grouping key for the fleet rail (a repo/worktree/folder). */
export interface WorkspaceRef {
  /** Stable key: Orca worktreeId when linked, else the normalized directory path. */
  key: string
  name: string
  path: string | null
  repo: string | null
  branch: string | null
}

/** How a session is connected to Orca (terminal pane, worktree, orchestration). */
export interface OrcaLink {
  paneKey: string | null
  tabId: string | null
  terminalHandle: string | null
  terminalTitle: string | null
  worktreeId: string | null
  hookEvent: string | null
  hookState: string | null
  hookAt: EpochMs | null
  /** Orchestration linkage when this session is a coordinator or a dispatched worker. */
  runId: string | null
  taskId: string | null
  dispatchId: string | null
  role: 'coordinator' | 'worker' | null
}

export interface SessionSummary {
  /** Harness-native id, e.g. "ses_…" (OpenCode) or a UUID (Copilot). */
  id: string
  harness: Harness
  parentId: string | null
  rootId: string
  /** 0 for a root session, 1 for its subagents, … */
  depth: number
  title: string
  /** Agent / mode name, e.g. "build", "sonnet-coder", "explore". */
  agent: string | null
  model: ModelRef | null
  directory: string | null
  workspace: WorkspaceRef | null
  createdAt: EpochMs
  updatedAt: EpochMs
  lastActivityAt: EpochMs | null
  archivedAt: EpochMs | null
  state: AgentState
  stateSource: StateSource
  stateSince: EpochMs | null
  /** working/blocked/waiting, or any activity within the live threshold (Plan.md §9.1). */
  live: boolean
  current: CurrentActivity | null
  lastPrompt: string | null
  lastMessage: string | null
  /** null until computed (lazy). */
  counters: SessionCounters | null
  tokens: TokenUsage
  cost: number
  /** Direct children (subagents), oldest first. */
  childIds: string[]
  descendantCount: number
  spawn: SpawnInfo | null
  orca: OrcaLink | null
  /** Harness-specific facts for the Info tab, e.g. { label: 'Premium requests', value: '12' }. */
  facts: Array<{ label: string; value: string }>
}

export interface TodoItem {
  id: string
  content: string
  /** Usually 'pending' | 'in_progress' | 'completed' | 'cancelled'. Unknown values pass through. */
  status: string
  /** Usually 'high' | 'medium' | 'low'. */
  priority: string
  position: number
}

export type FileChangeKind = 'edit' | 'write' | 'create' | 'patch' | 'delete'

export interface FileChange {
  /** The ActivityEvent id this change came from. */
  id: string
  sessionId: string
  rootId: string
  harness: Harness
  ts: EpochMs
  path: string
  workspaceRoot: string | null
  relPath: string | null
  kind: FileChangeKind
  tool: string | null
  status: ActivityStatus
  additions: number | null
  deletions: number | null
}

export interface FileDiff {
  id: string
  path: string
  /** unified: a unified diff; new-file: full new content; patch-text: an apply_patch body. */
  format: 'unified' | 'new-file' | 'patch-text' | 'none'
  text: string | null
  note: string | null
  truncated: boolean
}

export type ArtifactKind = 'document' | 'new-file' | 'pull-request' | 'url' | 'image' | 'report'

export interface Artifact {
  id: string
  kind: ArtifactKind
  label: string
  path: string | null
  url: string | null
  sessionId: string
  rootId: string
  ts: EpochMs
  source: string
}

export interface SessionDetail {
  session: SessionSummary
  /** Root first, ending with the direct parent. Empty for a root session. */
  ancestors: SessionSummary[]
  /** Direct children. */
  children: SessionSummary[]
  todos: TodoItem[]
  fileChanges: FileChange[]
  artifacts: Artifact[]
  /** Human-readable list of the sources that contributed, e.g. "opencode.db · session". */
  provenance: string[]
}

export interface SessionEdge {
  id: string
  from: string
  to: string
  label: string | null
  status: ActivityStatus | null
  activityId: string | null
}

export interface SessionTree {
  rootId: string
  /** Root + every descendant. */
  nodes: SessionSummary[]
  edges: SessionEdge[]
  /** Set when the root session is the coordinator of an Orca orchestration run. */
  orchestration: { runId: string; taskIds: string[] } | null
}

export interface TranscriptMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  agent: string | null
  model: ModelRef | null
  createdAt: EpochMs
  completedAt: EpochMs | null
  tokens: TokenUsage | null
  cost: number | null
  finish: string | null
  error: string | null
  /** Normalized parts in order. */
  items: ActivityEvent[]
}

export interface TranscriptPage {
  sessionId: string
  /** Ordered oldest → newest. */
  messages: TranscriptMessage[]
  /** Cursor for the previous (older) page, or null. */
  before: string | null
  hasMore: boolean
}

export interface PartDetail {
  id: string
  sessionId: string
  kind: ActivityKind
  title: string
  text: string | null
  /** Redacted structured input (tool calls). */
  input: unknown
  output: string | null
  error: string | null
  /** Redacted harness metadata (no signatures, no data URLs). */
  metadata: unknown
  truncated: boolean
}

/* ──────────────────────────────── Orca ───────────────────────────────── */

export interface OrcaStatus {
  running: boolean
  reachable: boolean
  pid: number | null
  version: string | null
  runtimeState: string | null
  checkedAt: EpochMs
  error: string | null
}

export interface WorktreeLinkRef {
  kind: 'pr' | 'issue' | 'other'
  label: string
  url: string | null
}

export interface WorktreeInfo {
  id: string
  repoId: string | null
  repo: string | null
  path: string
  /** Branch name with "refs/heads/" stripped. */
  branch: string | null
  displayName: string | null
  status: string | null
  workspaceStatus: string | null
  isActive: boolean
  isMainWorktree: boolean
  liveTerminalCount: number
  lastActivityAt: EpochMs | null
  lastOutputAt: EpochMs | null
  links: WorktreeLinkRef[]
}

export interface TerminalInfo {
  handle: string
  worktreeId: string | null
  worktreePath: string | null
  tabId: string | null
  leafId: string | null
  /** `${tabId}:${leafId}` — joins to HookEntry.paneKey. */
  paneKey: string | null
  title: string | null
  agentIdentity: string | null
  connected: boolean
  lastOutputAt: EpochMs | null
  /** ANSI-stripped, redacted, ≤ 300 chars. */
  preview: string | null
  /** Resolved by the store via hooks (null when unknown). */
  sessionId: string | null
}

export interface HookEntry {
  paneKey: string
  tabId: string | null
  worktreeId: string | null
  agent: string | null
  hookEvent: string | null
  /** Orca agent status: 'working' | 'blocked' | 'waiting' | 'done' (unknown values pass through). */
  state: string | null
  prompt: string | null
  lastAssistantMessage: string | null
  providerSessionId: string | null
  receivedAt: EpochMs | null
  stateStartedAt: EpochMs | null
}

export interface OrcaSnapshot {
  status: OrcaStatus
  worktrees: WorktreeInfo[]
  terminals: TerminalInfo[]
  hooks: HookEntry[]
}

/* ──────────────────────────── Orchestration ──────────────────────────── */

/** Usually pending | ready | dispatched | completed | failed | blocked. Unknown values pass through. */
export type OrchTaskStatus = string

export interface OrchRun {
  id: string
  objective: string
  coordinatorHandle: string | null
  coordinatorSessionId: string | null
  legacy: boolean
  createdAt: EpochMs | null
  updatedAt: EpochMs | null
  lastActivityAt: EpochMs | null
  taskCount: number
  statusCounts: Record<string, number>
  dispatchCount: number
  messageCount: number
  hasBlockingGate: boolean
}

export interface OrchTask {
  id: string
  runId: string
  parentId: string | null
  title: string
  specPreview: string
  specTruncated: boolean
  status: OrchTaskStatus
  deps: string[]
  createdAt: EpochMs | null
  completedAt: EpochMs | null
  resultPreview: string | null
  createdByHandle: string | null
  attemptCount: number
  latestDispatchId: string | null
}

export interface OrchDispatch {
  id: string
  runId: string
  taskId: string
  /** pending | dispatched | completed | failed | circuit_broken (unknown values pass through). */
  status: string
  assigneeHandle: string | null
  assigneeSessionId: string | null
  dispatchedAt: EpochMs | null
  completedAt: EpochMs | null
  lastHeartbeatAt: EpochMs | null
  failureCount: number
  lastFailure: string | null
  terminationReason: string | null
  depth: number | null
  /** worker_dispatches.state when present (starting | ready | succeeded | failed | …). */
  workerState: string | null
}

export interface OrchMessage {
  id: string
  runId: string
  sequence: number
  from: string
  to: string
  subject: string
  bodyPreview: string
  /** status | dispatch | worker_done | merge_ready | escalation | handoff | decision_gate | question | heartbeat */
  type: string
  priority: string
  threadId: string | null
  taskId: string | null
  createdAt: EpochMs | null
}

export interface OrchGate {
  id: string
  runId: string
  taskId: string
  question: string
  options: string[]
  status: string
  resolution: string | null
  createdAt: EpochMs | null
  resolvedAt: EpochMs | null
  blocking: boolean
}

export interface OrchRunDetail {
  run: OrchRun
  tasks: OrchTask[]
  dispatches: OrchDispatch[]
  messages: OrchMessage[]
  gates: OrchGate[]
}

export interface OrchTaskDetail {
  task: OrchTask
  spec: string
  result: string | null
  dispatches: OrchDispatch[]
  messages: OrchMessage[]
  gates: OrchGate[]
}

export interface OrchestrationSummary {
  available: boolean
  schemaVersion: number | null
  testedSchemaVersion: number
  /** Human sentences naming features disabled by missing columns/tables. */
  degraded: string[]
  runs: OrchRun[]
}

/* ─────────────────────────── Attention & stats ───────────────────────── */

export type AttentionKind = 'permission' | 'question' | 'error' | 'stalled' | 'gate' | 'failed-task'
export type Severity = 'high' | 'medium' | 'low'

export interface AttentionItem {
  /** Stable while the condition persists (e.g. `permission:${sessionId}`). */
  id: string
  kind: AttentionKind
  severity: Severity
  sessionId: string | null
  runId: string | null
  taskId: string | null
  title: string
  detail: string | null
  since: EpochMs
  source: string
}

export interface ToolStat {
  name: string
  category: ToolCategory
  mcpServer: string | null
  calls: number
  errors: number
}

export interface FleetStats {
  windowMs: number
  computedAt: EpochMs
  sessions: {
    total: number
    roots: number
    live: number
    working: number
    blocked: number
    waiting: number
    error: number
  }
  activity: {
    toolCalls: number
    toolErrors: number
    mcpCalls: number
    thinking: number
    fileChanges: number
    filesTouched: number
    subagents: number
  }
  tokens: TokenUsage
  cost: number
  byHarness: Array<{ harness: Harness; sessions: number; live: number; cost: number }>
  byModel: Array<{ model: string; sessions: number; cost: number; tokens: number }>
  byAgent: Array<{ agent: string; sessions: number; cost: number }>
  topTools: ToolStat[]
  mcpServers: Array<{ server: string; calls: number; errors: number; tools: number }>
  /** 60 one-minute buckets ending at computedAt, oldest first. */
  histogram: Array<{
    t: EpochMs
    thinking: number
    tools: number
    mcp: number
    edits: number
    errors: number
  }>
}

/* ─────────────────────────── Meta & sources ──────────────────────────── */

export type SourceId = 'opencode' | 'copilot' | 'orca-cli' | 'orca-hooks' | 'orca-orchestration'
export type SourceStatus = 'starting' | 'ok' | 'degraded' | 'missing' | 'error' | 'disabled'

export interface SourceHealth {
  id: SourceId
  label: string
  status: SourceStatus
  path: string | null
  version: string | null
  detail: string | null
  lastReadAt: EpochMs | null
  lastChangeAt: EpochMs | null
}

export interface ServerMeta {
  app: 'orca-command-center'
  version: string
  /** Random per server process; a change tells the client to resync. */
  bootId: string
  startedAt: EpochMs
  now: EpochMs
  host: string
  port: number
  readOnly: true
  windowMs: number
  sources: SourceHealth[]
  orca: OrcaStatus
}

/* ─────────────────────────── Bootstrap & stream ──────────────────────── */

export interface BootstrapPayload {
  meta: ServerMeta
  /** Hub sequence at snapshot time. Subscribe with GET /api/stream?since=<seq>. */
  seq: number
  sessions: SessionSummary[]
  orca: OrcaSnapshot
  attention: AttentionItem[]
  /** Most recent ≤ LIMITS.bootstrapActivity events (excluding kind 'step'), oldest → newest. */
  activity: ActivityEvent[]
  orchestration: OrchestrationSummary
  stats: FleetStats
}

/**
 * Server-Sent Events on GET /api/stream. Framing: default `message` events only (no `event:`
 * line); `id:` = seq; `data:` = JSON of one StreamEvent. A `: ping` comment is sent every 15 s.
 * Upserts are coalesced by the server (≤ 4 frames/s per client).
 */
export type StreamEvent =
  | { type: 'hello'; seq: number; bootId: string; meta: ServerMeta }
  | { type: 'resync'; seq: number; reason: string }
  | { type: 'activity'; seq: number; events: ActivityEvent[] }
  | { type: 'sessions'; seq: number; sessions: SessionSummary[]; removed: string[] }
  | { type: 'orca'; seq: number; orca: Partial<OrcaSnapshot> }
  | { type: 'attention'; seq: number; items: AttentionItem[] }
  | { type: 'orchestration'; seq: number; summary: OrchestrationSummary; changedRunIds: string[] }
  | { type: 'stats'; seq: number; stats: FleetStats }
  | { type: 'meta'; seq: number; meta: ServerMeta }

export type StreamEventType = StreamEvent['type']

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * What the store publishes: a StreamEvent before the hub assigns its sequence number.
 * `hello` and `resync` are generated by the hub itself and are never published.
 */
export type StreamPayload = DistributiveOmit<
  Exclude<StreamEvent, { type: 'hello' } | { type: 'resync' }>,
  'seq'
>

/* ───────────────────────────────── REST ──────────────────────────────── */

export interface ApiError {
  error: string
  code: 'bad_request' | 'not_found' | 'unavailable' | 'internal'
}

/**
 * Response type for each route. Query parameters are documented in Plan.md §10.2.
 * `:id` segments are URI-encoded ids.
 */
export interface ApiResponses {
  'GET /api/meta': ServerMeta
  'GET /api/bootstrap': BootstrapPayload
  'GET /api/sessions': { sessions: SessionSummary[] }
  'GET /api/sessions/:id': SessionDetail
  'GET /api/sessions/:id/tree': SessionTree
  'GET /api/sessions/:id/transcript': TranscriptPage
  'GET /api/activity': ActivityPage
  'GET /api/parts/:id': PartDetail
  'GET /api/file-changes': { changes: FileChange[] }
  'GET /api/file-changes/:id/diff': FileDiff
  'GET /api/artifacts': { artifacts: Artifact[] }
  'GET /api/attention': { items: AttentionItem[] }
  'GET /api/stats': FleetStats
  'GET /api/orca': OrcaSnapshot
  'GET /api/orchestration': OrchestrationSummary
  'GET /api/orchestration/runs/:id': OrchRunDetail
  'GET /api/orchestration/tasks/:id': OrchTaskDetail
}

export type ApiRoute = keyof ApiResponses
