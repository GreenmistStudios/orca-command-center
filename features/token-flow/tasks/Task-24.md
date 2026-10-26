# Task-24 — Tokens view

**Feature:** Token Flow · **Wave:** E3 (parallel with 25, 26, 27) · **Size:** XL · **Depends on:** 21, 22

## Goal

The flagship surface: an interactive, animated view of token inflow/outflow, cost, burn rate,
cache efficiency and yield for the fleet, a workflow, a session or an orchestration run — live.

## Read first

- `features/token-flow/Plan.md` §5.1 (layout & behavior — normative), §5.5, §6, §9
- `docs/design-system.md` §15 (normative), §6, §10
- Kit: `src/client/ui/flow/index.ts` (Task-21) — `Odometer`, `KpiTile`, `DeltaChips`,
  `RadialGauge`, `AnimatedBarList`, `InFlightMeter`, `CostDisclaimer`, `FlowLegend`,
  `SankeyChart`, `MirroredStreamChart`, `Sparkline`, `subscribeFrame`, `useFlowMotion`
- Data: `src/client/state/usage-live.ts` (`useLiveUsage`, `useUsageBurst`, `sampleInScope`),
  `src/client/state/selectors.ts` (`selectAutoUsageScope`, …), store `ui.tokens` +
  `setTokensPrefs`, `fetchUsageCalls`/`usageCalls`, `selectSession`, `selectRun`
- Shared math `src/shared/usage-math.ts` (`ttftStats`, `throughputTps`, `ratesOf`, …)

## Ownership

`src/client/views/tokens/**` (replace the placeholder; keep `export function TokensView()`), with
co-located tests. No edits elsewhere.

## Requirements

1. **Scope bar** (`.panel-header`): Segmented scope Fleet · Workflow · Session · Run (auto
   default from `selectAutoUsageScope`; options disabled without a selection; labels show the
   workflow/session/run title truncated), window Segmented 15m · 1h · 24h · All (fleet default
   24h; others All), Units Tokens|Cost, Scale Balanced|Linear, Middle Agents|Sessions|Models,
   a Live indicator (LiveDot when samples arrived in the last 60 s), CSV export button, and the
   cost disclaimer when cost is shown. All prefs persisted via `setTokensPrefs`.
2. **KPI ribbon** (6 `KpiTile`s, responsive wrap): Inflow (fresh · cache read · cache write
   breakdown with flow dots), Outflow (output · reasoning; `InFlightMeter` when calls are in
   flight), Cost (list price + disclaimer; "not reported" when `costedCalls` = 0; AIU line when
   > 0), Burn ($/h + tokens/min, `Sparkline` from the series), Cache hit (`RadialGauge`), Calls
   (count + TTFT p50 + median tokens/s). Delta chips on Inflow/Outflow/Cost fed by
   `useUsageBurst`.
3. **Flow** — `SankeyChart` with `rates` = per-link EWMA (τ 8 s) of in-scope samples (computed
   in a ref, not state) and bursts on each in-scope sample; clicking a middle node selects the
   session (middle = sessions) or filters the leaderboard (agents/models); selected node outlined.
4. **Leaderboard** — `AnimatedBarList` with tabs Agents · Models · Sessions (from the report's
   breakdowns), values by Units, split bars (inflow vs outflow, or cost), share %, click →
   select session (sessions tab).
5. **Stream** — `MirroredStreamChart` of `report.series`, `domain='live'` while the window is
   rolling (fleet/time windows) else the scope span; call markers; brush → narrows the view
   window (shows a "Reset zoom" chip).
6. **Calls ledger** (toggle `showCalls`): virtualized table (`@tanstack/react-virtual`) of
   `usageCalls` pages + live samples (time, session (click → select), agent monogram, model,
   fresh in, cache read, cache write, out, reasoning, cost, TTFT, tok/s), in-flight rows on top
   with `InFlightMeter`, "Load older" paging, new rows animate in (`y:-6`, opacity).
7. **Yield** (workflow/session): files changed, files touched, +/− lines, artifacts, PRs, and
   `$ / file changed` / `tokens / +line` when computable; click → Changes view.
8. **Coverage & states**: coverage notes as a muted list; loading skeleton (shimmer KPI tiles);
   error with retry; empty ("No metered calls in this scope yet."); run with no linked sessions.
9. **CSV export**: client-side CSV of all loaded calls for the scope (fetch remaining pages up
   to 10,000 first; RFC 4180 quoting) named `occ-usage-<scope>-<id>-<date>.csv`.
10. **A11y & motion**: tiles are labelled regions; charts have text summaries; keyboard access to
    every control; reduced motion handled by the kit.
11. **Performance**: the view never re-renders per animation frame; `useLiveUsage` updates ≤ 4 Hz;
    leaderboard/table memoized; verify with React Profiler in a test (render count bound for 50
    live samples).

## Tests

With the mock store/backend (`?mock=1` semantics): renders all sections for fleet and workflow
scopes; scope/window/units/middle switching refetches the right report keys; live sample →
KPI value increases and a delta chip appears; sankey node click selects a session; leaderboard
tab switch; brush sets a zoom chip; calls ledger paging; CSV content (headers, quoting, rows);
empty/run-without-sessions/error states; render-count bound.

## Verify

```bash
npx tsc -p tsconfig.client.json 2>&1 | grep views/tokens
npx tsc -p tsconfig.test.json 2>&1 | grep views/tokens
npx vitest run src/client/views/tokens
npx vite build --outDir "$TMPDIR/occ-task-24" --emptyOutDir
```

## Report

Summary, files, tests, deviations, screenshots are NOT possible — describe the rendered layout.
