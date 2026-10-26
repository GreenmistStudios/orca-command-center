# Task-28 — Verification: reconciliation, e2e, animation performance, docs

**Feature:** Token Flow · **Wave:** E4 · **Size:** M · **Depends on:** 18–27

## Goal

Prove token flow is **accurate** (ledger totals reconcile exactly with harness totals on real
data), **smooth** (animation performance budgets in a real browser), **safe** (no transcript
text or Copilot request bodies in usage payloads) and **documented**.

## Read first

- `features/token-flow/Plan.md` §2 (goals), §9 (NFRs — budgets), §10 (testing)
- Existing scripts `scripts/{_lib,smoke,perf,safety-audit}.mjs`, `playwright.config.ts`,
  `test/e2e/console.spec.ts`, `README.md`
- Kit frame stats: `window.__occFrameStats` (enabled with `?perf=1`, Task-21)

## Ownership

`scripts/**`, `test/e2e/**`, `README.md`. Small fixes elsewhere only if ≤ 20 lines and clearly
local — list each (file, reason); otherwise report.

## Requirements

1. **`scripts/usage-reconcile.mjs`** (Node, no deps; `--port 4280`): for every OpenCode session in
   `/api/sessions` (window): `/api/usage?scope=session&id=` totals vs the session's
   `tokens`/`cost` → exact token equality, cost within 1e-6; for each root with children:
   workflow totals == Σ of its sessions' totals; fleet window totals ≤ Σ sessions; Copilot
   sessions: calls ≥ 0 and `cost` null-aware (`costedCalls` 0). Print a table of mismatches and
   PASS/FAIL per check; exit non-zero on failure.
2. **Smoke/perf/audit updates**: smoke adds `/api/usage` (each scope) and `/api/usage/calls`
   shape + latency checks and counts `usage` SSE frames; perf adds warm/cold workflow report
   latency (≤ 50 ms warm) and confirms first-bootstrap ≤ 1.5 s still holds with background
   seeding; safety audit scans usage payloads for any string longer than 200 chars, secrets,
   and the words `requestMessages` / `responseChunk` / `quotaSnapshots`.
3. **E2E** (extend `test/e2e/console.spec.ts`, both projects): Tokens view renders KPI tiles with
   non-empty values, Sankey (≥ 3 labelled nodes + hidden table), stream chart, leaderboard;
   switching Units/Scope/Window works; DAG overlay toggle shows/hides edge particles; Inspector
   Usage tab renders calls; header burn pill opens the Tokens view; **reduced motion**
   (`page.emulateMedia({ reducedMotion: 'reduce' })`) → no particle canvas animation
   (`data-animating="false"` on engines) and counters render final values; save aria snapshots of
   the Tokens view.
4. **Animation performance probe** (mock project, `?mock=1&perf=1`, Tokens view, 6 s with live
   mock traffic): median fps from `window.__occFrameStats` ≥ 55 (headless may be lower — record
   and gate at ≥ 45 if headless caps; explain), `PerformanceObserver('longtask')` → none > 50 ms
   after the first 1 s, JS heap growth < 20 MB over the window.
5. **README**: "Token Flow" section — what's measured (definitions: call, inflow/outflow, cache
   hit, burn, estimated vs metered), the list-price cost disclaimer and Copilot AI units, where
   it appears (Tokens view, DAG overlay, Usage tab, rail, header, overview), keyboard `6`,
   reconciliation command, and limitations.

## Verify

```bash
npm run build && node bin/occ.mjs --no-open --port 4280 &   # then:
node scripts/usage-reconcile.mjs --port 4280
npm run smoke && npm run audit && npm run perf
npx playwright test -c playwright.config.ts
```
Stop all servers you start; leave ports 4280/4281 free.

## Report

Summary; reconcile table + verdict; smoke/perf/audit outputs; Playwright results incl. perf
probe numbers; small fixes applied; remaining issues ranked by severity.
