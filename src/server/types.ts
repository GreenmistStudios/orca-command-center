/**
 * Orca Command Center — server-internal contract.
 *
 * Interfaces that let independently-built server modules plug together:
 *   sources (harness adapters, Orca sources) ──updates──▶ store ──publish──▶ hub ──SSE──▶ client
 *                                            ◀─queries── store ◀──reads── http routes
 *
 * Authored by the product plan (Plan.md §8). Implementation tasks MUST NOT rename or remove
 * members. Additive optional members are allowed with a note in the task report.
 */

import type {
  ActivityEvent,
  ActivityKind,
  ActivityPage,
  ActivityStatus,
  AgentState,
  Artifact,
  BootstrapPayload,
  CurrentActivity,
  EpochMs,
  FileChange,
  FileDiff,
  FleetStats,
  Harness,
  HookEntry,
  ModelRef,
  OrcaSnapshot,
  OrcaStatus,
  OrchestrationSummary,
  OrchMessage,
  OrchRunDetail,
  OrchTaskDetail,
  PartDetail,
  ServerMeta,
  SessionCounters,
  SessionDetail,
  SessionSummary,
  SessionTree,
  SourceHealth,
  SourceId,
  SpawnInfo,
  StreamPayload,
  TerminalInfo,
  TodoItem,
  TokenUsage,
  ToolStat,
  TranscriptPage,
  AttentionItem,
  WorktreeInfo,
} from '../shared/contract.js'

/* ─────────────────────────────── Runtime ─────────────────────────────── */

export interface Config {
  host: string
  port: number
  /** Open a browser on start (suppressed when not a TTY / over SSH / CI). */
  open: boolean
  verbose: boolean
  /** Dev mode: no static serving (Vite serves the client), relaxed Host check for the Vite proxy. */
  dev: boolean
  /** Sessions updated within this window are listed in the fleet (default 24 h). */
  windowMs: number
  /** Change-detection poll for SQLite sources (default 750 ms). */
  pollMs: number
  /** Orca CLI poll (default 5000 ms). */
  orcaPollMs: number
  /** Orca userData dir (contains orchestration.db, agent-hooks/). null = not found. */
  orcaDir: string | null
  orchestrationDb: string | null
  hooksFile: string | null
  /** Absolute path to opencode.db. null = not found / disabled. */
  opencodeDb: string | null
  /** ~/.copilot (contains session-state/). null = not found / disabled. */
  copilotDir: string | null
  /** Resolved `orca` executable, or null when the Orca CLI source is disabled. */
  orcaCli: string | null
  /** Extra MCP server name prefixes to recognize (from --mcp-servers). */
  mcpServers: string[]
  /** Activity ring buffer size (default 20 000). */
  ringSize: number
  /** dist/client directory to serve, or null in dev mode. */
  staticDir: string | null
  /** Host header allowlist (DNS-rebinding protection), e.g. ["127.0.0.1:4270", "localhost:4270"]. */
  allowedHosts: string[]
  /** Thresholds for state derivation (Plan.md §9.1). */
  thresholds: {
    /** A session with activity within this window is "live" (default 10 min). */
    liveMs: number
    /** A done/finished session becomes idle after this (default 30 min). */
    idleMs: number
    /** A "working" transcript with no activity for this long becomes unknown + stalled (default 10 min). */
    stalledMs: number
    /** A transcript is "working" only with activity this recent (default 120 s). */
    workingMs: number
  }
}

