# Task-6 — Copilot CLI harness adapter

**Wave:** B (parallel with 2, 3, 4, 5, 7) · **Size:** L · **Depends on:** Task-1

## Goal

Implement `HarnessSource` for GitHub Copilot CLI sessions stored as append-only JSONL under
`~/.copilot/session-state/<uuid>/events.jsonl`, so the command center shows a second harness
side by side with OpenCode: prompts, thinking, tool calls, permission requests, errors, and live
status — streamed incrementally by tailing files.

## Read first

- `docs/data-sources.md` §0 (safety), §2 (Copilot — normative), §1.3 (tool classification
  rules shared with OpenCode)
- `src/server/types.ts` (`HarnessSource`, `HarnessSession`, `HarnessUpdate`)
- `src/shared/contract.ts` (`ActivityEvent`, `ToolCallInfo`, `TranscriptPage`, `FileChange`,
  `FileDiff`, `PartDetail`, `SessionCounters`, `ToolStat`, `LIMITS`)
- `src/server/lib/{fs-watch,redact,text,time,tool-classify}.ts`

## Ownership

`src/server/sources/copilot/**` (+ co-located tests), `test/fixtures/copilot.ts`.

## Public API

```ts
export function createCopilotSource(deps: SourceDeps): HarnessSource   // id 'copilot', harness 'copilot'
```

## Requirements

### A. Discovery & safety

- Root: `config.copilotDir/session-state`. `copilotDir` null or `session-state` missing →
  health `missing`/`disabled`, everything empty.
- Read **only** `session-state/<id>/events.jsonl`, `session-state/<id>/workspace.yaml`, and list
  `session-state/<id>/` entries to detect `inuse.<pid>.lock`. Never read `config.json`,
  `command-history-state.json`, `session-store.db`, `logs/`, `ide/`, or anything else.
- `workspace.yaml`: parse only top-level `key: value` scalars (`id, name, cwd, created_at,
  updated_at, client_name, summary_count, user_named`) with a tiny line parser (no YAML lib;
  handle quoted values).

### B. Session model

- `id` = directory name; `harness 'copilot'`; `parentId: null` (v1); `agent: 'copilot'`.
- `title` = `workspace.name` (if `user_named` or non-empty) || first user message one-line
  (≤ 80) || `"Copilot session"`.
- `directory` = `workspace.cwd` || `session.start.data.context.cwd`.
- `createdAt` = `workspace.created_at` || first event timestamp; `updatedAt` = max(
  `workspace.updated_at`, last event timestamp, file mtime).
- `model`: last `assistant.message.data.model` or `tool.execution_start.data.model` ||
  `session.start.data.selectedModel` → `{ providerId: 'github-copilot', modelId }`.
- `tokens` zeros, `cost` 0; `facts`: Copilot version (`session.start.data.copilotVersion`),
  premium requests (`session.usage_checkpoint.data.totalPremiumRequests`, latest), model
  routing (`session.auto_mode_resolved.data.chosenModel`).
- `processAlive`: an `inuse.<pid>.lock` entry exists and `process.kill(pid, 0)` succeeds
  (EPERM ⇒ alive).
- `transcriptState`: pending `permission.requested` (no matching `permission.completed`) →
  `waiting`; `assistant.turn_start` without a later `turn_end` (and no shutdown/abort after it) →
  `working`; last of `session.error`/`abort` after the last turn → `error`; else `done` if any
  turn ended, else `unknown`.
- `current`: running tool (start without complete) → `{kind, label: displayName, detail}`;
  open turn without running tool → `{kind:'thinking', label:'Thinking'}`.
- `lastPrompt`/`lastMessage` from the latest `user.message`/`assistant.message` content.

### C. Events → ActivityEvents (data-sources §2 table)

- ids: `copilot:<sessionId>:<event.id>`; tool calls use `copilot:<sessionId>:tool:<toolCallId>`
  so start and complete merge into one event (`rev` = event timestamp ms).
