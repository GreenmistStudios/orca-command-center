# Task-5 — Orca orchestration DB reader

**Wave:** B (parallel with 2, 3, 4, 6, 7) · **Size:** M · **Depends on:** Task-1

## Goal

Implement `OrchestrationSource`: read Orca's `orchestration.db` (schema v43 tested) read-only and
schema-adaptively, producing runs, tasks (with dependency edges), dispatch attempts, messages,
and decision gates — orca-viz's semantics, adapted to the modern `runs` table — and announce
changes cheaply via `PRAGMA data_version`.

## Read first

- `docs/data-sources.md` §0, §5 (normative), §6
- `Plan.md` §6 (F4), §9.3 (attention uses `blocking` gates and failed tasks)
- `src/server/types.ts` (`OrchestrationSource`, `OrchestrationUpdate`)
- `src/shared/contract.ts` (`OrchRun`, `OrchTask`, `OrchDispatch`, `OrchMessage`, `OrchGate`,
  `OrchRunDetail`, `OrchTaskDetail`, `OrchestrationSummary`)
- `src/server/lib/{sqlite,time,text,redact}.ts`

## Ownership

`src/server/sources/orchestration/**` (+ co-located tests), `test/fixtures/orchestration.ts`.

## Public API

```ts
export const TESTED_SCHEMA_VERSION = 43
export function createOrchestrationSource(deps: SourceDeps): OrchestrationSource  // id 'orca-orchestration'
```

## Requirements

### A. Open, introspect, degrade

- `config.orchestrationDb === null` → health `missing`/`disabled`, `summary().available = false`.
- `openReadOnly(path)`; `userVersion()`; `columns()` for `runs`, `tasks`, `dispatch_contexts`,
  `worker_dispatches`, `messages`, `decision_gates`. Build queries only from present columns
  (`selectPresent(table, wanted[])`).
- Feature table (each entry: required columns + degraded sentence), e.g.
  - `tasks.deps` missing → "Dependencies unavailable — the DAG shows tasks without edges."
  - `dispatch_contexts` missing → "Dispatch attempts unavailable."
  - `messages` missing → "Messages unavailable — no conversation or message-based gates."
  - `decision_gates` missing → gates only from messages (no sentence if messages exist).
  - `runs` missing → group runs by `tasks.created_by_terminal_handle` (orca-viz fallback) with
    sentence "Runs table unavailable — runs grouped by coordinator terminal."
  - `tasks` missing or lacking `id`/`status` → health `error`, `available:false`.
- `summary.schemaVersion = user_version`, `testedSchemaVersion = 43`. Newer → health `degraded`
  with detail "schema v44 is newer than tested v43" (UI shows the banner); older → per-feature.

### B. Reading & derivation

- Read all rows of these tables on start and on every `data_version` change (they are small;
  cap each at 20,000 rows newest-first and add a degraded sentence if capped).
- Times: `parseTime` (SQL UTC strings get `Z`).
- **Runs:** from `runs` (skip `run_legacy_local` when it has no tasks). `objective`;
  `coordinatorHandle`; `createdAt`/`updatedAt`; `lastActivityAt` = max over its tasks'
  created/completed, dispatches' dispatched/completed/heartbeat, messages' created;
  `taskCount`, `statusCounts`, `dispatchCount`, `messageCount` (excluding heartbeats),
  `hasBlockingGate`. `coordinatorSessionId: null` (store resolves). Sort by `lastActivityAt`
  desc.
- **Tasks:** `title = task_title || display_name || first non-empty line of spec` (≤ 140);
  `specPreview` ≤ 240 + `specTruncated`; `deps` = parsed JSON array of strings (invalid → `[]`
  + count in health detail); `resultPreview` ≤ 240; `attemptCount` = number of dispatch rows;
  `latestDispatchId` = latest by `created_at`/rowid.
- **Dispatches:** `dispatch_contexts` joined (in JS) with `worker_dispatches.state` by
  dispatch id → `workerState`; `assigneeSessionId: null` (store resolves).
- **Messages:** `bodyPreview` ≤ 400 (redacted); `taskId` from `payload` JSON `taskId` when it
  names an existing task; heartbeats are counted, never returned in `newMessages`.
- **Gates:** union of `decision_gates` rows and `messages.type = 'decision_gate'` (question =
  `payload.question` || subject; options = `payload.options` || `[]`), merged on
  `(task_id, question)`; a reply whose `thread_id` = the gate message id resolves an
  unresolved message gate (`resolution` = reply body preview). `blocking` = status `pending`,
  or unresolved while the task status is `blocked`.
- `getRun(id)` → `OrchRunDetail` (all tasks/dispatches/messages(non-heartbeat)/gates of the
  run); `getTask(id)` → `OrchTaskDetail` with full `spec` (≤ 64 KB) and `result` (≤ 64 KB),
  redacted.

### C. Change detection & updates

- Poll `dataVersion()` every 2000 ms (unref'd). Changed → re-read, compute per-run digests
  (sha256 of the run's derived JSON), `changedRunIds` = runs whose digest changed (or
  appeared/disappeared), `newMessages` = messages with `sequence` > last seen max (non-heartbeat),
  emit `{type:'orchestration', summary, changedRunIds, newMessages}`. The first read after
  `start()` emits with all run ids changed and **no** `newMessages`.
- Detect a reset (`max(sequence)` decreased or task count dropped to 0 while runs exist) →
  health detail "orchestration state was reset" and emit all runs changed.
- `health()`: `{ id:'orca-orchestration', label:'Orchestration', status, path, version: 'v43', detail: '<n> runs · <n> tasks', … }`.

### D. Fixture — `test/fixtures/orchestration.ts`

`createOrchestrationFixture(dir, variant)` writing a real SQLite file with the v43 DDL for the
tables above (copy column definitions from data-sources §5 / the live schema; include
`user_version`). Variants:
- `current-machine`: 2 runs (`run_c0ffee000001` "Demo task board" with coordinator handle
  `term_c0ffee01-…`, and `run_legacy_local` with no tasks), 3 tasks all `ready`, no deps, no
  dispatches, no messages — must render as "3 tasks dispatched independently".
- `rich`: one run with 6 tasks (deps forming a small DAG: 2 roots → 3 → 1), dispatches with
  heartbeats, one `circuit_broken` dispatch with `failure_count: 3`, a `worker_done` message
  with `payload.taskId`, a `decision_gate` message with options and one unanswered gate on a
  `blocked` task, a `question` message, heartbeats.
- `old-schema`: `user_version` 5, `tasks` without `deps`, no `runs` table.
- `newer-schema`: `user_version` 44 with an extra unknown column.
Also a helper to append rows after start (writable connection, test-only) to test change
detection.

### E. Tests

Introspection/degradation per variant; run/task/dispatch/gate derivation for `rich`; gate
resolution via thread reply; blocking logic; `current-machine` summary; change detection
(append a message → one update with `newMessages` and the right `changedRunIds`; no change → no
query beyond `data_version`); reset detection; missing DB; time parsing; redaction of a fake
token in a message body.

## Acceptance

`npx vitest run src/server/sources/orchestration` green; typecheck clean for owned files; a
manual read-only run against the real `~/Library/Application Support/orca/orchestration.db`
prints the 1 visible run with 3 ready tasks (include output in the report).

## Report

Summary, files, tests + results, manual output, deviations.
