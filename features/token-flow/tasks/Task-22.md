# Task-22 — Client usage state, live merge, mock & view registration

**Feature:** Token Flow · **Wave:** E2 (parallel with 23) · **Size:** L · **Depends on:** 18 · **Blocks:** 24–27

## Goal

Everything the token-flow UI needs from the client data layer: a usage slice fed by the `usage`
stream, a non-React event bus for animations, a `useLiveUsage(scope)` hook that merges a fetched
report with live samples using the shared math, realistic mock usage (`?mock=1`), and the new
**Tokens** view registered as the 6th view (placeholder body for Task-24).

## Read first

- `features/token-flow/Plan.md` §5, §7 (live merge protocol — normative), §8
- Contract: token-flow section, `StreamEvent` `usage`, `ApiResponses` `/api/usage*`,
  `SessionSummary.usage`, `FleetStats.usage`
- `src/shared/usage-math.ts` (Task-18 — use it; don't reimplement math)
- Client data layer: `src/client/state/{store,selectors,url}.ts`, `src/client/api/{client,sse,mock,mock-data,types}.ts`,
  `src/client/shell/{ViewTabs,CenterView}.tsx`, `src/client/hooks/useGlobalHotkeys.ts`, tests

## Ownership

`src/client/state/**`, `src/client/api/**`, `src/client/shell/ViewTabs.tsx`,
`src/client/shell/CenterView.tsx`, `src/client/hooks/useGlobalHotkeys.ts`,
`src/client/views/tokens/TokensView.tsx` (placeholder only), `test/client/**`.

## Requirements

### A. Store (`state/store.ts`)

- `ViewId` gains `'tokens'`.
- Slice `usage: { samples: { byId: Record<string, UsageSample>; order: string[] /* compareSamples */; version: number }; estimates: Record<string, UsageEstimate> }`
  — ring cap 50,000 (drop oldest); upsert keeps the higher `ledgerSeq` (equal → replace).
- Caches `usageReports: Record<string, Loadable<UsageReport>>` (key
  `${kind}:${id ?? ''}:${windowMs ?? 'all'}:${middle ?? ''}`), `usageCalls: Record<string, Loadable<UsageCallsPage>>`.
- `ui.tokens: { scope: 'auto' | UsageScopeKind; windowMs: number | null; units: 'tokens' | 'cost'; middle: 'agent' | 'session' | 'model' | 'auto'; scale: 'balanced' | 'linear'; showCalls: boolean; overlay: boolean }`
  persisted (`occ-tokens`); `setTokensPrefs(partial)`.
- Actions `fetchUsageReport(scope, o?: { windowMs?: number | null; bucketMs?: number; middle?; force?: boolean })`,
  `fetchUsageCalls(scope, o?: { older?: boolean; force?: boolean })` (pages merged).
- `applyStreamEvent` handles `usage`: upsert samples, set/delete estimates (`inFlight:false` →
  delete), bump version, then `usageBus.emit({ samples, estimates })` **after** the state update.
  Resync/bootId reset clears `usage`, `usageReports`, `usageCalls`.

### B. `state/usage-bus.ts`

Tiny synchronous emitter: `usageBus.subscribe(fn) → unsubscribe`, `usageBus.emit(ev)`; errors in
one listener never break others.

### C. `state/usage-live.ts`

- `sampleInScope(sample, scope, ctx: { sessions; orchestration }): boolean` — fleet: always;
  workflow: `sample.rootId === id` (fallback: session's `rootId`); session: `sessionId === id`;
  run: sample's session (or its root) linked to the run (`session.orca.runId === id`).
- `useLiveUsage(scope: UsageScope | null, opts?: { windowMs?: number | null; middle?; bucketMs? }): { report: UsageReport | null; status; error; refresh(): void; lastSampleAt: number | null }`
  - fetches the baseline (`fetchUsageReport`), then subscribes to `usage.samples.version`
    changes; applies in-scope samples with `ledgerSeq > report.ledgerSeq` exactly once (track
    applied ids) to a structural clone using `addSample` / `addToSeries` / `addToBreakdown` /
    `addToSankey`; windowed scopes slide (`trimSeries`, totals reconciled by refetch); rates
    recomputed from the scope's live samples via `ratesOf` (fall back to the report's rates);
    `inFlight` from `usage.estimates` in scope.
  - recompute throttled to ≤ 4 Hz; force refetch every 60 s, on scope/option change, and when
    > 1000 deltas accumulated.
- `useUsageBurst(scope, cb)` — subscribes `usageBus`, filters to scope, calls `cb(sample)` /
  `cb(estimate)` for animations (no React state).

### D. Selectors (`state/selectors.ts`)

`selectAutoUsageScope(s): UsageScope` (selected run → run; selected session → workflow of its
root; else fleet), `selectSessionUsage(s, id)`, `selectFleetBurn(s)` →
`{ costPerHour, tokensPerMin, inFlight: number }` (from `stats.usage.rates`, refined with the
last 5 min of the ring), `selectInFlight(s, scope)`.

### E. Mock (`api/mock*.ts`) — realistic and consistent

- Per mock session, generate metered calls over its lifetime with real-shaped tokens (cache read
  ≫ fresh input; output 1–6k; reasoning 0–4k; cache write occasionally), model-based list
  prices (opus: $15/M in, $75/M out, $1.50/M cache read, $18.75/M cache write; sonnet: $3 / $15 /
  $0.30 / $3.75), TTFT 0.4–2 s, duration 3–40 s; the Copilot mock session reports `aiu` and
  `cost: null`.
- Session summaries carry `usage` (tree totals on roots, rates on live sessions, inFlight),
  `FleetStats.usage` set; `tokens`/`cost` on summaries equal Σ of their samples.
- Routes `GET /api/usage` and `GET /api/usage/calls` implemented with the shared math (so a
  report always equals Σ of the mock's samples); `ledgerSeq` assigned on generation.
- Live: every 0.4 s grow in-flight estimates for working sessions; every 1.5–4 s finish a call
  (sample + estimate end + updated session summary) and start the next.

### F. View registration

`VIEW_ORDER` → `['dag','timeline','stream','changes','overview','tokens']` with label "Tokens"
and lucide `Coins` icon; `CenterView` lazy-loads `views/tokens/TokensView`; hotkey `6`;
placeholder `TokensView` renders an `EmptyState` "Tokens view — Task-24". Keep URL `v=tokens`
working (`state/url.ts`).

## Tests

Store: usage upsert/ledgerSeq/cap/estimate deletion/resync clearing/bus emission order; live
merge: watermark (no double count, no gap), window slide, throttle, scope membership for all
kinds; mock: report totals == Σ samples per scope, live events shape; registration: tab 6
renders, hotkey `6`, URL `v=tokens`. Keep all existing client tests green.

## Verify

```bash
npx tsc -p tsconfig.client.json 2>&1 | grep src/client
npx tsc -p tsconfig.test.json 2>&1 | grep -E "src/client|test/client"
npx vitest run src/client test/client
```

## Report

Summary, files, exact new store/selector/hook API, mock usage description (ids, live cadence),
tests, deviations.
