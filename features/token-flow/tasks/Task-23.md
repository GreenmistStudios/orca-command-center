# Task-23 — Server usage ledger, rollups, API & SSE

**Feature:** Token Flow · **Wave:** E2 (parallel with 22) · **Size:** XL · **Depends on:** 18, 19, 20

## Goal

The server half of token flow: a bounded **usage ledger** fed by the harness adapters, exact
rollups (session, workflow, run, fleet), `SessionSummary.usage` and `FleetStats.usage`, the
`/api/usage` + `/api/usage/calls` endpoints, and live `usage` SSE frames.

## Read first

- `features/token-flow/Plan.md` §3, §4, §7 (ledger & live merge — normative), §8 (API —
  normative), §9, §10
- Contract token-flow section; `src/server/types.ts` (`HarnessUpdate.usage`,
  `getUsageSamples?`, `StoreReader.usage?`/`usageCalls?`, `UsageQuery`, `UsageCallsQuery`)
- `src/shared/usage-math.ts` (Task-18 — all arithmetic goes through it)
- Store: `src/server/store/{index,store,stats,publish,join,state,ring,attention,artifacts}.ts`;
  hub `src/server/hub/hub.ts`; routes `src/server/http/routes.ts`; integration harness
  `test/integration/{env,store.test}.ts`; adapters' new usage APIs (Tasks 19/20)

## Ownership

`src/server/store/**`, `src/server/hub/**`, `src/server/http/routes.ts` (+ http tests),
`test/integration/**`.

## Requirements

### A. Ledger (`store/usage-ledger.ts`)

- `ingest(samples)`: assign `ledgerSeq` (monotonic), resolve `rootId` (store parent links),
  upsert by id (identical re-ingest is a no-op; changed values replace and get a new seq),
  per-session arrays kept sorted with `insertSorted`; returns the accepted samples.
- `setEstimate(e)` / `endEstimate(sessionId)`; estimates expire after 2 min without updates.
- Indexes: by session; workflow membership computed from the store's children index (roots can
  change when parents are discovered later — re-resolve `rootId` on rebuild).
- `loaded` set: sessions whose full history is in the ledger. Bounds: ≤ 200,000 samples; evict
  fully-loaded sessions that are outside the window and not queried for 10 min (LRU), never
  window or live sessions; record evictions in health detail.

### B. Seeding & ingestion

- After `store.start()` resolves, seed in background chunks (`setImmediate`, ≤ 25 ms per chunk):
  live sessions first, then the rest of the window; each harness `getUsageSamples(ids)` (all-time
  per session so totals are complete). Boot budget must not regress (first bootstrap ≤ 1.5 s).
- On-demand: workflow/session/run reports for sessions not `loaded` load them synchronously
  (bounded: ≤ 300 sessions per request) before computing.
- Harness `usage` updates → ingest samples, update estimates → publish
  `{ type:'usage', samples: accepted, estimates }` → mark touched sessions (and their roots)
  dirty → rebuild + publish their summaries (≤ 2 Hz per session).

### C. Rollups

- `SessionSummary.usage` for sessions in the ledger (absent otherwise): calls, inflow, outflow,
  aiu, cacheHitRate (session's own calls); `tree` on roots (root + all known descendants);
  `rates` (5-min `ratesOf`) for live sessions; `inFlight` estimate.
- For OpenCode sessions with a fully-loaded ledger, `usage` totals must equal the session's
  `tokens`/`cost` exactly — if not, log once per session and keep the harness totals in
  `tokens`/`cost` (they are authoritative).
- `FleetStats.usage` = totals + 5-min rates of calls with `ts` in the window.

### D. Reports (`store/usage-report.ts`) → `StoreReader.usage(query)` / `usageCalls(query)`

- Scope resolution: fleet (window default `config.windowMs`); workflow (`id` = any session id →
  its root; sessions = root + descendants); session; run (`id` = run id → sessions linked as
  coordinator or dispatch assignee + their descendants; none → empty report with coverage note
  "No sessions are linked to this run."). Unknown id → null (404).
- Window: fleet default window; others all-time unless `windowMs` given.
- Build with the shared math: totals, rates (5 min, asOf now), series (`chooseBucketMs` over the
  scope span unless `bucketMs`), breakdowns (model/agent/session/harness; session labels from
  titles; model labels short ids), sankey (`middle` default: fleet → agent, workflow → session,
  session → model, run → session), `recentCalls` (last `LIMITS.usageReportCalls`), `inFlight`,
  `output` (workflow/session: file changes count/files/+/− and artifacts/PRs from existing store
  methods; null otherwise), `coverage` (sessions with/without calls; notes such as "N Copilot CLI
  sessions predate per-call usage events"), `ledgerSeq` watermark (max seq at build time).
- Cache per query key 2 s; invalidate when an ingest touches the scope. Target ≤ 50 ms warm for
  a 26-session workflow.
- `usageCalls`: newest-first paging with cursor `"<ts>:<id>"`, each page ordered oldest →
  newest, `limit` ≤ `LIMITS.usageCallsPageMax`.

### E. Hub & routes

- Hub coalescing for `usage`: samples merged by id keeping the highest `ledgerSeq`, estimates by
  `sessionId` keeping the latest `updatedAt` (an end — `inFlight:false` — wins over an older
  start); one frame per flush; tests.
- Routes `GET /api/usage` (`scope` required ∈ fleet|workflow|session|run; `id` required unless
  fleet; `windowHours` 1–720; `bucketMs` 1000–86,400,000; `middle` ∈ agent|session|model) and
  `GET /api/usage/calls` (`scope`, `id`, `before`, `limit` 1–2000, default 200); unknown keys 400;
  store without `usage` → 503 `unavailable`; null → 404. Update the route table test that
  asserts every `ApiResponses` key is routed.

### F. Tests

Ledger unit tests (seq, upsert, sort, root re-resolution, eviction bounds, estimate expiry);
report tests for each scope (fixtures: OpenCode fleet with step-start/finish pairs from Task-19's
fixture, Copilot calls from Task-20's fixture, orchestration rich run linked to a session via a
hook/terminal fixture); **exactness**: for every fixture session, `/api/usage?scope=session`
totals equal `/api/sessions/:id` `tokens`/`cost`, workflow totals equal Σ sessions; live: append
a step-finish event → SSE `usage` frame (samples + estimate end) and a `sessions` frame with
updated `usage`; Copilot `model_call_success` append → sample with `aiu`; hub coalescing; routes
validation; boot-time budget unaffected (seeding is async).

### G. Real-machine smoke (read-only)

`npm run build:server && node bin/occ.mjs --no-open --port 4272`, then for the 3 most recent
OpenCode sessions compare `/api/usage?scope=session&id=…` totals with `/api/sessions/…`
(`tokens`, `cost`) → exact; time `/api/usage?scope=workflow&id=<most active root>` cold and warm;
`/api/usage?scope=fleet`; watch `/api/stream` for `usage` frames while an agent works. Stop the
server afterwards.

## Verify

```bash
npx tsc -p tsconfig.server.json --noEmit 2>&1 | grep -E "src/server/(store|hub|http)"
npx tsc -p tsconfig.test.json 2>&1 | grep -E "src/server/(store|hub|http)|test/integration"
npx vitest run src/server/store src/server/hub src/server/http test/integration
```
(Build with `npm run build:server` only — UI tasks may be editing the client.)

## Report

Summary, files, tests, smoke outputs (exact-match evidence, timings), adapter gaps found,
deviations.
