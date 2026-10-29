# Data sources — Orca Command Center

Everything the command center shows comes from read-only sources on this machine: five agent
harnesses (OpenCode, Copilot CLI, Claude Code, Codex, Cursor) and three Orca sources (hooks, CLI,
orchestration DB). This document is the data contract for the source adapters and the store.
Shapes below were verified against live data on 2026-10-26 (Orca 1.4.241, orchestration schema
v43, OpenCode DB with the `event` table, Copilot CLI session-state).

---

## 0. Safety rules (non-negotiable)

1. **Read-only, always.** SQLite connections open with `new DatabaseSync(path, { readOnly: true })`
   plus `PRAGMA busy_timeout = 3000`. Never `immutable=1`. Never write, never `VACUUM`, never
   `PRAGMA wal_checkpoint`. Files are only read. The Orca CLI is only invoked with the allowlisted
   read-only commands `status`, `worktree ps`, `terminal list` (each with `--json`).
2. **Never touch secrets.** The SQLite helper (`src/server/lib/sqlite.ts`) rejects any SQL that
   mentions a denied table. Denied in `opencode.db`: `account`, `account_state`,
   `control_account`, `credential`, `permission`. Never open or read: `~/.local/share/opencode/auth.json`,
   `mcp-auth.json`, `<orca>/agent-hooks/endpoint.env`, `<orca>/daemon/*.token`,
   `<orca>/orca-runtime.json`, `<orca>/orca-e2ee-keypair.json`, `<orca>/agent-session-authority.key`,
   `Cookies`, `~/.copilot/config.json`, `~/.claude/.credentials.json`, `~/.claude.json`,
   `~/.codex/auth.json`, `~/.cursor/mcp.json`, Cursor `chats/*/*/store.db` and `state.vscdb`, any
   `*.key` / `*.token` / `*auth*.json`. The JSONL harnesses read only `projects/`, `sessions/`,
   `session_index.jsonl` and `chats/*/*/meta.json`.
