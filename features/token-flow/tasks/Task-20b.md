# Task-20b — Copilot session-summary usage

**Feature:** Token Flow · **Wave:** E2 (parallel with 22, 23) · **Size:** S · **Depends on:** 20

## Why

Real data (Task-20): Copilot CLI writes `model.model_call_success` only for small auxiliary
calls (16 calls, 3,272 tokens on this machine) while `session.shutdown` reports the main-model
usage (Σ 6.4M input tokens, ≈ 367 AIU). Without this task, Copilot sessions would look almost
free and workflow/fleet totals would be wrong.

## Read first

- `features/token-flow/Plan.md` §1 (the finding), §3 (definitions), §9 (accuracy)
- Contract `UsageSample` (src/shared/contract.ts); the Copilot adapter after Task-20
  (`src/server/sources/copilot/{model,source}.ts`, tests, `test/fixtures/copilot.ts`)

## Ownership

`src/server/sources/copilot/**`, `test/fixtures/copilot.ts`.

## Verified shape

`session.shutdown.data.modelMetrics = { [modelId]: { requests: { count, cost /* premium requests */ }, usage: { inputTokens /* = fresh + cacheRead + cacheWrite */, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }, totalNanoAiu, tokenDetails: { input: { tokenCount /* fresh */ }, cache_read, cache_write, output } } }`
plus session-level `totalNanoAiu`, `totalPremiumRequests`, `tokenDetails`, `totalApiDurationMs`.
Example: inputTokens 59,194 = input 4 + cache read 46,342 + cache write 12,848.
`session.usage_checkpoint.data = { totalNanoAiu, totalPremiumRequests, … }` (cumulative, live).

## Requirements

1. **Per-model summary samples** on each `session.shutdown` with `modelMetrics`:
   model totals → `TokenUsage`: `cacheRead = cacheReadTokens`, `cacheWrite = cacheWriteTokens`,
   `input = tokenDetails.input.tokenCount ?? max(0, inputTokens − cacheRead − cacheWrite)`,
   `reasoning = reasoningTokens ?? 0`, `output = max(0, outputTokens − reasoning)`;
   `aiu = totalNanoAiu / 1e9`. Subtract every per-call sample of the same model already counted
   for this session period (field-wise, clamp ≥ 0) and emit the **remainder** as one sample:
   `id 'copilot:<sid>:summary:<shutdownEventId>:<modelId>'`, `ts` = shutdown timestamp,
   `startTs` = start of the period (session start or previous resume), `durationMs null`,
   `ttftMs null`, `cost null`, `finish 'session-summary'`, `source 'copilot.session-summary'`,
   `agent 'copilot'`, model `{ providerId: 'github-copilot', modelId }`. Skip all-zero remainders.
2. **Multiple shutdowns** (resumed sessions): inspect real data (numbers only) to decide whether
   a later shutdown's metrics are cumulative or per-run; implement accordingly (cumulative →
   subtract what earlier summaries + calls already counted; per-run → additive), document the
   rule in code, and test both shapes.
3. **Exactness:** for every ended session, Σ of all its samples (calls + summaries) equals the
   shutdown totals summed over models (tokens field-wise; AIU within 1e-6).
   `HarnessSession.tokens` = Σ samples.
4. **Live sessions** (no shutdown yet): facts "AI units so far" (`totalNanoAiu / 1e9`, 2
   decimals) and "Premium requests" from the latest `session.usage_checkpoint`; and
   `facts` entry `{ label: 'Token usage', value: 'reported when the session ends' }` so the UI can
   explain the gap. No synthetic tokens.
5. **Live emission:** a tailed `session.shutdown` emits its summary samples through the existing
   `usage` update; `getUsageSamples` includes summaries.
6. Never retain or emit prompt/response bodies (existing rule).

## Tests

Remainder math (calls of the same model subtracted, other models untouched, clamping),
single and multiple shutdown shapes, exactness (Σ samples == shutdown totals), live
checkpoint facts, live tail of a shutdown line → `usage` update, no sentinel leakage.

## Real-data check (read-only, numbers only)

Throwaway script: for every ended session, Σ samples vs Σ modelMetrics (tokens + AIU) → print
match counts; number of sessions with multiple shutdowns and which rule applied.

## Verify

```bash
npx tsc -p tsconfig.server.json --noEmit 2>&1 | grep sources/copilot
npx tsc -p tsconfig.test.json 2>&1 | grep -E "sources/copilot|fixtures/copilot"
npx vitest run src/server/sources/copilot
```

## Report

Summary, files, tests, real-data reconciliation numbers, the multiple-shutdown rule chosen and
the evidence, deviations.
