# Task-13 — Timeline view

**Wave:** C (parallel with 8–12, 14–16) · **Size:** L · **Depends on:** Task-7

## Goal

Show *when* each agent in the selected tree worked and how subagents overlapped: one lane per
session, a span bar for its lifetime, and activity blocks (tool calls, thinking, MCP, edits)
colored by kind, with zoom/pan and a live "now" edge. Answers "where did the time go?" and
"how parallel was this?".

## Read first

- `docs/design-system.md` §7.3 (kind colors), §10.6 (timeline — normative), §12
- `Plan.md` §6 (F7), §7.3
- Task-7 code: store (`trees`/`fetchTree`, `scopedActivity`/`fetchScopedActivity`,
  `sessions`, `selectActivity`, `selectSession`), `ui/**`, `lib/format.ts`

## Ownership

`src/client/views/timeline/**` (replace the placeholder; keep `export function TimelineView()`),
with co-located tests.

## Requirements

1. **Scope:** the selected root's tree (`fetchTree`) + its activity
   (`fetchScopedActivity({ rootId }, { kinds: ['thinking','tool','mcp','file-change','subagent','prompt','error','state','permission'] })`,
   load more pages until ≤ 5000 events or the root's `createdAt`), merged with live ring events
   for the tree. Run mode (a run selected): lanes per task dispatch attempt (orca-viz timeline
   semantics: bars from `dispatchedAt` to `completedAt`/now) using `fetchRun`.
2. **Lanes:** root first, then descendants in spawn order, indented by depth (gutter 160 px:
   monogram + agent + truncated title; click → `selectSession`). Session span bar (createdAt →
   lastActivityAt, or → now while live with a fade-out mask) in the state tone.
3. **Blocks:** activities with `endTs` render as bars (min width 3 px); instantaneous items as
   6 px ticks; colored by `kindColorVar`; errors outlined red; running items extend to now and
   pulse. Overlapping blocks in a lane stack into sub-rows (max 3, then merge). Spawn connectors:
   dashed `3 2` vertical line from the parent's `subagent` block to the child's lane start.
4. **Axis & navigation:** time axis with adaptive ticks (seconds/minutes/hours), a "now" line in
   `--selection`; zoom buttons + presets (5m · 15m · 1h · All) + ctrl/⌘-wheel zoom around the
   cursor; drag or shift-wheel to pan; "Live" toggle keeps now at the right edge while any lane
   is live.
5. **Hover/click:** tooltip with kind, title, duration, session; click → `selectActivity(id)` +
   `selectSession(sessionId, { activityId })`. The selected activity is outlined.
6. **Rendering:** absolutely positioned divs or SVG in a scroll container; virtualize lanes when
   > 40; recompute geometry with `useMemo` keyed on data version + viewport; 60 fps pan/zoom for
   5000 blocks (canvas fallback allowed if needed — document it).
7. **Empty states:** no selection; no activity yet; loading.

## Tests

Pure geometry functions (time→x scale, tick generation, sub-row packing, lane ordering by spawn,
live extension) unit-tested; component test renders lanes for the mock tree and selects an
activity on click.

## Acceptance

`?mock=1`: the working root shows overlapping subagent lanes, colored blocks, live extension,
zoom presets and pan; clicking a block opens it in the inspector. Tests green
(`npx vitest run src/client/views/timeline`), typecheck clean for owned files.

## Report

Summary, files, tests + results, deviations.
