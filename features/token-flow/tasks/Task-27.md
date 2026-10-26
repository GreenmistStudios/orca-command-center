# Task-27 — Rail, header, overview & palette integration

**Feature:** Token Flow · **Wave:** E3 (parallel with 24, 25, 26) · **Size:** M · **Depends on:** 21, 22

## Goal

Put token flow where people glance: live cost tickers and in/out bars in the fleet rail, a
burn-rate pill in the header, window-bounded token KPIs in Overview, and palette entries.

## Read first

- `features/token-flow/Plan.md` §5.4 (normative), §3 (fleet usage is time-windowed), §6
- `docs/design-system.md` §15.3 (burn pill, odometer), §8.1 (header), §9 (rail)
- Kit `src/client/ui/flow/index.ts`; data: `SessionSummary.usage`, `FleetStats.usage`,
  `selectFleetBurn`, `selectDescendants`, store `setView`, `setTokensPrefs`
- Code: `src/client/rail/**`, `src/client/shell/Header.tsx`, `src/client/views/overview/**`,
  `src/client/palette/**`

## Ownership

`src/client/rail/**`, `src/client/shell/Header.tsx`, `src/client/views/overview/**`,
`src/client/palette/**` (+ their tests). Nothing else.

## Requirements

1. **Rail root rows**: replace the static cost in the meta line with an `Odometer` (format cost)
   of `usage.tree.cost` (fallback: session `cost`), add a 3px micro bar (inflow vs outflow share,
   flow colors) under line 3, and an in-flight shimmer when the root or any descendant has
   `usage.inFlight`. Cast rows show their own cost ticker on hover/selected only (keep the rail
   calm).
2. **Header burn pill** (between fleet pulse and source chips): `flame` + "$3.40/h · 42k tok/min"
   from `selectFleetBurn`; glows while any call is in flight; neutral "No token burn" when zero;
   tooltip explains the 5-min window and the list-price disclaimer; click →
   `setTokensPrefs({ scope: 'fleet' })` + `setView('tokens')`. Compact layout: inside the
   Sources popover.
3. **Overview**: Tokens and Cost KPI tiles switch to `stats.usage.totals` (consumed inside the
   window) with `Odometer`s and a sub-line "lifetime of sessions active in window: …" (the old
   numbers); add a "View token flow →" link; histogram unchanged.
4. **Palette**: "Tokens" appears with the other views (if views are listed from `VIEW_ORDER`
   make sure the label/icon render); add actions "Token usage for this workflow" (when a
   session is selected) and "Fleet token usage".
5. Reduced motion and accessibility per the kit; no per-frame React state.

## Tests

Rail ticker value & micro bar from mock usage, in-flight shimmer presence, header burn pill
values/click/neutral state, Overview tiles use window usage (assert both numbers), palette
entries and actions.

## Verify

```bash
npx tsc -p tsconfig.client.json 2>&1 | grep -E "src/client/(rail|shell/Header|views/overview|palette)"
npx tsc -p tsconfig.test.json 2>&1 | grep -E "src/client/(rail|shell|views/overview|palette)"
npx vitest run src/client/rail src/client/shell src/client/views/overview src/client/palette
```

## Report

Summary, files, tests, deviations.
