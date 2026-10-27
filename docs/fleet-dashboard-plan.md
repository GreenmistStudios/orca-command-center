# Fleet DAG — top-level dashboard plan

## 1. Goal

Add a **Fleet** view: a single, live DAG that shows every running project and workflow at once,
so you can see everything that is happening without picking a root session or run first. It becomes the
default landing view. The existing DAG view stays as the drill-down for one tree or run.

## 2. What the graph shows

The graph has four columns, laid out with ELK `RIGHT`:

```text
Project ──▶ Worktree ──▶ Root agent session (rolled-up subagent tree)
                   └──▶ Orchestration run ──▶ coordinator session (dashed "coordinates" edge)
```

| Node | Source (client store, no server changes) | Shows |
|---|---|---|
| **Project** | Group by `SessionSummary.workspace.repo ?? workspace.name` plus `WorktreeInfo.repo` | Name, worktree count, live/working/needs-you counts, rolled-up state dot |
| **Worktree** | `orca.worktrees` joined with `session.workspace.key/path` (sessions with no Orca worktree get a synthetic worktree keyed by `workspace.key`) | Branch, display name, live terminal count, last activity, rolled-up state |
| **Session** | Root sessions (`parentId == null`) | Title, harness, agent/model, state, subagent count (`descendantCount`), how many descendants are working, cost, age |
| **Run** | `orchestration.runs` | Objective, task status bar from `statusCounts`, blocking-gate badge, last activity |

A run attaches to the coordinator session's worktree when `coordinatorSessionId` resolves.
Otherwise it attaches to the worktree whose session has `orca.runId === run.id`. If neither matches, it
goes under an "Unattached" project.

**Rollup state:** a parent node shows the highest-priority state among its children, using
`AGENT_STATE_PRIORITY`. "Needs you" means `blocked` or `waiting`, or that an attention item targets
that subtree (`AttentionItem` session/run ids).

## 3. Scope & filters

- **Default ("Active"):** live sessions, plus sessions or runs with activity in the stats window,
  plus anything with attention. Idle worktrees and projects with no remaining children are hidden.
- A toolbar toggle switches between **Active** and **All**, alongside a harness filter (reusing
  `ui.harnessFilter`), a **Collapse projects** toggle, a **Fit** button and a direction toggle.
- When the graph has more than 150 nodes, idle sessions per worktree collapse into a "+N idle" node.

## 4. Interaction

- **Session node:** click to select it (`selectSession` → the inspector opens in the dock).
  Double-click, or the "Open tree" button, sets `view='dag'` with that root.
- **Run node:** click calls `selectRun`. Double-click opens the Run DAG.
- **Project and worktree nodes:** click toggles collapse (local state).
- Live updates re-render node data in place. ELK re-layout runs only when `structureKey` changes,
  reusing `dag/model.structureKey`.
- Empty state: "Nothing running" with a link to switch to **All**.

## 5. Architecture

- `src/client/views/fleet/model.ts`: pure `buildFleetGraph(input, opts) → FleetGraph`, which
  returns ELK-compatible nodes and edges plus typed node data, and handles rollups and filters. It is
  fully unit-tested.
- `src/client/views/fleet/nodes.tsx`: memoized React Flow node components (Project, Worktree,
  Session, Run, Overflow) that use the existing ui primitives and tones.
- `src/client/views/fleet/FleetView.tsx`: the toolbar, React Flow canvas and layout effect.
- `dag/model.ts` changes are additive only: `GraphNode.type` widens to `string`, so `elkLayout` is reused as is.
- Wiring: `ViewId` gains `'fleet'` (first in `VIEW_ORDER`, and the default `ui.view`), plus the tab,
  CenterView registry, URL `v=fleet`, palette and hotkeys.
- The data comes from the existing bootstrap and SSE store, so there are no server or contract changes.

## 6. Delivery

| Task | Title | Wave | Depends on |
|---|---|---|---|
| [18](../tasks/Task-18.md) | Fleet graph model (pure) | E1 | — |
| [19](../tasks/Task-19.md) | View wiring + stub | E1 | — |
| [20](../tasks/Task-20.md) | Fleet view UI, nodes, mock data, e2e | E2 | 18, 19 |

Each wave is followed by `npm run typecheck`, `npm test` and `npm run build`, then a checkpoint commit.

## 7. Acceptance

- In `?mock=1`, the app opens on Fleet. Every project, worktree, root session and run in the mock
  appears, and the state dots update live.
- Clicking through to the inspector, the Tree DAG and the Run DAG works.
- Typecheck, unit tests and build are all green. A Playwright mock spec covers the Fleet view landing
  and drilling into a tree.
