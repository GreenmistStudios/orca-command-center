# Task-20 — Fleet view UI

**Wave:** E2 · **Size:** L · **Depends on:** 18, 19

## Goal

Replace the Task-19 stub with the live fleet DAG: the toolbar, the React Flow canvas and the custom
nodes, built on `buildFleetGraph` (Task-18).

## Read first

- `docs/fleet-dashboard-plan.md`
- `src/client/views/fleet/model.ts` (the API from Task-18)
- `src/client/views/dag/{DagView,nodes,layout}.tsx?` (copy their React Flow patterns: provider, the
  layout-on-structureKey effect, fitView, Controls/MiniMap, and the theme `.react-flow` overrides)
- `src/client/ui/**` (`StateDot`, `HarnessTile`, `Panel`, `Segmented`, `Button`, `EmptyState`) and `ui/tones.ts`
- `docs/design-system.md` (tokens, agent stripe, status palette)
- `src/client/state/store.ts` (sessions, `orca.worktrees`, `orchestration.runs`, `attention`, `meta.windowMs`,
  `ui.harnessFilter`, `selectSession`, `selectRun`, `setView`, `ui.dagDirection`)
- `src/client/api/mock-data.ts` (what `?mock=1` provides)

## Ownership (create/modify only these)

- `src/client/views/fleet/FleetView.tsx`, `nodes.tsx` and `FleetView.test.tsx` (new)
- `src/client/api/mock-data.ts`: additive only, and only if the mock lacks multiple projects, worktrees or runs
- `test/e2e/console.spec.ts`: add one mock-project spec for Fleet

## Requirements

1. **`FleetView({ layout = elkLayout })`** is wrapped in a `ReactFlowProvider` and has `data-testid="fleet-view"`.
   It reads the store with narrow selectors and builds the graph inside `useMemo`.
   - `now` comes from a 15 s clock, so "active" pruning ages out; reuse `views/timeline/useClock` if it suits.
   - Layout re-runs only when `structureKey` changes. Data-only updates patch the node `data` without
     re-laying out. Call fitView on the first layout and when the Fit button is pressed.
2. **Toolbar**, using a sticky `.panel-header`:
   - Segmented scope: Active and All, stored in local state that is persisted in `localStorage['occ.fleet.scope']`.
   - A harness select bound to `ui.harnessFilter`.
   - A summary pulse, for example `4 projects · 7 worktrees · 3 working · 1 needs you · 2 runs`.
   - Buttons for collapse-all/expand-all, direction, and Fit.
3. **Nodes** (`nodes.tsx`, memoized, with Handles on the correct sides for the direction):
   - **Project:** a larger card with the name, a rolled-up `StateDot`, and count chips.
   - **Worktree:** the branch (mono font), display name, terminal count, relative last activity, and a rollup dot.
   - **Session:** an agent stripe, `HarnessTile`, title, agent/model, `StateDot` with a pulse while working,
     a "N subagents (M working)" line, and cost.
   - **Run:** the objective (2-line clamp), a stacked status bar from `statusCounts` using `orchStatusTone`,
     and a gate badge.
   - **Overflow:** "+N idle sessions".
   - Any node with `needsYou` gets an attention ring. Selected nodes (matching `selectedSessionId` or
     `selectedRunId`) are highlighted.
   - Each node has `data-testid="fleet-node-<kind>"` and `aria-label`s.
4. **Interaction:**
   - Clicking a session calls `selectSession(id)`. Double-clicking it, or pressing its "Open tree" icon
     button, selects the session as root and calls `setView('dag')`.
   - Clicking a run calls `selectRun`; double-clicking opens the Run DAG.
   - Clicking a project or worktree toggles collapse.
   - Keyboard: nodes are focusable and Enter does the same as click.
5. **Edges:** smoothstep edges. The `coordinates` edge is dashed. Edges into working nodes are animated.
6. **Empty and loading states:** show "Loading…" until bootstrapped. Show "Nothing running" with a
   "Show all" button when scope=active produces an empty graph.
7. Keep the view's chunk small. ELK stays lazy through `elkLayout`.

## Tests

Use a fake synchronous `layout` prop and seeded store state (follow `DagView.test.tsx` / `test/client/render.tsx`). Tests should cover:
- the expected node kinds rendering
- Active/All toggling
- collapse on project click
- session click calling `selectSession`
- double-click switching the view to `dag`
- the empty state with "Show all"

E2E (mock): the app lands on Fleet, at least one project node and one session node are visible,
and double-clicking a session shows the DAG view.

## Verify

```bash
npm run typecheck && npm test && npm run build
npx playwright test --project=mock -g Fleet   # if Chrome is available; report if not
```

## Report

Summary, files, commands and results, deviations, and screenshots via a Playwright snapshot if you took any.
