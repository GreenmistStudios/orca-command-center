# Task-25 — DAG token-flow overlay

**Feature:** Token Flow · **Wave:** E3 (parallel with 24, 26, 27) · **Size:** M · **Depends on:** 21, 22

## Goal

Make token flow visible on the agent DAG: bidirectional animated edges (context flowing down to
subagents, generated tokens flowing back up), in/out rings and cost tickers on nodes, pulses on
completed calls, and a workflow totals pill.

## Read first

- `features/token-flow/Plan.md` §5.2 (normative), §6
- `docs/design-system.md` §15.3 "DAG overlay", §10.2–10.4
- Kit `src/client/ui/flow/index.ts`; data `SessionSummary.usage` (tree/rates/inFlight),
  `src/client/state/usage-live.ts` (`useUsageBurst`), store `ui.tokens.overlay` + `setTokensPrefs`
- The DAG view: `src/client/views/dag/**` (nodes, layout, model, tests)

## Ownership

`src/client/views/dag/**` only.

## Requirements

1. **Toggle**: float pill "Token flow" (icon `coins`) bound to `ui.tokens.overlay` (default on);
   off → the DAG looks exactly as before (no extra DOM/animation).
2. **Edges** (agent-tree mode): custom edge component drawing the existing bezier plus up to two
   particle streams via SVG `<circle><animateMotion path=… dur=… repeatCount="indefinite"/></circle>`:
   cyan (`--flow-input`) parent → child at the child's `usage.rates.inflowPerMin`, emerald
   (`--flow-output`) child → parent at its `outflowPerMin`. Dot count 0–4 and `dur` 0.8–3 s by
   log-mapped rate; no dots when the child isn't live. When a call completes for the child
   (`useUsageBurst`), emit a short burst (2–3 extra dots for 1.5 s). Reduced motion → static
   dual-tone edge stroke only.
3. **Nodes**: in/out ring (two arcs at `inset:-6px`; length ∝ node's share of the workflow's
   inflow/outflow, from `usage` vs root `usage.tree`), cost ticker (`Odometer` format cost) in
   row 3 replacing the counters text when usage exists (keep current activity when live:
   "▸ bash · npm test · $1.42"), pulse ring + delta chip on each completed call; in-flight calls
   show a thin `InFlightMeter` shimmer under the title.
4. **Workflow pill** (top-center float pill, replaces the caption while the overlay is on): root
   `usage.tree` → odometers inflow · outflow · cost (+ disclaimer) and burn (Σ live rates) — click
   → switch to the Tokens view with workflow scope (`setTokensPrefs({ scope: 'workflow' })` +
   `setView('tokens')`).
5. **Orchestration mode**: tasks with a linked assignee session show that session's cost ticker;
   no particles.
6. **Performance**: memoized node/edge data; overlay updates ride `sessions` updates (≤ 2 Hz per
   session) — no per-frame React state; ≤ 300 nodes smooth.

## Tests

Overlay toggle on/off (DOM diff), edge particle counts/duration mapping for rates, no particles
for idle/non-live children, burst on usageBus sample, ring arc lengths from shares, cost ticker
text, workflow pill values + click → view switch, reduced-motion static edges.

## Verify

```bash
npx tsc -p tsconfig.client.json 2>&1 | grep views/dag
npx tsc -p tsconfig.test.json 2>&1 | grep views/dag
npx vitest run src/client/views/dag
```

## Report

Summary, files, tests, deviations.
