# Task-18 — Shared usage math

**Feature:** Token Flow · **Wave:** E1 (parallel with 19, 20, 21) · **Size:** M · **Blocks:** 22, 23 (and every UI task indirectly)

## Goal

One pure, dependency-free TypeScript module that defines all token arithmetic — used by the
server (ledger rollups, reports) **and** the client (live deltas on top of a fetched report), so
the two can never disagree.

## Read first

- `features/token-flow/Plan.md` §1, §3 (definitions — normative), §4, §7, §8
- `src/shared/contract.ts` section "Token usage & flow" (`UsageSample`, `UsageTotals`,
  `UsageRates`, `UsageBucket`, `UsageBreakdownRow`, `UsageSankey`, `TokenUsage`, `ModelRef`,
  `LIMITS.usage*`)

## Ownership

`src/shared/usage-math.ts` and `src/shared/usage-math.test.ts` only. No dependencies, no Node or
DOM APIs (it runs in both environments). Relative imports use `.js` extensions
(`import type … from './contract.js'`).

## API (normative — implement exactly; add internal helpers freely)

```ts
export const ZERO_TOKENS: Readonly<TokenUsage>
export function tokensOf(partial?: Partial<TokenUsage>): TokenUsage          // missing fields → 0, non-finite → 0
export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage
export function inflowOf(t: TokenUsage): number                               // input + cacheRead + cacheWrite
export function outflowOf(t: TokenUsage): number                              // output + reasoning
export function cacheHitRate(t: TokenUsage): number | null                    // cacheRead / inflow; null if inflow 0
export function emptyTotals(): UsageTotals
export function addSample(totals: UsageTotals, s: UsageSample): UsageTotals   // MUTATES and returns totals
export function totalsOf(samples: Iterable<UsageSample>): UsageTotals
export function mergeTotals(a: UsageTotals, b: UsageTotals): UsageTotals      // new object
export function compareSamples(a: UsageSample, b: UsageSample): number        // ts asc, then id
export function insertSorted(arr: UsageSample[], s: UsageSample): number      // binary insert; returns index; replaces an existing element with the same id
export function lowerBoundTs(arr: readonly UsageSample[], ts: EpochMs): number // first index with s.ts >= ts
export function ratesOf(sorted: readonly UsageSample[], asOf: EpochMs, windowMs: number): UsageRates
export const NICE_BUCKETS_MS: readonly number[]                               // 1s 2s 5s 10s 15s 30s 1m 2m 5m 10m 15m 30m 1h 2h 3h 6h 12h 1d
export function chooseBucketMs(spanMs: number, maxBuckets?: number): number   // smallest nice step giving ≤ maxBuckets (default LIMITS.usageSeriesMaxBuckets)
export function alignDown(ts: EpochMs, bucketMs: number): EpochMs
export function bucketize(samples: Iterable<UsageSample>, fromTs: EpochMs, toTs: EpochMs, bucketMs: number): UsageBucket[] // contiguous, aligned, empty buckets included; outside samples ignored
export function addToSeries(series: { bucketMs: number; buckets: UsageBucket[] }, s: UsageSample): void // in place; appends empty buckets up to the sample's bucket; ignores samples older than the first bucket
export function trimSeries(series: { bucketMs: number; buckets: UsageBucket[] }, fromTs: EpochMs): void   // drop buckets ending before fromTs
export function modelKey(m: ModelRef | null): string                          // 'provider/model' | 'model' | 'unknown'
export function breakdown(samples: Iterable<UsageSample>, kind: UsageBreakdownKind, labels?: { session?: (id: string) => string; model?: (key: string) => string; agent?: (name: string) => string }): UsageBreakdownRow[]
export function addToBreakdown(rows: UsageBreakdownRow[], s: UsageSample, kind: UsageBreakdownKind, scopeTokens: number, labels?: …): void // in place; recompute shares
export function buildSankey(samples: Iterable<UsageSample>, middle: 'agent' | 'session' | 'model', opts?: { maxMiddle?: number; label?: (key: string) => string }): UsageSankey
export function addToSankey(sankey: UsageSankey, s: UsageSample, opts?: …): void // in place (creates missing nodes/links; "Other" handling stable)
export function throughputTps(s: UsageSample): number | null                  // outflow / ((durationMs − (ttftMs ?? 0)) / 1000); null when unknown or ≤ 0
export function percentile(values: readonly number[], p: number): number | null // linear interpolation, p in [0,1]
export function ttftStats(samples: Iterable<UsageSample>): { p50: number | null; p95: number | null; n: number }
export function estimateTokensFromChars(chars: number): number               // ceil(chars / 4), ≥ 0
export function sampleKeyOf(s: UsageSample, kind: UsageBreakdownKind): string // session → sessionId, agent → agent ?? 'unknown', model → modelKey, harness → harness
```

