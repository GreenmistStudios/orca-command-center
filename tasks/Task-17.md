# Task-17 — E2E on real data, performance, docs, packaging

**Wave:** D (after all others) · **Size:** M · **Depends on:** Tasks 1–16

## Goal

Prove the whole console works on **this machine's real data** (read-only), meets the
performance budgets, and is documented and packaged so `npm run build && npm start` (or
`npx occ`) just works.

## Read first

- `Plan.md` §3 (goals), §6 (acceptance per feature), §11 (budgets), §12 (testing)
- `docs/data-sources.md` §0 (safety)
- `README.md`, `package.json`, `bin/occ.mjs`, `src/server/main.ts`

## Ownership

`test/e2e/**`, `scripts/**`, `README.md` (final), `playwright.config.ts` (new). You may fix
small integration bugs you find anywhere **only** if the fix is ≤ 20 lines and clearly local;
list every such fix with file and reason. Larger issues → report them (do not refactor).

## Requirements

1. **Build & start:** `npm run build` clean; `node bin/occ.mjs --no-open --port 4280` against the
   real defaults (OpenCode DB, Copilot dir, Orca hooks, Orca CLI, orchestration DB).
2. **API smoke script** `scripts/smoke.mjs` (Node, no deps): waits for the server, fetches
   `/api/meta`, `/api/bootstrap` (records size + latency), a tree for the most active root, a
   transcript page, `/api/activity?limit=200`, `/api/stats`, `/api/orchestration`; checks
   shapes against the contract (key presence), prints a compact report; reads `/api/stream` for
   15 s and counts frames by type. Exit non-zero on failure.
3. **Playwright E2E** (`playwright.config.ts`, `test/e2e/console.spec.ts`) using the
   **installed Google Chrome** (`channel: 'chrome'`, headless) — do not download browsers.
   Against the real running server: page loads, splash disappears, the stream pill reaches
   "Live", the header shows the Orca pid, the rail lists ≥ 1 session, the DAG renders ≥ 1 node,
   selecting a session shows the inspector header and at least one transcript item, every view
   tab renders without an error boundary, ⌘K opens the palette, no `console.error`. Capture
   **accessibility snapshots** (`page.accessibility.snapshot()` or `locator.ariaSnapshot()`) of
   header, rail, view, and dock into `test-results/` (no OS-level screenshots). Also run the
   same spec against `?mock=1` (deterministic) as a second project.
4. **Performance** `scripts/perf.mjs`: start the server as a child process, measure time to
   first successful `/api/bootstrap`, bootstrap payload size, RSS after 60 s, and CPU% over a
   30 s idle window (`process.cpuUsage` of the child via `ps`), plus SSE latency: time from a
   change in the OpenCode DB (observe the next `activity` frame while agents are working) — if
   no agent is active, report "not measured". Compare with Plan §11 budgets and print PASS/FAIL
   per budget.
5. **Safety audit** `scripts/safety-audit.mjs`: fetch bootstrap + a sample of part details,
   diffs and transcripts; scan for secret patterns (reuse `src/server/lib/redact.ts` patterns
   via the built `dist/server/lib/redact.js`) and `data:` URLs; scan the server source for SQL
   mentioning denied tables (`account`, `control_account`, `credential`) and for `orca` CLI
   invocations outside the allowlist; confirm the server only listens on loopback. PASS/FAIL.
6. **README.md (final):** what it is (one paragraph + the 4-beat loop), screenshot-free
   description of the layout, quick start (`npm install && npm run build && npm start`, `npm run
   dev` + `?mock=1`), flags table (from `occ --help`), data sources and exactly what is read
   (and never read), safety model (read-only, loopback, Host check, redaction), views & keyboard
   shortcuts, troubleshooting (Orca not running, source missing, schema newer, port in use), and
   architecture overview linking Plan.md and docs.
7. **Package check:** `npm pack --dry-run` lists only `bin/`, `dist/`, `package.json`,
   `README.md`, `LICENSE` (add an MIT `LICENSE` if absent — note it in the report).

## Acceptance

All scripts PASS (or each FAIL explained with numbers and a proposed fix), Playwright green on
both projects, README complete, `npm test` and `npm run typecheck` still green.

## Report

Summary; smoke/perf/safety outputs; Playwright results and the paths of accessibility
snapshots; list of small fixes applied (file, reason); remaining issues ranked by severity.
