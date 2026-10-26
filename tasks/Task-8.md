# Task-8 — Store & integration: joins, state, attention, stats, artifacts

**Wave:** C (parallel with 9–16) · **Size:** XL · **Depends on:** Tasks 2, 3, 4, 5, 6

## Goal

Replace the stub `createStore` with the real store: construct every source from config, seed the
in-memory model, join Orca ⇄ harness sessions ⇄ orchestration, derive session state, attention,
stats and artifacts (Plan §9 — normative), implement `StoreReader` for the HTTP routes, and
publish live updates to the hub. After this task, the server shows real data end to end.

## Read first

- `Plan.md` §7.2, §7.5, §9 (normative), §10, §11
- `docs/data-sources.md` §6 (join model)
- `src/server/types.ts` (all interfaces), `src/shared/contract.ts`
- The source implementations and fixtures from Tasks 3–6 (`src/server/sources/**`,
  `test/fixtures/*.ts`) and the hub/HTTP from Task-2 (`src/server/hub`, `src/server/http`,
  `src/server/main.ts`)

## Ownership

`src/server/store/**` (replace the stub; keep the export `createStore: CreateStore` in
`index.ts`), `test/integration/**`. Do not modify sources, hub, http, or contract files — if a
source has a bug or a missing capability, work around it in the store and list it in the report
(the coordinator will route the fix).

## Requirements

### A. Construction & lifecycle (`index.ts`, `sources.ts`)

- Build sources from config: `createOpenCodeSource`, `createCopilotSource` (each only when its
  path is non-null), `createOrcaCliSource` (when `orcaCli`), `createOrcaHooksSource` (when
  `hooksFile`), `createOrchestrationSource` (when `orchestrationDb`). Disabled sources still
  appear in `meta().sources` with status `disabled` and a reason.
- `start()`: start all sources in parallel (`Promise.allSettled`); a failing source never stops
  the store. Subscribe to every source. Seed:
  1. `listSessions(now − windowMs)` from each harness → session map (keyed by id; ids are
     unique across harnesses — if not, prefix with harness and report it).
  2. Ring buffer seeded from each harness `recentActivity({ sinceMs: now − windowMs, limit: 3000 })`
     plus orchestration messages (as `orchestration` activity events, §E).
  3. Orca CLI snapshot, hook entries, orchestration summary.
  4. Counters for window sessions (`getCounters`) — compute for live sessions first, the rest
     in background chunks (`setImmediate`, ≤ 25 ms per chunk) so `start()` resolves fast.
  5. Derive everything (§B–§D), then mark ready.
- Target: `start()` resolves ≤ 1.5 s on the real machine.
- `stop()`: unsubscribe, stop sources, clear timers.

### B. Session summaries (`summaries.ts`, `join.ts`, `state.ts`)

