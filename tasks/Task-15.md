# Task-15 — Overview, scoreboard & attention

**Wave:** C (parallel with 8–14, 16) · **Size:** M · **Depends on:** Task-7

## Goal

1. **Overview view** — fleet-level numbers: what's live, how much work happened, which tools and
   MCP servers are used (and failing), which models/agents cost what, and a scoreboard of root
   sessions.
2. **Attention** — the strip above the canvas and the dock panel that list everything needing a
   human (permission, question, gate, error, stalled, failed task).

## Read first

- `docs/design-system.md` §6, §8.3 (attention strip — normative), §3 (tones), §12
- `Plan.md` §6 (F9, F10), §7.5 (attention copy), §9.3, §9.5
- Task-7 code: store (`stats`, `attention`, `sessions`, `orchestration`, `selectSession`,
  `selectRun`, `selectTask`, `setView`, `setStreamFilters`), selectors, `ui/**`

## Ownership

`src/client/views/overview/**` (replace the placeholder; keep `export function OverviewView()`),
`src/client/attention/**` (replace both placeholders; keep `export function AttentionStrip()`
and `export function AttentionPanel()`), with co-located tests.

## Requirements

### A. Overview view

- **KPI tiles** (row of 6, `.panel`-style cards on `bg-panel-solid`): Live agents (working ·
  needs you · idle breakdown), Tool calls (with error count), MCP calls (servers count), Files
  changed, Tokens (input/output split tooltip), Cost. Values from `stats`; small sparkline from
  `histogram` where meaningful.
- **Activity histogram** (last 60 min): SVG stacked bars per minute (thinking, tools, mcp,
  edits, errors in kind colors), hover tooltip per bucket, legend, time axis labels.
- **Tables** (compact, 12px, sticky headers like orca-viz report): by harness (sessions, live,
  cost), by model (sessions, tokens, cost), by agent (sessions, cost), top tools (name with
  `ToolBadge`, calls, errors, error rate bar), MCP servers (server, tools, calls, errors).
  Clicking a tool or MCP server → `setStreamFilters({ query: <name>, scope: 'all' })` +
  `setView('stream')`.
- **Scoreboard** of root sessions in the window: state dot, title, workspace, harness, agent,
  elapsed, subagents, tools, errors, files, tokens, cost; sortable columns (default: live first,
  then cost desc); row click → `selectSession`.
- Window label ("Last 24 h") from `meta.windowMs`; empty/loading states.

### B. Attention

- `AttentionStrip` (design-system §8.3): only when `attention.length > 0`; high severity first;
  max 3 rows visible + "+N more" (opens the panel by clearing selection, i.e. dock shows
  `AttentionPanel`); each row: kind icon (`shield-alert` permission, `message-circle-question`
  question, `octagon-alert` gate, `circle-x` error, `hourglass` stalled, `triangle-alert`
  failed-task), title, detail, age (`RelativeTime`), "Open" chip → select the session (or run
  + task). Drifting gate-colored blobs; respects reduced motion. Dismiss is **not** offered
  (attention is derived; it clears when resolved).
- `AttentionPanel` (dock when nothing is selected): section "NEEDS YOU" with the full list
  grouped by severity, then "LIVE NOW": working sessions with current activity (click →
  select), then a short "Recently finished" list (done in the last 30 min). Empty state:
  "Nothing needs you right now." with a calm check icon.
- New high-severity items briefly pulse (`orca-pulse`) when they appear.

## Tests

KPI values from a fixture `FleetStats`, histogram bar heights, table sorting, scoreboard
selection, tool click sets stream filters and view; attention strip visibility, ordering,
"+N more", open actions per kind (session vs run/task), panel sections and empty state.

## Acceptance

`?mock=1`: Overview shows plausible KPIs/histogram/tables and a sortable scoreboard; the
attention strip shows the blocked/waiting/gate/error items and opens the right targets; the dock
shows the Attention panel when nothing is selected. Tests green
(`npx vitest run src/client/views/overview src/client/attention`), typecheck clean for owned files.

## Report

Summary, files, tests + results, deviations.