- `user.message` → `prompt` (summary = content). `assistant.message` → a `thinking` event
  (`…:<event.id>:thinking`) when `reasoningText` is non-empty, plus a `text` event when
  `content` is non-empty. `tool.execution_start/complete` → tool events classified with
  `createToolClassifier().classify('copilot', toolName)`; `arguments` → input preview (for
  `bash`: `arguments.command`; `view`/`edit`/`create`: path argument; `rg`/`glob`: pattern),
  `result` → output preview (string or JSON), `success:false` → status `error`; files from
  path arguments; `create`/`edit`/`apply_patch` → kind `file-change`.
  `permission.requested` → `permission` (status `pending`, title "Permission requested · <tool
  or kind>"); `permission.completed` → same id with status `completed`/`error` by `result`.
  `session.error`/`abort` → `error`. `subagent.*` → `subagent` (best effort, title = type).
  Others (hooks, system messages, auto-mode, warnings, usage) → not emitted.
- Redact everything (`redactText`/`redactValue`); bounded by `LIMITS`; `links` extracted from
  full text/results.

### D. Tailing

- At `start()`: list session dirs; for sessions whose `events.jsonl` mtime ≥ `now − windowMs`,
  parse fully (stream line by line; files are small, but cap at 20 MB per file — beyond that,
  parse only the last 20 MB and mark health `degraded`), remember `{size, offset, mtimeMs}`.
  Older sessions are known by id/mtime only and parsed lazily on demand (`getSession`, etc.).
- `watchDirectory(session-state, …)` (lib) plus a 2 s stat poll of window files: on growth,
  read only appended bytes, buffer a partial trailing line, parse complete lines, update the
  session, emit `sessions` + `activity` (coalesced by id). On shrink/rotation (size < offset),
  re-parse from 0 and emit `reset` for that session (`{type:'reset', reason}`) only if the
  whole store needs reloading; otherwise just re-emit the session.
- New session directories appear → parse and emit.
- Never overlap ticks; errors per file are isolated (one bad file never stops others).

### E. HarnessSource queries

Implement every method of `HarnessSource` over the in-memory parsed model (lazy-load sessions
outside the window): `listSessions`, `getSession`, `getChildren` (→ `[]`), `getCounters`,
`getToolStats`, `getTodos` (→ `[]`), `getTranscript` (group events into messages by
`turnId`/`messageId`: user message → `role:'user'`; each assistant turn → one `assistant`
message with its thinking/text/tool items; paging by message), `getActivity`,
`recentActivity`, `getPart` (by activity id → full redacted input/output), `getDiff`
(`apply_patch` arguments → `patch-text`; `create` content → `new-file`; `edit` with
old/new strings → synthesize a minimal unified diff; else `none`), `getFileChanges`.

### F. Fixture — `test/fixtures/copilot.ts`

`createCopilotFixture(dir)` → helpers to create session dirs with `workspace.yaml`, append
JSONL events (realistic shapes from data-sources §2, including `encryptedContent`,
`reasoningOpaque` fields that must never be emitted), create/remove `inuse.<pid>.lock` (use
`process.pid` for a live one, a dead pid like 999999 for a stale one), and a decoy
`config.json` with a fake token (`ghp_FAKE…`) to prove it is never read. `seedCopilotFleet()`:
one finished session (bash, view, rg, create, apply_patch, an MCP-like tool
`github-mcp-server-get_issue`, one failed tool), one live session (open turn, running bash,
pending permission request).

### G. Tests

Discovery/safety (decoys never read — wrap fs reads), workspace parsing, session derivation
(title/model/facts/state/current/processAlive), event normalization incl. merge of
start/complete, redaction, incremental tail (append lines incl. a partial line → one update with
only the new events), new session dir detection, truncation/rotation handling, transcript
grouping/paging, diffs, file changes, counters/tool stats.

### H. Manual check (read-only, real machine)

Start the source against `~/.copilot` with `windowMs` = 30 days, print session count, titles
(first 40 chars), states, event counts; stop. Include the output in the report.

## Acceptance

`npx vitest run src/server/sources/copilot` green; typecheck clean for owned files; manual check
lists the real sessions without errors.

## Report

Summary, files, tests + results, manual output, deviations (e.g. event types or fields that
differ from the plan).