Build `SessionSummary` from `HarnessSession` + joins (cache per session; rebuild only touched
sessions on updates):
- `rootId`/`depth` from parent links (ask the harness `getSession` for missing ancestors;
  `childIds` from parents' children — maintain a children index; `descendantCount`).
- Workspace & Orca link per data-sources §6: hook by `providerSessionId` (newest `receivedAt`
  wins) → paneKey → terminal (`paneKey`) → worktree (`worktreeId`). Descendants inherit the
  root's `workspace` (but not pane/terminal fields). Unlinked sessions: longest worktree path
  prefix of `directory`, else `{ key: normalizedDirectory, name: basename, path: directory,
  repo: null, branch: null }`.
- Orchestration roles: terminal handle == `run.coordinatorHandle` → `role:'coordinator'`,
  `runId`; == a dispatch `assigneeHandle` → `role:'worker'`, `runId`, `taskId`, `dispatchId`.
  Also fill `OrchRun.coordinatorSessionId` and `OrchDispatch.assigneeSessionId` in everything
  the store returns.
- `TerminalInfo.sessionId` filled from hooks.
- State per **Plan §9.1** exactly (thresholds from `config.thresholds`, injectable clock).
  `stateSince`: hook `stateStartedAt` → time the store observed the state change → `lastActivityAt`.
- `live` per §9.1. `counters` from cache (null until computed). Recompute counters for a session
  at most every 5 s while it has new activity.
- A periodic **clock tick** (every 15 s) re-derives time-based states (working → unknown/stalled,
  done → idle) and publishes only sessions whose state/live changed.

### C. Ring buffer (`ring.ts`)

Per Plan §9.6: capacity `config.ringSize`, upsert by id keeping the highest `rev`, sorted by
`ts`, indexes by `sessionId` and `rootId` (rootId re-resolved by the store when the harness left
it null or wrong, e.g. hook transitions). `query({ sessionId?, rootId?, kinds?, before?,
sinceMs?, limit })` → `ActivityPage` (cursor `"<ts>:<id>"`).

### D. Attention, stats, artifacts (`attention.ts`, `stats.ts`, `artifacts.ts`)

- Attention per **Plan §9.3** (stable ids, sorting). Copilot pending permissions come through
  the session's `transcriptState === 'waiting'` plus the latest `permission` activity.
  Recompute on any change; publish only when the JSON differs.
- Stats per **Plan §9.5** (`getToolStats` cached 15 s; histogram from the ring). Publish at
  most every 5 s when inputs changed.
- Artifacts per **Plan §9.4**, for a root (`artifacts({rootId})`: activity from
  `getActivity(treeSessionIds, { kinds: ['file-change','text','tool','mcp','prompt'], limit:
  5000 })` + `getFileChanges`) or the whole window (ring + file changes of window sessions;
  cap 500). Cache 10 s per scope.

### E. Orchestration integration

On every `OrchestrationUpdate`: store the summary, resolve session links, convert `newMessages`
to ActivityEvents (`id: 'orch:'+message.id`, `harness` of the linked session or `'unknown'`,
`sessionId` = linked session of `from` handle (else null), `kind:'orchestration'`, `title:
"<type> · <subject>"`, `summary: bodyPreview`, `ts: createdAt`, `source:'orchestration.messages'`),
upsert into the ring and publish; publish `orchestration` with `changedRunIds`. `orchestrationRun`
/`orchestrationTask` delegate to the source then fill session links.

### F. StoreReader (`store.ts`)

Implement every method (types.ts) with Plan §10.2 semantics:
- `meta()`: version, bootId (from hub), startedAt, now, host, port, `readOnly:true`,
  `windowMs`, `sources` (each source's `health()`, plus disabled ones), `orca` status.
- `bootstrap()`: consistent snapshot built synchronously; `seq = hub.seq`; sessions in the
  window + ancestors; activity = last `LIMITS.bootstrapActivity` non-step events from the ring.
  Must serialize to ≤ 2 MB on the real machine (truncate oldest activity if needed).
- `listSessions(query)`, `sessionDetail(id)` (ancestors, children, todos via harness,
  fileChanges for that session, artifacts for that session, provenance strings like
  `"opencode.db · session"`, `"Orca hooks · pane <paneKey>"`, `"orca terminal list · <handle>"`),
  `sessionTree(id)` (root + all descendants — load missing descendants through
  `getChildren` recursively, cap 500 nodes; edges from `spawn` with label `description` and the
  spawn status; `orchestration` when the root is a coordinator), `transcript`, `activity`
  (session/root → harness `getActivity` for the right sessions merged with Orca-hook and
  orchestration events from the ring; no scope → ring), `part`/`fileDiff` (route by id prefix:
  `opencode:` / `copilot:` → that harness; ids without a prefix try each harness), `fileChanges`,
  `artifacts`, `attention`, `stats(windowMs)`, `orca()`, `orchestration()`,
  `orchestrationRun(id)`, `orchestrationTask(id)`.
- Methods must not throw for unknown ids (return null); bad source states produce empty results.

### G. Publishing (`publish.ts`)

Map source updates to hub payloads:
- Harness `sessions` → rebuild summaries → `sessions` (only changed ones; compare a cheap
  digest).
- Harness `activity` → re-resolve rootId → ring upsert → `activity`; plus `sessions` for the
  touched sessions (current/lastActivityAt/state) and, if relevant, `attention`.
- Harness `todos` → nothing to publish directly (clients refetch details), but mark the
  session's detail as changed by publishing the session summary.
- Harness `reset` → reseed that harness, then publish `sessions` (full) and a `meta`.
- Orca CLI `status` → `orca{status}` + `meta`; `fleet` → `orca{worktrees, terminals}` +
  re-join → changed `sessions`.
- Hooks → `orca{hooks}` + transitions into the ring (`activity`) + re-derive states → changed
  `sessions` + `attention`.
- Source health changes → `meta` (debounced 1 s).

### H. Integration tests (`test/integration/**`)

Using the fixtures from Tasks 3–6 (temp dirs) and a fake CLI runner:
1. **Boot**: real `createStore` + real `createHub` + real HTTP server (port 0) → `GET
   /api/bootstrap` has sessions from OpenCode and Copilot, orca snapshot, orchestration runs,
   attention (the pending question/permission), stats; `GET /api/sessions/:id/tree` returns the
   OpenCode root with its children and labelled edges.
2. **Join**: a hook entry for the OpenCode root session → summary has `orca.paneKey`,
   `terminalHandle`, workspace from the worktree, state from the hook (`blocked` → attention
   `permission`).
3. **Live**: append OpenCode events → within one poll + flush, the SSE stream delivers an
   `activity` frame with the new part and a `sessions` frame with updated `current`; append a
   Copilot JSONL line → same; rewrite the hooks file (atomic) → `orca` + `activity` (state
   transition) + `sessions` frames.
4. **State rules**: table-driven unit tests for §9.1 with a fake clock (each branch).
5. **Attention/stats/artifacts**: unit tests per rule (PR URL → pull-request artifact, write of
   `Plan.md` → document, new file → new-file).
6. **Resilience**: missing OpenCode DB, Orca CLI failing, newer orchestration schema →
   bootstrap still valid; `meta.sources` statuses correct.
7. **Safety**: grep all HTTP responses of the integration run for the fixtures' fake secrets
   (`ghp_FAKE`, denied-table contents) → none.

### I. Real-machine smoke (read-only)

`npm run build && node bin/occ.mjs --no-open --port 4272 --verbose`, then:
`curl -s localhost:4272/api/bootstrap | jq '{sources: .meta.sources | map({id,status,detail}), sessions: (.sessions|length), live: [.sessions[]|select(.live)|{title,state,agent}], attention: .attention|length, runs: .orchestration.runs|length}'`,
time the bootstrap request, and watch `curl -N localhost:4272/api/stream` for ~20 s while
agents are working. Include outputs and timings in the report. Stop the server afterwards.

## Acceptance

Integration and unit tests green (`npx vitest run src/server/store test/integration`);
typecheck clean for owned files; real-machine smoke shows live sessions (including this build's
own OpenCode session and its subagents) with plausible states; bootstrap ≤ 1.5 s after start.

## Report

Summary, files, tests + results, smoke outputs/timings, source bugs or gaps found (with file
and behavior), deviations.
