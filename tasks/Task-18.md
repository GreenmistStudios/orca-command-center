# Task-18 — Fleet graph model (pure)

**Wave:** E1 (parallel with 19) · **Size:** M · **Depends on:** — · **Blocks:** 20

## Goal

A pure, tested function that turns store data into the fleet DAG (Project → Worktree → Root
session / Orchestration run) described in `docs/fleet-dashboard-plan.md`.

## Read first

- `docs/fleet-dashboard-plan.md` (all)
- `src/shared/contract.ts`: `SessionSummary`, `WorkspaceRef`, `OrcaLink`, `WorktreeInfo`, `OrcaSnapshot`, `OrchRun`, `OrchestrationSummary`, `AttentionItem`, `AGENT_STATE_PRIORITY`, `AgentState`
- `src/client/views/dag/model.ts` and `layout.ts`

## Ownership (create/modify only these)

- `src/client/views/fleet/model.ts` and `src/client/views/fleet/model.test.ts` (new)
- `src/client/views/dag/model.ts`: one **additive** change only. Widen `GraphNode.type` to `string`
  and fix nothing else. Existing dag tests must still pass.

## Requirements

### 1. API

```ts
export type FleetNodeKind = 'project' | 'worktree' | 'session' | 'run' | 'overflow'
export interface FleetCounts { live: number; working: number; needsYou: number; idle: number; error: number }
export type FleetNodeData =
  | { kind: 'project'; id: string; name: string; worktreeCount: number; counts: FleetCounts; state: AgentState; collapsed: boolean }
  | { kind: 'worktree'; id: string; projectId: string; name: string; branch: string | null; path: string | null; terminals: number; lastActivityAt: number | null; counts: FleetCounts; state: AgentState; collapsed: boolean }
  | { kind: 'session'; id: string; session: SessionSummary; workingDescendants: number; needsYou: boolean }
  | { kind: 'run'; id: string; run: OrchRun; needsYou: boolean }
  | { kind: 'overflow'; id: string; worktreeId: string; hidden: number }
export interface FleetGraph extends Graph { data: Record<string, FleetNodeData> }
export interface FleetInput { sessions: Record<string, SessionSummary>; worktrees: WorktreeInfo[]; runs: OrchRun[]; attention: AttentionItem[]; now: number; windowMs: number }
export interface FleetOptions { scope: 'active' | 'all'; harness: string | null; collapsed: ReadonlySet<string>; maxNodes?: number /* default 150 */ }
export function buildFleetGraph(input: FleetInput, opts: FleetOptions): FleetGraph
export function rollupState(states: AgentState[]): AgentState
```

Check the real field types in the contract and adapt to them. Do not change the contract.

### 2. Node ids

Node ids are `p:<key>`, `w:<key>`, `s:<sessionId>`, `r:<runId>` and `o:<worktreeKey>`. Edge ids are `<src>><tgt>`.

### 3. Grouping

- The project key is `workspace.repo ?? workspace.name ?? 'Unattached'`.
- Sessions join a worktree by matching `orca.worktreeId` (or the equivalent `OrcaLink` field) to
  `WorktreeInfo.id`. If that fails, match the worktree path to `workspace.path`. If that fails too,
  use a synthetic worktree keyed by `workspace.key`.

### 4. Runs

A run attaches to its coordinator session's worktree. Failing that, it attaches to the worktree of
any session with `orca.runId === run.id`. Failing that, it goes under the `Unattached` project with a
synthetic worktree. When the coordinator session node is present, add an extra edge `r:<run>` → `s:<coord>`
with the label `coordinates`.

### 5. Scope `active`

Keep a session when it is live, or has `lastActivityAt` within `windowMs`, or has an attention item.
Keep a run when its `lastActivityAt` is within the window, it has a blocking gate, or it has
non-terminal tasks (any status other than done/completed/failed/cancelled). Prune empty worktrees
and projects. Scope `all` keeps everything.

### 6. Other rules

- **Harness filter:** applies to sessions.
- **Collapse:** a collapsed project or worktree keeps its node but drops its descendants. Its counts
  still reflect everything under it.
- **Overflow:** when the total node count exceeds `maxNodes`, replace the idle (non-live) sessions in
  each worktree with a single overflow node. Repeat until the count fits or no idle sessions remain.
- **Deterministic ordering:** sort projects and worktrees by name, sessions by state priority then
  recency, and runs by recency.

## Acceptance / Verify

```bash
npx vitest run src/client/views/fleet src/client/views/dag
npx tsc -p tsconfig.client.json --noEmit
```

Tests should cover grouping, synthetic worktrees, run attachment (all three paths), the coordinates
edge, active vs all, harness filter, collapse counts, overflow, rollup priority, attention marking
needsYou, and determinism.

## Report

Summary, files, commands and results, deviations.