3. **Short read transactions.** Never hold a statement or transaction open between polls (a
   long-lived reader blocks WAL checkpoints and makes the writer's WAL grow). Use
   `stmt.all()` / `stmt.get()` and let them complete.
4. **Index-only access to big tables.** `opencode.db` is ~4 GB. Never scan `part`, `message` or
   `event` without an indexed predicate (`rowid >`, `session_id =`, `id =`, `message_id =`) or a
   `rowid DESC LIMIT n` window. Every such query in the code must have a test asserting its
   `EXPLAIN QUERY PLAN` uses `SEARCH` (not `SCAN`) on the big table.
5. **Redact before serving.** All transcript-derived strings pass through `redactText()` (token
   patterns and embedded `data:` URLs) and `stripAnsi()`; structured values pass through
   `redactValue()` (secret-named keys, `data:` URL strings). `data:` URLs are replaced with
   `"[data-url omitted]"`. Reasoning `metadata.*.signature` fields are dropped.

---

## 1. OpenCode — `opencode.db` (primary harness)

**Location:** `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db` (override `--opencode-db`).
WAL mode; many concurrent OpenCode processes write to it.

### 1.1 Allowed tables and columns

| Table | Columns used | Indexes |
|---|---|---|
| `session` | id, project_id, parent_id, slug, directory, title, version, summary_additions, summary_deletions, summary_files, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, agent, model (JSON text `{"id","providerID","variant"}`), time_created, time_updated, time_compacting, time_archived | pk, `session_parent_idx(parent_id)` (table is small: ~700 rows → scans OK) |
| `message` | id, session_id, time_created, time_updated, data (JSON) | pk, `message_session_time_created_id_idx(session_id,time_created,id)` |
| `part` | id, message_id, session_id, time_created, time_updated, data (JSON) | pk, `part_session_idx(session_id)`, `part_message_id_id_idx(message_id,id)` |
| `event` | rowid, id, aggregate_id (= session id), seq, type, data (JSON) | rowid, `event_aggregate_seq_idx` |
| `todo` | session_id, content, status, priority, position, time_created, time_updated | `todo_session_idx` |
| `project` | id, worktree, name (optional, for workspace names) | pk |

Introspect columns with `PRAGMA table_info(<table>)` at start; missing optional columns degrade
features (reported in SourceHealth.detail), missing `session`/`part` = source `error`.

### 1.2 `message.data`

```json
// user
{"role":"user","time":{"created":1793010155035},"agent":"prr-validator",
 "model":{"providerID":"github-copilot","modelID":"claude-opus-5.5"},"summary":{"diffs":[]}}
// assistant
{"role":"assistant","parentID":"msg_…","mode":"prr-validator","agent":"prr-validator",
 "path":{"cwd":"/Users/…/acme-android","root":"/Users/…/acme-android"},
 "cost":0.221106,"tokens":{"total":43790,"input":4,"output":144,"reasoning":0,"cache":{"write":43642,"read":0}},
 "modelID":"claude-opus-5.5","providerID":"github-copilot","time":{"created":1793010155054,"completed?":…},
 "finish":"tool-calls","error?":{"name":"…","data":{"message":"…"}}}
```

An assistant message **without** `time.completed` is an in-progress turn.

### 1.3 `part.data` by `type`

| type | Shape (verified) | Normalized ActivityEvent |
|---|---|---|
| `text` | `{type, text, synthetic?, ignored?, time?{start,end}}` | role user → kind `prompt`; role assistant → `text`. Skip `synthetic`/`ignored` parts in the stream (keep in transcript, muted). |
| `reasoning` | `{type, text, time{start,end}, metadata{anthropic{signature}}}` | kind `thinking`; title "Thinking"; summary = text; endTs = time.end; drop metadata. |
| `tool` | `{type, callID, tool, state{status: pending\|running\|completed\|error, input, output?, error?, title?, metadata?, time{start,end?}}, metadata?}` | kind by category (below); status = state.status; title `"<displayName> · <inputPreview>"`. |
| `step-start` | `{type, snapshot}` | not emitted (used for step grouping only) |
| `step-finish` | `{type, reason, tokens{total,input,output,reasoning,cache{read,write}}, cost}` | kind `step` with usage. |
| `patch` | `{type, hash, files: [absolute paths]}` | kind `file-change`, title "Snapshot · N files changed", files = files. |
| `file` | `{type, mime, filename, url (often a base64 data URL!), source{…}}` | kind `prompt` attachment chip in transcript only; NEVER send `url` if it starts with `data:`. Image → artifact `image` (filename only). |
| other (`agent`, `subtask`, `compaction`, `retry`, `snapshot`) | pass-through | kind `text` with title = type, muted; unknown types never crash. |

**Tool specifics:**

- `task` (subagent): `state.input = {description, prompt, subagent_type}`;
  `state.metadata = {sessionId (child), parentSessionId, model{modelID,providerID}, truncated}`.
  → kind `subagent`, `childSessionId = metadata.sessionId`, title `"<subagent_type> · <description>"`.
  The child `session.parent_id` = parent session id; child `session.title` looks like
  `"Validate C1 … (@prr-validator subagent)"`, `session.agent` = subagent type.
- `edit`: `state.input = {filePath, oldString, newString}`; `state.metadata = {diff (unified),
  filediff, diagnostics, truncated}` → kind `file-change`, FileChange kind `edit`, diff from
  `metadata.diff`; additions/deletions counted from the diff lines.
- `write`: `state.input = {filePath, content}`; `state.metadata = {filepath, exists, diagnostics}`
  → FileChange kind `create` when `exists === false` else `write`; diff format `new-file` from
  `input.content`.
- `apply_patch` / `patch` tools: `state.input.patchText` (or similar) → diff format `patch-text`;
  files parsed from `*** Update File: <path>` / `*** Add File:` / `*** Delete File:` headers.
- `read`: files = [input.filePath]; output is file content → **summary omitted** in the stream
  (title only); available in detail (redacted).
- `bash`: input.command (+ description); output streams in `state.metadata.output` while running.
- `todowrite`: input.todos → kind `todo`; also emit a `todos` update for the session.
- `question`: running/pending → session transcriptState `waiting`.

**Tool classification (`classifyTool('opencode', name)`):**

| Category | OpenCode built-in names |
|---|---|
| shell | bash |
| read | read, list, ls, lsp_hover, lsp_diagnostics |
| search | grep, glob, codesearch |
| edit | edit, multiedit |
| write | write |
| patch | patch, apply_patch |
| web | webfetch, websearch |
| subagent | task |
| todo | todowrite, todoread |
| question | question |
| skill | skill |

Anything else: **MCP** when `name` matches `^([a-z0-9-]+)_(.+)$` and the prefix is either in the
known-server list (`--mcp-servers`, plus defaults: `atlassian, github, bitrise, figma, playwright,
slack, jira, confluence, linear, sentry, notion, context7, sharepoint, satori, gitlab, datadog,
grafana, chrome-devtools, filesystem, memory, fetch`) or is shared by ≥ 2 distinct tool names seen
by this process — **unless** the prefix is a common verb (`get, set, create, update, list, clear,
delete, add, remove, read, write, search, fetch, run, start, stop, open, close, find, check, make,
send, show, toggle, apply`). Otherwise **plugin** (e.g. `get_goal`, `acme_toggle_builtins`).
`mcpServer` = prefix; `displayName` = remainder.

### 1.4 The `event` table — incremental change feed

`event(rowid, id, aggregate_id, seq, type, data)`; `aggregate_id` = session id; rowid is
monotonic. Verified types: `message.part.updated.1` (≈75% of rows), `message.updated.1`,
`session.updated.1`, `session.created.1`. `data` = `{sessionID, part|info, time}`; e.g.
`message.part.updated.1` → `{sessionID, part: <full part incl. id, messageID, sessionID>, time}`.

Tail algorithm (Task 3):

1. On start: `cursor = SELECT max(rowid) FROM event`.
2. Every `pollMs`: `PRAGMA data_version` — unchanged → do nothing (no other query).
3. Changed → `SELECT rowid, aggregate_id, type, data FROM event WHERE rowid > ? ORDER BY rowid LIMIT 2000`
   (verified: `SEARCH event USING INTEGER PRIMARY KEY (rowid>?)`, 2000 rows ≈ 5 ms). Loop
   until fewer than 2000 rows come back (cap 10 loops per tick).
4. Coalesce by part id / message id / session id, keeping the last; normalize; emit one
   `activity` update (+ `sessions` for touched sessions, + `todos` when a todowrite completes).
5. If `max(rowid)` < cursor (DB replaced/reset) → emit `reset` and re-seed.

Streaming text produces many `message.part.updated` rows for the same part, each with the full
text so far — coalescing is mandatory. `rev` = `data.time` (ms) or the part's time_updated.

If the `event` table is missing (older OpenCode): fallback poll
`SELECT id,… FROM session WHERE time_updated > ?` (small table) then per changed session
`SELECT … FROM part WHERE session_id = ? AND time_updated > ?` (uses `part_session_idx`).

### 1.5 Seeding and per-session queries

- Window sessions: `SELECT … FROM session WHERE time_updated >= ? ORDER BY time_updated DESC LIMIT 1000`
  (+ ancestors via `id IN (…)`, children via `parent_id = ?`).
- Session derived fields (for each window session; ~20 ms worst case):
  - latest message: `SELECT data, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 3`
  - latest parts: `SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created DESC LIMIT 40`
- Counters (≈20 ms for the largest session):
  `SELECT json_extract(data,'$.type') t, json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') st, count(*) n FROM part WHERE session_id = ? GROUP BY 1,2,3`
- Seed recent activity: last 3000 `event` rows (`ORDER BY rowid DESC LIMIT 3000`), coalesced.
- Transcript page: messages by `(session_id, time_created, id)` keyset; parts via
  `part WHERE message_id IN (…) ORDER BY message_id, id`.
- Activity history for sessions: `part WHERE session_id = ?` per session, sort in JS, keyset
  cursor `"<time_created>:<id>"`.

### 1.6 Derivations owned by the OpenCode adapter

- `rootId`: walk `parent_id` (cache; sessions table is small).
- `spawn`: for a child session, find the parent's `task` part whose `state.metadata.sessionId`
  equals the child id (search the parent's recent `task` parts; cache by child id).
- `transcriptState`: running/pending `question` tool → `waiting`; latest assistant message without
  `time.completed` → `working`; latest assistant message with `error` → `error`; latest assistant
  message completed → `done`; otherwise `unknown`.
- `current`: latest `running`/`pending` tool part → `{kind, label: displayName, detail: input
  preview}`; else an unfinished reasoning part → `{kind:'thinking', label:'Thinking'}`; else a
  streaming assistant text part (in-progress message) → `{kind:'text', label:'Writing response'}`.
- `lastPrompt` = latest user text (non-synthetic) ≤ 280 chars; `lastMessage` = latest assistant
  text ≤ 280 chars.

---

## 2. Copilot CLI — `~/.copilot/session-state/<uuid>/`

Per session directory: `events.jsonl` (append-only), `workspace.yaml` (`id, name, cwd,
created_at, updated_at, client_name, summary_count, user_named, fork_count`),
`inuse.<pid>.lock` (present while a process owns the session), plus `checkpoints/`, `files/`,
`research/`, `rewind-file-snapshots/` (not read in v1).

Envelope per line: `{id, parentId, timestamp (ISO), type, data}`. Verified types and data keys:

| type | data keys | Normalized |
|---|---|---|
| `session.start` | sessionId, startTime, selectedModel, copilotVersion, context{cwd}, producer, version | session facts (model, cwd, version) |
| `user.message` | content, transformedContent, messageId, turnId, parentAgentTaskId | kind `prompt` |
| `assistant.turn_start` / `assistant.turn_end` | turnId | transcriptState working / done |
| `assistant.message` | content, reasoningText, reasoningBlocks, toolRequests, model, messageId, turnId | `thinking` (when reasoningText) + `text` (when content) |
| `tool.execution_start` | toolCallId, toolName, arguments, shellToolInfo, model, turnId | tool call `running` |
| `tool.execution_complete` | toolCallId, success, result, toolTelemetry, shellExecution | same id → `completed` / `error` |
| `permission.requested` / `permission.completed` | requestId, permissionRequest, promptRequest / requestId, result, toolCallId | kind `permission`; pending request ⇒ transcriptState `waiting` and attention |
| `session.usage_checkpoint` | totalPremiumRequests, totalNanoAiu | fact "Premium requests" |
| `session.error`, `abort` | message / reason | kind `error` |
| `subagent.*` | — | kind `subagent` (best effort) |
| `hook.start` / `hook.end`, `system.message`, `session.auto_mode_resolved`, `session.warning`, `session.shutdown`, `session.resume` | — | not streamed (shutdown ⇒ done) |

Tool names seen: `bash, read_bash, stop_bash, write_bash` (shell), `view` (read), `rg, glob, grep`
(search), `create` (write → FileChange `create`), `edit, str_replace` (edit), `apply_patch`
(patch), `web_fetch, web_search` (web), `task` (subagent). Unknown names → MCP heuristic as in
§1.3 (Copilot MCP names may use `server-tool` form; treat `-` like `_` for the prefix test).

Tailing: keep `{size, offset}` per `events.jsonl`; on change read appended bytes only; keep a
partial trailing line buffered. Sessions whose `events.jsonl` mtime is older than the window are
not parsed at start (listed lazily on demand). `processAlive` = an `inuse.<pid>.lock` exists and
`process.kill(pid, 0)` succeeds (EPERM counts as alive).

Session id = directory name; title = `workspace.name` || first user message (≤ 80 chars);
agent = `copilot`; directory = `workspace.cwd` || `session.start.context.cwd`; tokens = 0, cost = 0
(facts carry premium requests).

---

## 2a. JSONL harnesses: shared runtime (`src/server/sources/jsonl/`)

Claude Code, Codex and Cursor each log one append-only JSONL file per session. They share one
tailing runtime (`source.ts`) and one normalizing base model (`model.ts`); each adapter only
enumerates its files and parses its own line shapes.

- **Discovery:** directories are listed through an mtime-cached `readdir` (re-listed only when the
  directory changed); files are `stat`ed every tick while in the window, every 5th tick otherwise.
  Files in the window are parsed at start (last 20 MB at most); older ones on demand, with an
  LRU of 50 parsed idle models.
- **Tailing:** `{size, offset}` per file; appended bytes only; a partial trailing line stays
  buffered; a shrunk file is re-read and emits `reset`.
- **Time:** lines without a timestamp are stamped 1 ms apart ending at the file mtime, which keeps
  file order.
- **Ids:** activity ids are `<harness>:<sessionId>:<native>` (session ids never contain `:`).
- **Subagents:** a child session links to the parent's spawning tool call by the id the tool
  reported, else by exact prompt match; `spawn.status` follows the tool (Codex: the child's own state).
- **Normalization:** prompts, assistant text, thinking (readable text only; signatures and
  encrypted reasoning are never read), tool calls with `classifyTool(<harness>, name)`, file
  changes and diffs (`old_string/new_string`, `edits[]`, `content`, patch text, or a result diff),
  todos from todo tools, `question`-category tools running ⇒ transcriptState `waiting`.
- `processAlive` is `null` (no lock files); cost is 0 (not recorded); tokens as each harness reports.

## 2b. Claude Code — `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/`

`projects/<encoded-cwd>/<sessionId>.jsonl`; subagents at
`projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl` (child id
`<sessionId>.agent-<agentId>`). Line envelope: `{type, uuid, parentUuid, sessionId, timestamp, cwd,
version, gitBranch, isSidechain, isMeta?, message, toolUseResult?}`.

| type | Normalized |
|---|---|
| `user`, string content or `text` blocks | kind `prompt` (wrappers stripped: `<system-reminder>`, `<command-name>` → `/name args`; `isMeta` and `<local-command-*>` skipped); turn ⇒ working |
| `user`, `tool_result` blocks | completes the tool call (`is_error` ⇒ error); `toolUseResult.structuredPatch` ⇒ diff + line counts; `toolUseResult.agentId` ⇒ subagent link |
| `user` text `[Request interrupted by user…` | running tools ⇒ error, kind `error` "Interrupted", turn ⇒ done |
| `assistant` (`message.id` groups streamed lines) | `text` / `thinking` (`thinking` text only) / `tool_use` ⇒ tool call; usage counted once per `message.id`; `tool_use` or open tools ⇒ working, else done |
| `assistant` with `isApiErrorMessage` | kind `error`, transcriptState `error` |
| `system` (`level: error`) | kind `error`; `turn_duration` / `stop_hook_summary` ⇒ done |
| `custom-title` > `ai-title` > `summary` | title (else first prompt) |
| `isSidechain: true` in a parent file (older versions) | ignored |

Tools: `Bash, BashOutput, KillShell` (shell), `Read, LS, NotebookRead` (read), `Glob, Grep`
(search), `Edit, MultiEdit, NotebookEdit` (edit), `Write` (write; `toolUseResult.type: create` ⇒
FileChange `create`), `WebFetch, WebSearch` (web), `Task, Agent` (subagent), `TodoWrite` (todo),
`AskUserQuestion, ExitPlanMode` (question ⇒ waiting), `Skill, SlashCommand` (skill),
`mcp__<server>__<tool>` (MCP). Permission prompts are not in the transcript; Orca hooks report them.

## 2c. Codex — `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`

Session id = the uuid in the file name (= `session_meta.id`, = Orca's `providerSession.id`).
Thread names: `<codexHome>/session_index.jsonl` (`{id, thread_name}`). Line envelope:
`{timestamp, type, payload}`.

| type / payload.type | Normalized |
|---|---|
| `session_meta` | cwd, `cli_version`, originator, `model_provider`, `git.branch`; `source: {subagent: {thread_spawn: {parent_thread_id, agent_role, agent_nickname}}}` ⇒ child of `parent_thread_id`; other non-user origins (review, compact, `internal`, `memory_consolidation`, `guardian_review`) ⇒ hidden |
| `turn_context` | cwd, model, effort, approval policy |
| `event_msg` `task_started` / `task_complete` / `turn_aborted` | transcriptState working / done / done (+ kind `error` "Turn aborted") |
| `event_msg` `user_message` | kind `prompt` (response_item user messages are injected context and are skipped) |
| `event_msg` `token_count` | tokens from `info.total_token_usage` (cached ⇒ cacheRead, reasoning split out) |
| `event_msg` `error` | kind `error`, transcriptState `error` |
| `event_msg` `exec_approval_request` / `apply_patch_approval_request` | pending until the call starts ⇒ transcriptState `waiting` |
| `response_item` `message` (assistant) | kind `text` |
| `response_item` `reasoning` | kind `thinking` from `summary` only (`encrypted_content` never read) |
| `response_item` `function_call` / `custom_tool_call` / `local_shell_call` / `web_search_call` | tool call (`arguments` JSON-decoded) |
| `response_item` `function_call_output` / `custom_tool_call_output` | completes the call; non-zero `metadata.exit_code` (or `Exit code: N`) ⇒ error; `spawn_agent` output `agent_id` ⇒ subagent link |

Tools: `shell, shell_command, exec_command, write_stdin, local_shell` (shell), `read_file,
list_dir, view_image` (read), `apply_patch` (patch; files from `*** Update/Add/Delete File:`),
`update_plan` (todo), `web_search` (web), `spawn_agent` (subagent), `request_user_input` (question),
`mcp__<server>__<tool>` or `<server>__<tool>` (MCP).

## 2d. Cursor — `~/.cursor/projects/<slug>/agent-transcripts/`

`agent-transcripts/<chatId>.jsonl` or `agent-transcripts/<chatId>/<chatId>.jsonl`, written by the
Cursor agent (IDE and `cursor-agent` CLI). Optional metadata: `~/.cursor/chats/<hash>/<chatId>/meta.json`
(`title`, `cwd`, `createdAtMs`, model). Only `meta.json` is read under `chats/`; never `store.db`.
Cursor IDE's `state.vscdb` is not read.

Lines: `{role: user|assistant|tool, message: {content: [blocks]}}`, usually without timestamps
(see §2a for time). User text is reduced to the `<user_query>` body. `tool_use` blocks start
calls; `tool_result` blocks (when logged) complete them; a text-only assistant reply settles any
open calls and marks the turn done; a trailing `tool_use` ⇒ working. Directory = `meta.cwd`, else
the slug decoded by probing the filesystem (`Users-me-my-app` → `/Users/me/my-app`).

Tools: `Shell, run_terminal_cmd` (shell), `Read, LS, ReadLints` (read), `Grep, Glob,
SemanticSearch, codebase_search` (search), `StrReplace, Edit, MultiEdit, EditNotebook` (edit),
`Write, Delete` (write; `Delete` ⇒ FileChange `delete`), `ApplyPatch` (patch), `WebSearch,
WebFetch` (web), `Task` (subagent), `TodoWrite` (todo), `AskQuestion` (question), `mcp_<server>_<tool>`
(MCP).

---

## 3. Orca hooks — `<orca>/agent-hooks/last-status.json`

`{version: 2, entries: {[paneKey]: Entry}, authorityCommitments: {…ignore…}}`. One entry per
Orca terminal pane = the **latest** hook observation for that pane (no history — the adapter
derives transitions by diffing successive reads).

```json
{"paneKey":"<tabId>:<leafId>","tabId":"…","worktreeId":"<repoId>::<abs path>",
 "source":"opencode","agentPresence":{"agent":"opencode"},
 "hookEventName":"SessionBusy|SessionIdle|PermissionRequest|AskUserQuestion|MessagePart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|…",
 "providerSession":{"key":"session_id","id":"ses_…"},
 "payload":{"state":"working|blocked|waiting|done","prompt":"…","agentType":"opencode","lastAssistantMessage":"…"},
 "receivedAt":1792668387916,"stateStartedAt":1792668387916, "hostTurn":{…}, "launchTokenHash":"…"}
```

- Never read `endpoint.env` in the same directory. Ignore `launchTokenHash`, `hostTurn`,
  `authorityCommitments`.
- Watch the **directory** with `fs.watch` (the file may be replaced atomically), filter to
  `last-status.json`, debounce 100 ms; also a 2 s `stat` mtime fallback poll.
- Transitions: for each paneKey whose `(hookEventName, payload.state, receivedAt)` changed, emit
  an ActivityEvent: kind `permission` for PermissionRequest, else kind `state`; id
  `orca-hook:<paneKey>:<receivedAt>`; sessionId = providerSession.id; title e.g. "Agent became
  working", "Permission requested", "Asked a question", "Finished turn".
- Orca agent states: `working | blocked | waiting | done` (`AgentStatusState`). `blocked` =
  permission; `waiting` = question/input.

## 4. Orca CLI (read-only commands only)

Executable: `$ORCA_CLI_COMMAND` → `orca` on PATH → `/Applications/Orca.app/Contents/Resources/bin/orca`.
Each call: `--json`, timeout 3000 ms, maxBuffer 16 MB, ~0.16 s. Envelope: `{id, ok, result, error?}`.

- `orca status --json` → `result.app.{running,pid}`, `result.runtime.{state,reachable,appVersion}`.
  (Ignore `capabilities`.)
- `orca worktree ps --json` → `result.worktrees[]`: `worktreeId, repoId, repo, path, branch
  (refs/heads/… → strip), displayName, workspaceStatus, status, isActive, isMainWorktree,
  liveTerminalCount, lastActivityAt, lastOutputAt, linkedIssue, linkedPR, linkedItems, preview,
  agents[], terminalVerdict`.
- `orca terminal list --json` → `result.terminals[]`: `handle (term_…), ptyId, worktreeId,
  worktreePath, branch, tabId, leafId, title, connected, lastOutputAt, preview, agentIdentity`.
  paneKey = `${tabId}:${leafId}`. `preview` may contain anything typed in a terminal → redact,
  strip ANSI, ≤ 300 chars.
- `orca orchestration *` list commands currently answer "Unknown command" (feature-flagged) — do
  **not** depend on them; read `orchestration.db` instead.
- Poll every `orcaPollMs` (5 s) only while the previous poll finished; on failure set health
  `error` with the message and keep the last good snapshot (marked stale).

## 5. Orca orchestration — `<orca>/orchestration.db`

`PRAGMA user_version` = 43 (tested). Read-only, schema-adaptive (introspect columns; a missing
column disables only the feature that needs it, with a sentence in `degraded[]`; only a missing
`tasks` table is fatal for this source). Change detection: `PRAGMA data_version` every 2 s.

| Table | Used columns |
|---|---|
| `runs` | id, objective, coordinator_handle, legacy, created_at, updated_at |
| `tasks` | id, run_id, parent_id, created_by_terminal_handle, task_title, display_name, spec, status (pending/ready/dispatched/completed/failed/blocked), deps (JSON array of task ids), result, created_at, completed_at |
| `dispatch_contexts` | id, run_id, task_id, assignee_handle, status (pending/dispatched/completed/failed/circuit_broken), failure_count, last_failure, termination_reason, depth, dispatched_at, completed_at, last_heartbeat_at, created_at |
| `worker_dispatches` | dispatch_id, state, stage, worktree_id, agent_terminal_handle, last_error |
| `messages` | id, run_id, from_handle, to_handle, subject, body, type, priority, thread_id, payload (JSON; `taskId`), sequence, created_at |
| `decision_gates` | id, run_id, task_id, question, options (JSON), status, resolution, created_at, resolved_at |

Timestamps are SQL `YYYY-MM-DD HH:MM:SS` UTC → append `Z`, parse to ms. Title = `task_title ||
display_name || first line of spec`. Spec preview ≤ 240 chars. Gates: union of `decision_gates`
rows and `messages.type='decision_gate'` (a reply with `thread_id` = gate message id resolves it);
blocking = pending, or unanswered while the task is `blocked`. Heartbeat messages are counted, not
streamed. New non-heartbeat messages → `newMessages` (store turns them into `orchestration`
activity events). The `run_legacy_local` run with zero tasks is hidden.

Current machine state: 2 runs, 3 tasks (all `ready`), 0 dispatches, 0 messages — the
orchestration view must look good nearly empty ("No dependencies in this run — 3 tasks
dispatched independently").

---

## 6. Join model (Task 8)

```text
Orca terminal (handle term_…, tabId, leafId, worktreeId)
   │ paneKey = tabId:leafId
   ▼
Hook entry (paneKey) ── providerSession.id ──▶ Harness session (ses_… / uuid)  ← root sessions
   │ worktreeId                                     │ parent_id / spawn (task tool)
   ▼                                                ▼
Worktree (path, repo, branch, displayName)      Child sessions (subagents), inherit workspace

orchestration.db:
   runs.coordinator_handle ─▶ terminal.handle ─▶ paneKey ─▶ hook ─▶ coordinatorSessionId
   dispatch_contexts.assignee_handle ─▶ terminal ─▶ pane ─▶ hook ─▶ assigneeSessionId
   tasks.created_by_terminal_handle (fallback grouping when runs table absent)
```

- Hook → session matching is exact on `providerSession.id`; never guess by title/time.
- Workspace for sessions without an Orca link: longest worktree `path` that is a prefix of
  `session.directory`; else the directory itself (`key` = normalized path, `name` = basename).
- Children inherit the root's workspace and Orca worktree; only roots get pane/terminal links.
- When several hook entries point at one session, the newest `receivedAt` wins.
