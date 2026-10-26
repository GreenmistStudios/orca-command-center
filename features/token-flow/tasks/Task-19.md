# Task-19 — OpenCode usage extraction & streaming estimates

**Feature:** Token Flow · **Wave:** E1 (parallel with 18, 20, 21) · **Size:** L · **Blocks:** 23

## Goal

Teach the OpenCode adapter to produce the token-flow data: a `UsageSample` for every metered
LLM call (`step-finish`), queryable per session (`getUsageSamples`) and emitted live from the
event tail, plus `UsageEstimate`s that grow while a call is streaming.

## Read first

- `features/token-flow/Plan.md` §1 (verified facts), §3, §7 (estimates), §9
- `docs/data-sources.md` §0 (safety) and §1 (OpenCode — indexes, event tail)
- Contract: `UsageSample`, `UsageEstimate` (src/shared/contract.ts); `HarnessUpdate` (`usage`
  member) and `HarnessSource.getUsageSamples?` (src/server/types.ts)
- The adapter: `src/server/sources/opencode/index.ts`, `normalize.ts`, its tests, and
  `test/fixtures/opencode.ts`

## Ownership

`src/server/sources/opencode/**` (+ tests) and `test/fixtures/opencode.ts`. Nothing else.

## Requirements

### A. `getUsageSamples(sessionIds, { sinceMs }?)`

For each session, using only indexed access (`part_session_idx`, `message_session_time_created_id_idx`,
`part_message_id_id_idx`) and **projected** fields (no full `data` blobs returned to JS):

1. Step-finish rows: `SELECT id, message_id, time_created, json_extract(data,'$.tokens.input') AS ti,
   …'$.tokens.output', '$.tokens.reasoning', '$.tokens.cache.read', '$.tokens.cache.write',
   '$.cost', '$.reason' FROM part WHERE session_id = ? AND json_extract(data,'$.type') = 'step-finish'
   [AND time_created >= ?]`.
2. Step-start times per message: same filter for `'step-start'` → `message_id → [time_created…]`
   (pair the k-th start with the k-th finish of a message; one per message today).
3. First output time per message: `SELECT message_id, min(json_extract(data,'$.time.start')) FROM
   part WHERE session_id = ? AND json_extract(data,'$.type') IN ('text','reasoning') GROUP BY message_id`.
4. Message model/agent: `SELECT id, json_extract(data,'$.modelID'), json_extract(data,'$.providerID'),
   json_extract(data,'$.agent'), json_extract(data,'$.mode') FROM message WHERE session_id = ?`.

Map to `UsageSample`: `id 'opencode:<partId>'`, `harness 'opencode'`, `sessionId`, `rootId null`,
`ledgerSeq 0`, `ts = time_created` of the step-finish part, `startTs` = paired step-start time
(else null), `durationMs = ts − startTs`, `ttftMs = firstOutput − startTs` when within
`[0, durationMs]`, `model` from the message (fallback: session model), `agent` = message agent ??
mode ?? session agent, `tokens` from the projected fields (missing → 0), `cost` = number or null,
`aiu null`, `finish = reason`, `source 'opencode.step-finish'`. Return all sessions' samples
sorted by `ts` (then id). Unknown session ids → no samples. Missing `event` table (polling mode)
must still work.

### B. Live usage from the event tail

In tail processing (`message.part.updated.1`, `message.updated.1`), maintain per session an
in-flight call `{ messageId, startedAt, est, firstOutputAt, lastEmitAt }` and per part the last
seen text length / whether a tool input was counted (LRU ~5000):

- `step-start` part → start (or restart) the in-flight call: `startedAt` = event `data.time`.
- assistant `text` / `reasoning` part growth → `est += estimateTokensFromChars(Δchars)` (Δ ≥ 0
  from the previous known length of that part); `firstOutputAt ??=` part `time.start` or event time.
  Use the full part text from the event (not the truncated summary). Do the length math with the
  shared helper `estimateTokensFromChars` from `src/shared/usage-math.ts` if it exists at the time
  you implement; otherwise inline `Math.ceil(chars/4)` and leave a `// TODO(Task-18)` note — the
  coordinator will switch it.
- assistant `tool` part first seen with a non-empty `state.input` → `est += ceil(JSON.stringify(input).length / 4)` once per callID.
- `step-finish` part → build the metered sample exactly as in A (startTs from the in-flight
  call or by querying the message's step-start part with `part_message_id_id_idx`; ttft from
  `firstOutputAt`; model/agent from the message cache) and end the estimate (`inFlight:false`).
- `message.updated.1` with `time.completed` (or `error`) for the in-flight message and no
  step-finish seen → end the estimate.
- Emit **one** `{ type: 'usage', samples, estimates }` update per tick when either is non-empty,
  after the existing `sessions`/`activity` updates. Estimates per session at most every 500 ms
  (always emit start and end). Coalesced batches may contain step-start + growth + finish for
  the same call — handle all orders; never emit a sample twice for one part id.

### C. Startup in-flight detection (best effort)

At `start()`, for live window sessions whose latest assistant message has a step-start but no
step-finish and was updated within `config.thresholds.workingMs`, emit an initial in-flight
estimate (est from the current text/reasoning lengths of that message's parts, via projected
`length(json_extract(data,'$.text'))`).

### D. Fixture & tests

Extend `test/fixtures/opencode.ts` with helpers to add step-start / step-finish parts with
tokens and cost, and to append streaming growth events (`appendTextGrowth(partId, text)`), and
make `seedRealisticFleet` produce step-start/step-finish pairs with realistic tokens (cache read
dominant) for its sessions — keep existing ids and existing tests green.

Tests: sample mapping (all fields, missing fields, cost null), sort order, `sinceMs`, timing
(duration/ttft), EXPLAIN QUERY PLAN for every new query uses `SEARCH` with an index; live
estimates (start → growth → finish → sample + end; finish without start in the same batch;
message completed without finish; throttle); no duplicate samples across ticks; denied-table and
no-secret guarantees still hold. **Totals check:** Σ samples of each fixture session equals its
`session` row token/cost totals.

### E. Real-data check (read-only)

Extend `bench.ts` to print, for the 3 most recently updated window sessions: sample count, Σ
tokens/cost vs the `session` table row (must match exactly), p50 TTFT, and `getUsageSamples`
time. Run `npx tsx src/server/sources/opencode/bench.ts` and include the output.

## Verify

```bash
npx tsc -p tsconfig.server.json --noEmit 2>&1 | grep sources/opencode
npx tsc -p tsconfig.test.json 2>&1 | grep -E "sources/opencode|fixtures/opencode"
npx vitest run src/server/sources/opencode
```

## Report

Summary, files, tests, bench output (exact-match evidence), deviations, the fixture helper API.
