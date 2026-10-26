# Task-10 — DAG view (agent tree + orchestration run)

**Wave:** C (parallel with 8, 9, 11–16) · **Size:** L · **Depends on:** Task-7

## Goal

The default center view. Two modes in one canvas:

1. **Agent tree** (a root session is selected, no run selected): the root and every subagent it
   spawned (recursively) as live session nodes, with spawn edges.
2. **Orchestration run** (a run is selected): orca-viz's task DAG — tasks, dependency edges,
   assignee stripes, gates, isolated-tasks group, captions.

## Read first

- `docs/design-system.md` §3–§6, §7.1, §10.2 (canvas), §10.3 (session node — normative),
  §10.4 (task node), §12 (motion)
- `Plan.md` §6 (F3, F4), §7.2–7.3
- Task-7 code: store (`trees`, `fetchTree`, `runs`, `fetchRun`, `ui.dagDirection`,
  `selectSession`, `selectTask`), `ui/tones.ts`, `ui/*` primitives

## Ownership

`src/client/views/dag/**` (replace the placeholder; keep `export function DagView()`), with
co-located tests.

## Requirements

### A. Data

- Agent tree: `fetchTree(selectedRootId)` when the root changes (and `force` refresh every 15 s
  while any node is live — live structure changes also arrive via `sessions` stream events that
  the store merges into `trees`). Merge node data from `sessions[id]` (fresher) over the tree's
  copy.
- Orchestration: `fetchRun(selectedRunId)`; refetch on `orchestration` events (the store handles
  it). Task → assignee monogram: cast index A1, A2… by first dispatch time (orca-viz rule), or
  the linked session's agent monogram when `assigneeSessionId` is known.

### B. Layout

- elkjs (bundled build, async) with options from design-system §10.2; direction from
  `ui.dagDirection.session` (default `RIGHT`) / `.orchestration` (default `DOWN`); node sizes
  264×96 (session) and 240×84 (task).
- Re-run layout only when the **structure key** (node ids + edges + direction) changes; data
  updates patch node `data` without relayout. Keep the viewport when relayouting due to growth
  (no jarring fitView); `fitView` on first layout and when the root/run changes.
- Orchestration isolated tasks (no in/out edges): gridded below the DAG (orca-viz geometry:
  120 px gap, `cols = max(4, ceil(sqrt(2n)))`, 24 px gap) and toggleable with the "Isolated
  tasks (N)" float pill (default expanded).

### C. Rendering (@xyflow/react v12)

- Node types: `session` (design-system §10.3: stripe, wash, alive ring when working, row 1
  monogram/STATE/harness/`✗N`/elapsed, row 2 title, row 3 current activity or counters; dimmed
  when filtered; selected outline; pulse ring when `lastActivityAt` changes) and `task`
  (design-system §10.4 / orca-viz).
- Edges: bezier with `ArrowClosed` markers; into working nodes animated amber dashes; into
  error nodes red; label on hover via tooltip (spawn description / dependency).
- Background dots, Controls (zoom in/out/fit), MiniMap (tone accent colors; hidden < lg),
  float pills: top-left direction toggle (+ isolated toggle in run mode), top-center caption,
  bottom-center legend "fill = state · stripe = agent".
- Captions: tree mode — "<root title> · N agents · M working" (or "No subagents yet."); run
  mode — orca-viz captions ("No dependencies in this run — N tasks dispatched independently.",
  "N tasks · M dependencies", cycle note if deps form a cycle).
- Interactions: click session node → `selectSession(id)`; click task node →
  `selectTask(id)`; double-click a session node with children → `selectRoot` stays, fit view to
  its subtree; `Esc` clears handled globally (Task-16). "Follow live" toggle pill: when on,
  smoothly `setCenter` on newly spawned working nodes.
- Empty states: no selection ("Select an agent session or orchestration run."), loading ("Laying
  out N agents…"), error (message + retry).
- Performance: up to 300 nodes smooth; memoize node components; avoid re-creating node arrays
  on unrelated store changes (narrow selectors).

## Tests

Pure functions (structure key, isolated grid, assignee monograms, caption text, edge styling
by target state) unit-tested; component test with the mock store: renders N session nodes for
the mock tree, clicking a node selects it, run mode renders tasks + the isolated group caption
for the "3 ready tasks" run. (ELK can be mocked in component tests with a deterministic layout
function injected via a prop or module boundary.)

## Acceptance

`?mock=1`: the working root's tree renders with 6 subagents, alive rings on working nodes,
animated edges, new subagents appear live without layout jumps; selecting the orchestration run
renders the DAG and the 3-task isolated run renders the independent-tasks caption. Tests green
(`npx vitest run src/client/views/dag`), typecheck clean for owned files.

## Report

Summary, files, tests + results, deviations.
