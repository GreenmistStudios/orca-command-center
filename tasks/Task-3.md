# Task-3 — OpenCode harness adapter

**Wave:** B (parallel with 2, 4, 5, 6, 7) · **Size:** XL · **Depends on:** Task-1

## Goal

Implement `HarnessSource` for OpenCode: read `opencode.db` (≈4 GB, WAL, written by many live
OpenCode processes) strictly read-only, turn sessions/messages/parts/events into contract types
(sessions, activity events, transcripts, file changes, diffs, todos), and stream changes
incrementally by tailing the `event` table. This adapter is the primary source of "what the
agents are doing": thinking, tool calls, MCP calls, edits, subagent spawns, tokens and cost.

## Read first

- `docs/data-sources.md` §0 (safety — mandatory), §1 (OpenCode — normative), §6 (join model)
- `Plan.md` §9.1 (how the store uses `transcriptState`), §11 (budgets), §12 (testing)
- `src/server/types.ts` (`HarnessSource`, `HarnessSession`, `HarnessUpdate`, `SourceDeps`)
- `src/shared/contract.ts` (`ActivityEvent`, `ToolCallInfo`, `TranscriptPage`, `FileChange`,
  `FileDiff`, `PartDetail`, `SessionCounters`, `ToolStat`, `LIMITS`)
- `src/server/lib/{sqlite,redact,text,time,tool-classify}.ts` (Task-1)

## Ownership

`src/server/sources/opencode/**` (+ co-located tests) and `test/fixtures/opencode.ts`.

## Public API

```ts
// src/server/sources/opencode/index.ts
export function createOpenCodeSource(deps: SourceDeps): HarnessSource   // id 'opencode', harness 'opencode'
```

Suggested internal modules (adjust freely): `db.ts` (prepared queries), `normalize.ts`
(part/message → ActivityEvent / ToolCallInfo / FileChange), `sessions.ts` (session rows → 
`HarnessSession`, root/spawn/derived fields), `tail.ts` (event tail + coalescing), `transcript.ts`,
`diff.ts`, `counters.ts`.

## Requirements

### A. Lifecycle & health

