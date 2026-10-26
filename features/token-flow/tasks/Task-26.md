# Task-26 — Inspector Usage tab

**Feature:** Token Flow · **Wave:** E3 (parallel with 24, 25, 27) · **Size:** M · **Depends on:** 21, 22

## Goal

A per-session **Usage** tab in the inspector: what this agent (and, for roots, its whole
workflow) consumed and produced, how its context grew call by call, and a live per-call ledger.

## Read first

- `features/token-flow/Plan.md` §5.3 (normative), §3 (definitions), §6
- `docs/design-system.md` §15, §11 (dock)
- Kit `src/client/ui/flow/index.ts`; data `useLiveUsage` (`scope: { kind: 'session' | 'workflow', id }`),
  `useUsageBurst`, `SessionSummary.usage`; math `src/shared/usage-math.ts`
- Inspector: `src/client/inspector/**` (tabs, `SessionInspector.tsx`, `common.tsx`, tests)

## Ownership

`src/client/inspector/**` only.

## Requirements

1. **Tab**: add "Usage" to the session inspector tabs (after Activity; label shows the session's
   cost or tokens compactly, e.g. "Usage · $1.42"); remembered like other tabs.
2. **Header KPIs** (compact `KpiTile` variant, 2×3 grid): inflow, outflow, cost (+ disclaimer /
   AIU), cache hit (`RadialGauge` small), calls, TTFT p50 · tok/s. Segmented "This agent ·
   Workflow" on roots (workflow uses the workflow scope).
3. **Context growth chart** (SVG, full width, 120px): one point per call = inflow (context size),
   stacked fresh vs cache read vs cache write; outflow as bars below; compaction drops (inflow
   falls > 40% from the previous call) annotated with a marker + tooltip "Context compacted";
   hover tooltip per call; click → highlights the call row.
4. **Cumulative cost sparkline** (with list-price disclaimer) and a burn-rate line for live
   sessions.
5. **Calls table**: virtualized rows (time, model, fresh in, cache read, cache write, out,
   reasoning, cost, TTFT, duration, tok/s, finish) — newest at the bottom, auto-follow while live,
   in-flight row with `InFlightMeter`, new rows animate in; "Load older" via `fetchUsageCalls`.
6. **Workflow breakdown** (roots, Workflow segment): `AnimatedBarList` of subagents by tokens or
   cost (toggle), click → select that session.
7. **Empty/coverage states**: "No metered calls for this session yet." · Copilot sessions before
   usage events · loading skeleton · error with retry.
8. Performance: updates ≤ 4 Hz (from `useLiveUsage`), no per-frame React state.

## Tests

Tab appears with label, KPIs from a mock session, context chart points & compaction marker for a
synthetic drop, calls table live append + in-flight row, workflow segment bars & selection,
empty/coverage states.

## Verify

```bash
npx tsc -p tsconfig.client.json 2>&1 | grep src/client/inspector
npx tsc -p tsconfig.test.json 2>&1 | grep src/client/inspector
npx vitest run src/client/inspector
```

## Report

Summary, files, tests, deviations.