export interface Logger {
  debug(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
}

/** Injectable clock for tests. */
export type Clock = () => EpochMs

/** Injectable process runner for the Orca CLI (tests pass a fake). */
export type CliRunner = (
  executable: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>

export interface SourceDeps {
  config: Config
  log: Logger
  now: Clock
}

/* ─────────────────────────────── Sources ─────────────────────────────── */

export interface SourceBase {
  readonly id: SourceId
  /** Must not throw for missing/unreadable data — report it through health() instead. */
  start(): Promise<void>
  stop(): Promise<void>
  health(): SourceHealth
}

export type Unsubscribe = () => void

/* Harness adapters (OpenCode, Copilot CLI, future Claude Code / Codex) ------------------------- */

/** Raw facts about one session as a harness knows them — before Orca joins and state rules. */
export interface HarnessSession {
  id: string
  harness: Harness
  parentId: string | null
  title: string
  agent: string | null
  model: ModelRef | null
  directory: string | null
  createdAt: EpochMs
  updatedAt: EpochMs
  /** Last time any part/event of this session changed. */
  lastActivityAt: EpochMs | null
  archivedAt: EpochMs | null
  tokens: TokenUsage
  cost: number
  /** Present for subagent sessions when the parent's spawning tool call is known. */
  spawn: SpawnInfo | null
  /**
   * State as the transcript alone suggests it (no Orca, no thresholds applied):
   * working = an assistant turn is in progress; waiting = a question tool is pending;
   * error = the last turn errored; done = last turn completed; unknown = cannot tell.
   */
  transcriptState: Extract<AgentState, 'working' | 'waiting' | 'error' | 'done' | 'unknown'>
  current: CurrentActivity | null
  lastPrompt: string | null
  lastMessage: string | null
  /** True when the harness itself proves the process is alive (e.g. Copilot inuse.<pid>.lock). */
  processAlive: boolean | null
  facts: Array<{ label: string; value: string }>
}

export type HarnessUpdate =
  | { type: 'sessions'; sessions: HarnessSession[] }
  | { type: 'activity'; events: ActivityEvent[] }
  | { type: 'todos'; sessionId: string; todos: TodoItem[] }
  /** The incremental cursor was lost (e.g. log truncated). The store should reload from queries. */
  | { type: 'reset'; reason: string }

export interface ActivityQueryOptions {
  kinds?: ActivityKind[]
  /** Opaque cursor from a previous ActivityPage.before. */
  before?: string
  sinceMs?: EpochMs
  limit: number
}

export interface HarnessSource extends SourceBase {
  readonly harness: Harness
  subscribe(listener: (update: HarnessUpdate) => void): Unsubscribe

  /** Sessions with updatedAt >= sinceMs (roots and children). */
  listSessions(sinceMs: EpochMs): HarnessSession[]
  getSession(id: string): HarnessSession | null
  /** Direct children of a session regardless of age. */
  getChildren(id: string): HarnessSession[]
  getCounters(id: string): SessionCounters
  getToolStats(sessionIds: string[]): ToolStat[]
  getTodos(id: string): TodoItem[]
  getTranscript(id: string, options: { before?: string; limit: number }): TranscriptPage
  /** Activity for the given sessions, newest page first by `before`, events ordered oldest→newest. */
  getActivity(sessionIds: string[], options: ActivityQueryOptions): ActivityPage
  /** Fleet-wide recent activity used to seed the ring buffer at boot (oldest→newest). */
  recentActivity(options: { sinceMs: EpochMs; limit: number }): ActivityEvent[]
  getPart(id: string): PartDetail | null
  getDiff(activityId: string): FileDiff | null
  getFileChanges(sessionIds: string[], sinceMs?: EpochMs): FileChange[]
}

/* Orca sources ------------------------------------------------------------------------------- */

export type OrcaCliUpdate =
  | { type: 'status'; status: OrcaStatus }
  | { type: 'fleet'; worktrees: WorktreeInfo[]; terminals: TerminalInfo[] }

/** Polls the read-only commands `orca status`, `orca worktree ps`, `orca terminal list`. */
export interface OrcaCliSource extends SourceBase {
  subscribe(listener: (update: OrcaCliUpdate) => void): Unsubscribe
  status(): OrcaStatus
  worktrees(): WorktreeInfo[]
  terminals(): TerminalInfo[]
}

export interface OrcaHooksUpdate {
  type: 'hooks'
  entries: HookEntry[]
  /** Transitions observed since the previous read, as 'state' / 'permission' activity events. */
  transitions: ActivityEvent[]
}

/** Watches agent-hooks/last-status.json. */
export interface OrcaHooksSource extends SourceBase {
  subscribe(listener: (update: OrcaHooksUpdate) => void): Unsubscribe
  entries(): HookEntry[]
}

export interface OrchestrationUpdate {
  type: 'orchestration'
  summary: OrchestrationSummary
  changedRunIds: string[]
  /** Messages first seen in this read (for the activity stream), oldest → newest. */
  newMessages: OrchMessage[]
}

/** Reads orchestration.db (schema-adaptive, read-only). */
export interface OrchestrationSource extends SourceBase {
  subscribe(listener: (update: OrchestrationUpdate) => void): Unsubscribe
  summary(): OrchestrationSummary
  getRun(id: string): OrchRunDetail | null
  getTask(id: string): OrchTaskDetail | null
}

/* ─────────────────────────────── Store ───────────────────────────────── */

export interface SessionQuery {
  windowMs?: number
  harness?: Harness
  state?: AgentState
  liveOnly?: boolean
  /** Case-insensitive match on title, agent, directory, workspace name. */
  q?: string
  limit?: number
}

export interface ActivityQuery {
  sessionId?: string
  /** All sessions in the tree rooted here. */
  rootId?: string
  kinds?: ActivityKind[]
  before?: string
  sinceMs?: EpochMs
  limit: number
}

/** Everything the HTTP routes need. Synchronous: node:sqlite is synchronous. */
export interface StoreReader {
  meta(): ServerMeta
  bootstrap(): BootstrapPayload
  listSessions(query: SessionQuery): SessionSummary[]
  sessionDetail(id: string): SessionDetail | null
  sessionTree(id: string): SessionTree | null
  transcript(id: string, options: { before?: string; limit: number }): TranscriptPage | null
  activity(query: ActivityQuery): ActivityPage
  part(id: string): PartDetail | null
  fileChanges(query: { rootId?: string; sessionId?: string; windowMs?: number }): FileChange[]
  fileDiff(id: string): FileDiff | null
  artifacts(query: { rootId?: string; windowMs?: number }): Artifact[]
  attention(): AttentionItem[]
  stats(windowMs?: number): FleetStats
  orca(): OrcaSnapshot
  orchestration(): OrchestrationSummary
  orchestrationRun(id: string): OrchRunDetail | null
  orchestrationTask(id: string): OrchTaskDetail | null
}

export interface Store extends StoreReader {
  start(): Promise<void>
  stop(): Promise<void>
}

/** Signature of src/server/store/index.ts → createStore (stub in Task-1, real in Task-8). */
export type CreateStore = (deps: SourceDeps & { hub: HubPublisher; version: string }) => Store

/* ──────────────────────────────── Hub ────────────────────────────────── */

/**
 * The SSE fan-out. The store publishes payloads; the hub assigns `seq`, coalesces upserts within
 * a flush window (activity by id keeping the highest rev, sessions by id, orca shallow-merged,
 * attention/stats/orchestration/meta last-wins), keeps a replay ring, and writes frames.
 */
export interface HubPublisher {
  publish(payload: StreamPayload): void
  /** Current sequence number (the last assigned seq). */
  readonly seq: number
  readonly bootId: string
}

/** Narrow helper used by sources that need to report their status changes to the store. */
export type HealthListener = (health: SourceHealth) => void

/** Status helper types reused by derivation code. */
export type ActivityStatusOrNull = ActivityStatus | null