- `start()`: if `config.opencodeDb` is null → health `disabled`/`missing` (with detail) and
  return. Otherwise open with `openReadOnly(path, { deniedTables: OPENCODE_DENIED_TABLES })`.
  Introspect `tables()`/`columns()`; `session` or `part` missing → health `error`. `event`
  missing → fallback polling mode (data-sources §1.4) with health `degraded` ("no event log;
  polling sessions").
- Seed: cursor = `max(rowid)` from `event`; load window sessions (`now − config.windowMs`) and
  their ancestors; compute derived fields; populate caches.
- Poll every `config.pollMs` with an unref'd timer: `dataVersion()` unchanged → return
  immediately (no other SQL). Changed → tail (§C). Never overlap ticks. Errors are caught,
  logged once per distinct message, reflected in health (`error` after 3 consecutive failures,
  back to `ok` on success).
- `health()`: `{ id:'opencode', label:'OpenCode', status, path, version: 'event-log' | 'polling', detail: '<n> sessions in window · cursor <rowid>', lastReadAt, lastChangeAt }`.
- `stop()`: clear timer, close DB.

### B. Sessions → `HarnessSession`

- Columns from data-sources §1.1. `model` column is JSON text `{"id","providerID","variant"}` →
  `ModelRef{ providerId, modelId }` (fallback: latest assistant message `modelID/providerID`).
  `tokens_*`/`cost` → `TokenUsage`/`cost`. `agent` column → `agent`.
- `title`: strip a trailing ` (@<agent> subagent)` suffix for display but keep `agent`.
- Root resolution via `parent_id` (cache; the session table is small — scanning it is fine).
- `spawn` for children: the parent's `task` tool part whose `state.metadata.sessionId` equals the
  child id → `SpawnInfo{ parentSessionId, activityId: 'opencode:'+partId, callId, description:
  input.description, subagentType: input.subagent_type, status: state.status }`. Find it by
  querying the parent's parts (`part WHERE session_id = ?`) and caching `childId → spawn`;
  update on tail events for task parts.
- Derived fields (`lastActivityAt`, `transcriptState`, `current`, `lastPrompt`, `lastMessage`)
  per data-sources §1.6, computed at seed from the 3 latest messages + 40 latest parts, then
  maintained incrementally from tail events. `processAlive: null` (OpenCode has no lock file;
  Orca hooks provide liveness). `facts`: `[{label:'Version', value: session.version}]`, plus
  `summary_files/additions/deletions` when non-null (`'Files changed'`, `'+/−'`).
- `listSessions(sinceMs)`: `time_updated >= sinceMs` plus ancestors of those (so trees are
  complete), newest first, cap 2000.
- `getSession(id)` works for any id (outside the window too). `getChildren(id)` via
  `session_parent_idx`.

### C. Event tail (incremental) — data-sources §1.4

- Read `rowid > cursor ORDER BY rowid LIMIT 2000` in a loop (≤ 10 batches per tick).
- Parse `data` JSON safely (skip + count malformed rows). Coalesce per batch by part id /
  message id / session id, keeping the last.
- `message.updated.1` → update a **message cache** (`id → { role, sessionId, agent, model,
  time, tokens, cost, finish, error }`, LRU 5000). Parts need their message role: on a cache
  miss, `SELECT id, session_id, data FROM message WHERE id = ?` (PK).
- `message.part.updated.1` → normalize the part (§D) → ActivityEvent; update the session's
  derived fields; task parts update spawn info; todowrite parts (completed) → also emit
  `{type:'todos', sessionId, todos}` via `getTodos`.
- `session.created.1`/`session.updated.1` → re-read that session row (PK) and emit it.
- Emit per tick, in this order: `sessions` (all touched sessions, re-derived), `activity`
  (coalesced events, sorted by ts), `todos`. Unknown event types are ignored (counted in health detail).
- If `max(rowid)` < cursor → emit `{type:'reset', reason:'event log rewound'}` and re-seed.

### D. Normalization (part → ActivityEvent) — data-sources §1.3

- `id = 'opencode:' + part.id`, `rev` = event `data.time` or `part.time_updated`, `ts` =
  `state.time.start` / `time.start` / `part.time_created`, `endTs` = `state.time.end` /
  `time.end` / null, `sessionId`, `rootId`, `messageId`, `source` = `'opencode.event'` or
  `'opencode.part'`, `detailRef = part.id` for tool/reasoning/text/patch parts.
- Use `createToolClassifier({ knownServers: config.mcpServers })` — call `observe(name)` for
  every tool name seen (seed by `SELECT DISTINCT json_extract(data,'$.tool')` limited to the
  window sessions' parts, via `part_session_idx`).
- Kinds: per the table in data-sources §1.3 (`text`→prompt/text by role; `reasoning`→thinking;
  `tool`→ by category: `task`→subagent, `todowrite`→todo, edit/write/patch tools →file-change,
  MCP →mcp, else tool; `step-finish`→step; `patch`→file-change; `file`→prompt (attachment);
  unknown types → text with muted title).
- `title` (≤ `LIMITS.titleChars`): tool → `"<displayName> · <input preview>"` where the input
  preview is: bash → `command`; read/edit/write → relative-ish path (strip the session
  directory prefix); grep/glob → `pattern`; webfetch → `url`; task → `"<subagent_type> ·
  <description>"`; skill → `name`; question → first question text; MCP → `compactJson(input)`.
  thinking → `"Thinking"`; text → first line; step → `"Step · <reason> · <tokens>"`; patch →
  `"Snapshot · N files changed"`.
- `summary` (≤ `LIMITS.summaryChars`, redacted, ANSI-stripped): reasoning text; assistant/user
  text; tool output (completed) or `metadata.output` (running); **omit for `read` tool outputs**
  (file contents) and for `file` parts.
- `tool`: `ToolCallInfo` with redacted `input` preview (≤ 400), `output` preview (≤ 800),
  `error` (≤ 400), `durationMs`, `truncated`.
- `files`: edit/write/read → `[input.filePath]`; patch part → `files`; apply_patch → parsed from
  patch text headers.
- `childSessionId` for task parts from `state.metadata.sessionId`.
- `usage` for step-finish: tokens + cost.
- `links`: `extractLinks` over the FULL text/output (≤ 5).
- Never emit `data:` URLs; drop reasoning `metadata` signatures.

### E. Queries for the store (all synchronous)

- `getCounters(id)`: one aggregation query (data-sources §1.5) → `SessionCounters` (`messages`
  via `SELECT count(*) FROM message WHERE session_id = ?`; `subagents` = children count;
  `filesTouched` = distinct file paths from edit/write/patch parts — compute with a second
  bounded query over that session's file-change parts only).
- `getToolStats(sessionIds)`: aggregate tool name × status per session (indexed), merge,
  classify → `ToolStat[]` sorted by calls desc.
- `getTodos(id)`: `todo WHERE session_id = ? ORDER BY position`.
- `getTranscript(id, { before, limit })`: page messages newest-first by `(time_created, id)`
  keyset (`before` = `"<time_created>:<id>"`), then fetch their parts by `message_id`
  (`part_message_id_id_idx`), normalize, and return messages oldest → newest. Synthetic/ignored
  text parts are included but marked in `title` (`"(synthetic) …"`).
- `getActivity(sessionIds, { kinds, before, sinceMs, limit })`: per session `part WHERE
  session_id = ?` (optionally `AND time_created < ?` from the cursor), normalize, merge across
  sessions by `ts`, filter kinds, page with cursor `"<ts>:<partId>"`; ≤ `LIMITS.activityPageMax`.
- `recentActivity({ sinceMs, limit })`: from the last 3000 `event` rows (`ORDER BY rowid DESC
  LIMIT 3000`), coalesced, normalized, `ts >= sinceMs`, excluding `step`, oldest → newest.
- `getPart(id)`: `part WHERE id = ?` → `PartDetail` (redactValue on input/metadata; output
  ≤ `LIMITS.partDetailBytes`; text for reasoning/text parts; `truncated` flag).
- `getDiff(activityId)`: edit → `metadata.diff` (unified); write → `input.content` as
  `new-file`; apply_patch → patch text as `patch-text`; patch part → `format:'none'` with note
  "Snapshot <hash> — diff not recorded in the transcript". Redact, cap at `LIMITS.diffBytes`.
- `getFileChanges(sessionIds, sinceMs)`: file-change parts → `FileChange[]`; additions/
  deletions counted from unified diffs (lines starting `+`/`-` excluding headers) or the new
  content line count; kind per data-sources §1.3; `workspaceRoot` = session directory,
  `relPath` relative to it when inside. Patch-part files already covered by an edit/write of
  the same file in the same message are skipped.

### F. Fixture — `test/fixtures/opencode.ts`

`createOpenCodeFixture(dir): { path, db (writable, test-only), addSession(...), addMessage(...), addPart(...), appendEvent(...), close() }`
creating the real DDL for `session`, `message`, `part`, `event`, `event_sequence`, `todo`,
`project` (copy the CREATE TABLE/INDEX statements from data-sources/this repo's research — same
columns and indexes as production) **plus** the denied tables `account`, `control_account`,
`credential`, `permission` filled with obviously fake secrets (`ghp_FAKEFAKE…`) so tests can
prove they are never read. Provide `seedRealisticFleet(fixture, now)` that creates:
- a root `build` session (Opus) in `/repo/app` with: user prompt, reasoning, bash (completed),
  bash (running, with `metadata.output`), read, edit (with unified diff), write (new `Plan.md`),
  an MCP call `atlassian_jira_get_issue` (completed) and `bitrise_get_build_log` (error), a
  `task` part spawning a child, `todowrite`, `step-finish` parts, a `patch` part, a `file` part
  with a `data:image/png;base64,…` URL, and text containing a GitHub PR URL;
- two `sonnet-coder`/`explore` child sessions (one completed, one in progress) with their own
  parts;
- a second root session with an unfinished assistant message and a pending `question` tool;
- matching `event` rows (`message.part.updated.1` with multiple coalescable updates for one
  streaming text part, `message.updated.1`, `session.updated.1`, `session.created.1`).

### G. Tests (co-located, using the fixture — never mock `node:sqlite`)

- Normalization table tests for every part type/tool category, redaction of a token inside a
  bash command, `data:` URL removal, read-output omission, MCP classification.
- Tail: append events after start → one tick emits coalesced activity (one event per part), the
  touched session with updated `current`/`transcriptState`, todos after a todowrite; unchanged
  `data_version` → zero queries (wrap `db.all/get` with a counter); rewound cursor → `reset`.
- Spawn linkage and root resolution; children; `listSessions` includes ancestors.
- Transcript paging (two pages, correct order, cursor); activity paging; file changes (kinds,
  +/- counts, dedupe vs patch parts); diffs (unified/new-file/none); part detail redaction.
- **Denied tables:** run the whole seed + tail + every query, then assert (by wrapping the
  underlying `DatabaseSync.prepare`) that no SQL ever mentioned a denied table and the fake
  secrets never appear in any emitted update or query result (JSON.stringify search).
- **Query plans:** for every query touching `part`, `message`, `event`, assert `explain()`
  contains `SEARCH` for that table (no full `SCAN part/message/event`).
- Missing DB → health `missing`, no throw; missing `event` table → polling mode works.

### H. Performance check against the real DB (manual, read-only)

Write a tiny script under `src/server/sources/opencode/bench.ts` (not a test) that opens the real
DB (`~/.local/share/opencode/opencode.db`) through the adapter, runs `start()`, prints seed time,
number of window sessions, the time for one idle tick and for `getCounters` on the largest
window session, then `stop()`. Run it with `npx tsx src/server/sources/opencode/bench.ts` and
include the numbers in your report. Budgets: seed ≤ 800 ms, idle tick ≤ 1 ms, counters ≤ 50 ms.
(Read-only: it is safe to run while OpenCode is running.)

## Acceptance

All tests green (`npx vitest run src/server/sources/opencode`), typecheck clean for owned files,
bench numbers within budget (or explained), no denied-table access, no secrets emitted.

## Report

Summary, files, tests run + results, bench output, deviations (e.g. part types or fields that
differed from the plan), follow-ups.
