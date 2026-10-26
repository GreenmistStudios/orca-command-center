# Task-20 — Copilot CLI usage extraction

**Feature:** Token Flow · **Wave:** E1 (parallel with 18, 19, 21) · **Size:** M · **Blocks:** 23

## Goal

Make Copilot CLI a metered harness: turn each `model.model_call_success` event into a
`UsageSample` (tokens, cached tokens, AI units, TTFT, duration), expose `getUsageSamples`, emit
samples and "in flight" estimates live, and surface context-composition facts — while dropping
the heavy, sensitive request/response bodies at parse time.

## Read first

- `features/token-flow/Plan.md` §1 (verified Copilot fields), §3, §7, §9
- `docs/data-sources.md` §0 and §2 (Copilot — allowed files)
- Contract: `UsageSample`, `UsageEstimate`; `HarnessUpdate` (`usage`), `HarnessSource.getUsageSamples?`
- The adapter: `src/server/sources/copilot/{source,model,index}.ts`, tests, `test/fixtures/copilot.ts`

## Ownership

`src/server/sources/copilot/**` (+ tests) and `test/fixtures/copilot.ts`.

## Verified event shapes (real data)

- `model.model_call_started`: `data = { kind, model, modelInfo, timestampMs, turn }`
- `model.model_call_success`: `data = { callId, clientRequestId, copilotUsage: { token_details: [...], total_nano_aiu }, interTokenLatencyMs, kind, modelCall: { model, … }, modelCallDurationMs, outputTtftMs, quotaSnapshots, requestId, requestMessages, requestSettings, responseChunk, responseUsage: { prompt_tokens, prompt_tokens_details: { cached_tokens }, completion_tokens, completion_tokens_details: { accepted_prediction_tokens, rejected_prediction_tokens, reasoning_tokens? }, total_tokens, prompt_cache_frontier_source, prompt_cache_details_reported }, rte, serviceRequestId, toolCount, ttftMs, turn }`
- `session.shutdown`: `{ conversationTokens, currentTokens, systemTokens, toolDefinitionsTokens, tokenDetails, modelMetrics, totalApiDurationMs, totalNanoAiu, totalPremiumRequests, codeChanges, … }`
- Ignore entirely (never retain): `model.messages_snapshot`, `model.message`, `model.response`,
  `model.captured_assignment_context`, and the fields `requestMessages`, `responseChunk`,
  `quotaSnapshots`, `requestSettings`, `modelInfo` (beyond a model id), `rte`.

Inspect `copilotUsage.token_details` on real files (types/keys only, never print prompt content)
to find a cache-write count if present.

## Requirements

1. **Mapping** (`model.model_call_success` → `UsageSample`): `id 'copilot:<sessionId>:call:<callId>'`
   (fallback `…:<event.id>`); `ts` = event `timestamp`; `durationMs = modelCallDurationMs`;
   `startTs = ts − durationMs` (or the matching `model_call_started.timestampMs` for the same
   `turn` when present); `ttftMs = ttftMs`; tokens: `cacheRead = cached_tokens ?? 0`,
   `input = max(0, prompt_tokens − cacheRead)`, `cacheWrite` = token_details cache-write count if
   present else 0, `reasoning = completion_tokens_details.reasoning_tokens ?? 0`,
   `output = max(0, completion_tokens − reasoning)`; `cost null`;
   `aiu = total_nano_aiu / 1e9` (null when absent); `model = { providerId: 'github-copilot',
   modelId: modelCall.model ?? data.model }`; `agent 'copilot'`; `finish null`;
   `source 'copilot.model_call_success'`. Tolerate missing fields (0/null), never throw.
2. **Retention:** store only the mapped samples (and needed timing) in the session model; heavy
   fields must not be kept in memory beyond parsing a line.
3. **`getUsageSamples(sessionIds, { sinceMs }?)`** from the parsed models (lazy-load sessions
   outside the window, respecting the existing LRU), sorted by `ts`.
4. **Live:** on tailing appended lines, emit `{ type:'usage', samples, estimates }`:
   `model_call_started` → estimate `{ inFlight: true, estOutputTokens: 0, startedAt: timestampMs }`;
   `model_call_success` (or `session.error`/`abort`/`assistant.turn_end` without success) → sample
   (if success) + estimate `{ inFlight: false }`.
5. **Facts:** from the latest `session.shutdown`, add facts "Context (system · tools ·
   conversation)" = `systemTokens · toolDefinitionsTokens · conversationTokens` (formatted
   counts) and "API time" = `totalApiDurationMs`; keep existing premium-request / AIU facts.
6. **Counters:** existing `getCounters` unchanged; add nothing to `tokens`/`cost` on the
   `HarnessSession` other than: `tokens` = Σ samples' tokens (so Copilot sessions stop showing 0
   tokens), `cost` stays 0.

## Fixture & tests

Extend `test/fixtures/copilot.ts`: `ev.modelCallStarted(...)`, `ev.modelCallSuccess({ prompt,
cached, completion, reasoning?, nanoAiu, ttftMs, durationMs, model, callId })` that also embeds
large `requestMessages`/`responseChunk` containing a sentinel (`SECRET_PROMPT_SENTINEL`) and a
`quotaSnapshots` object; seed the finished/live fleet sessions with a few calls (the live
session ends with a started-but-not-finished call).

Tests: mapping math (input = prompt − cached, reasoning split, aiu), ids, ordering, `sinceMs`,
live start → success emits sample + estimate end, failure paths end estimates, the sentinel and
quota data never appear in any update/query result (JSON.stringify search), `HarnessSession.tokens`
equals Σ samples, facts from shutdown, eviction + reload keeps samples (re-parse).

## Real-data check (read-only)

Script (throwaway, not committed): start the source on the real `~/.copilot` (window 30 days),
print sessions with calls, Σ calls/tokens/AIU per session, and for sessions with a
`session.shutdown` compare Σ samples to its `tokenDetails` (report differences, don't fail).
Print numbers only.

## Verify

```bash
npx tsc -p tsconfig.server.json --noEmit 2>&1 | grep sources/copilot
npx tsc -p tsconfig.test.json 2>&1 | grep -E "sources/copilot|fixtures/copilot"
npx vitest run src/server/sources/copilot
```

## Report

Summary, files, tests, real-data numbers, observed `token_details` shape, deviations.