### Semantics

- `addSample`: calls += 1; tokens += s.tokens; inflow/outflow updated; `cost += s.cost` and
  `costedCalls += 1` only when `s.cost` is a finite number; `aiu += s.aiu` when finite;
  `cacheHitRate` recomputed; `firstTs`/`lastTs` min/max of `s.ts`.
- `ratesOf`: window `(asOf − windowMs, asOf]` via binary search on the sorted array; per-minute
  rates scaled by `60_000 / windowMs`; `costPerHour` by `3_600_000 / windowMs`.
- `breakdown`: one row per key, sorted by `inflow + outflow` desc (ties: key asc); `share` =
  row tokens / Σ tokens (0 when Σ is 0); `sessionId` set for kind `session`; `harness` set when
  all the row's samples share one harness (else null); labels default to the key (model rows:
  the model id without provider).
- `buildSankey` (3 columns):
  - sources `src:input` / `src:cacheRead` / `src:cacheWrite` (labels "Fresh input", "Cache read",
    "Cache write"), sinks `sink:output` / `sink:reasoning` ("Output", "Reasoning"); omit
    zero-value nodes.
  - middle `mid:<key>` per group (`sampleKeyOf` with kind `agent | session | model`); keep the top
    `maxMiddle` (default `LIMITS.usageSankeyMaxMiddle`) by tokens, merge the rest into
    `mid:other` labelled `Other (N)`.
  - links `src:<flow>→mid:<key>` and `mid:<key>→sink:<flow>` with `value` = Σ tokens of that flow
    (omit 0); link id `<source>→<target>`.
  - node `value`: sources/sinks = Σ of their links; middle = max(Σ in, Σ out); middle `cost` =
    Σ cost (null when no costed call).
- `addToSankey` must produce the same result as rebuilding from all samples **as long as the
  top-N membership doesn't change**; if a new key would enter the top N, it goes to `Other`
  (documented, stable until the next full report).

## Tests (`usage-math.test.ts`, vitest, node env)

Every function, including: the verified real totals (build samples whose sums are input 152,
output 170,749, reasoning 109,213, cacheRead 20,483,274, cacheWrite 1,811,581, cost 18.7544 →
inflow 22,295,007, outflow 279,962, cacheHitRate ≈ 0.91873, cost exact to 1e-9); cost null /
NaN handling (`costedCalls`); `ratesOf` window edges; `chooseBucketMs` for 15 m / 1 h / 24 h /
7 d spans; `bucketize` alignment + empty buckets; `addToSeries` ≡ `bucketize` on random data
(property-style loop with a seeded PRNG); `breakdown` ordering/shares/labels; `buildSankey`
structure (node/link ids, Other merge, zero omission, non-conservation in the middle);
`addToSankey` ≡ `buildSankey` when membership is stable; `insertSorted` replace-by-id;
`percentile`/`ttftStats`; `throughputTps`; `estimateTokensFromChars`.

## Acceptance & verify

```bash
npx tsc -p tsconfig.server.json --noEmit 2>&1 | grep usage-math   # nothing
npx tsc -p tsconfig.client.json 2>&1 | grep usage-math              # nothing
npx vitest run src/shared/usage-math.test.ts                        # green
```

## Report

Summary, files, test results, any API refinements (additive only) other tasks must know.
