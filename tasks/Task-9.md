# Task-9 — Fleet rail

**Wave:** C (parallel with 8, 10–16) · **Size:** L · **Depends on:** Task-7

## Goal

The left rail: the fleet of agent sessions grouped by workspace, sorted by urgency, with each
root's live state and current activity, the selected root's subagent "cast", filters, and the
orchestration runs section. It is the primary navigation surface ("glance" + "focus").

## Read first

- `docs/design-system.md` §6 (recipes), §7.1–7.2 (agent colors, harness tiles), §9 (rail — normative), §12 (motion)
- `Plan.md` §7.1–7.2 (selection model), §7.6 (keys handled elsewhere; rail exposes ordering via store selectors)
- The client foundation from Task-7: `src/client/state/{store,selectors}.ts`, `src/client/ui/**`,
  `src/client/lib/format.ts`, `src/client/api/mock.ts` (use `?mock=1` while developing)

## Ownership

`src/client/rail/**` (replace the placeholder `Rail.tsx`; keep `export function Rail()`), with
co-located tests. Do not edit store/selectors/ui; if you need a new selector, implement it
locally in `src/client/rail/` and mention it in the report.

## Requirements

1. **Container:** `<nav aria-label="Fleet">` with the `.panel` recipe, 288 px wide, entering
   `x:-12`; header with section label "FLEET", total root count, search input (bound to
   `railQuery`, `/` focuses it via an exported `focusRailSearch()` helper or a DOM id
   `rail-search` that Task-16 can target), filter row: segmented "All · Live" (`liveOnly`) and
   harness chips (`all` + harnesses present in the data, with monogram tiles).
2. **Workspace groups** from `selectWorkspaceGroups`: collapsible header (chevron, name, branch
   mono, live count, needs-you badge in gate color), collapse state via
   `toggleWorkspaceCollapsed`. Groups with any needs-you/working roots first.
3. **Root session row** (design-system §9 anatomy, all four lines): state dot (LiveDot for
   working), title, harness tile, needs-you icon; mono `agent · shortModel`; meta line with
   `formatDuration(now − createdAt)` (or relative last activity when not live), subagent count
   (`descendantCount`), tool count (`counters?.tools`), cost; live current-activity line in the
   activity kind color (`▸ label · detail`). Hover and selected motion pills (`layoutId`),
   left accent bar for the selected row, cursor spotlight. `aria-current` on the selected row.
   Click → `selectSession(root.id)`.
4. **THE CAST** under the selected root (and only it): every descendant from
   `selectDescendants`, indented by depth, with agent monogram (agent color), agent name,
   `· title` muted, state pill (tone surface) or "last seen 12s ago" pill, current-activity
   tooltip. Click → `selectSession(child.id)` (DAG stays on the root). Highlight the selected
   descendant. Collapse long casts (> 12) with "Show N more".
5. **ORCHESTRATIONS** section (collapsible, below the fleet, only when
   `orchestration.available` and runs exist): orca-viz RunRow anatomy — health dot (active =
   LiveDot if any dispatch is live; silent = amber; finished = grey), objective, mono
   coordinator handle (short), meta "N tasks · N done / N failed", gate icon when
   `hasBlockingGate`. Click → `selectRun(run.id)` and `setView('dag')`.
6. **Empty states:** no sessions in window; nothing live with Live filter on (offer "Show all");
   search with no matches.
7. Performance: the rail re-renders on `sessions` changes only (use narrow selectors /
   `useShallow`); relative times tick via `useNow(10_000)`.
8. Accessibility: rows are buttons with descriptive `aria-label` ("<title>, <state>, <workspace>");
   group headers are buttons with `aria-expanded`.

## Tests

With `renderWithMockStore`: groups and ordering (blocked/waiting before working before done),
filters (Live, harness, query), selecting a root shows its cast, selecting a cast member keeps
the root selected and sets the session, orchestration section renders runs and selects a run,
empty states.

## Acceptance

`?mock=1` shows a rail matching design-system §9 in both themes, live-updating (states, current
activity) as the mock streams; tests green (`npx vitest run src/client/rail`); typecheck clean for
owned files.

## Report

Summary, files, tests + results, any selector added locally, deviations.
