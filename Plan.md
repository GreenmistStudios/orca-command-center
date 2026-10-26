# Orca Command Center — Product & Delivery Plan

> A local, read-only command console that shows — live and truthfully — what every AI agent Orca
> is running is doing: its task graph, its thinking, its tool and MCP calls, the files it changed,
> what it produced, and whether it needs you.

| | |
|---|---|
| Location | `~/Development/orca-command-center` |
| Run | `npx occ` / `npm start` → `http://127.0.0.1:4270` (orca-viz keeps 4269; both can run) |
| Stack | Node ≥ 22.13 (`node:sqlite`, zero native deps) · TypeScript · React 19 · Vite 8 · Tailwind 4 · @xyflow/react 12 + elkjs · zustand · motion · lucide · radix |
| Companion docs | [`docs/design-system.md`](docs/design-system.md) · [`docs/data-sources.md`](docs/data-sources.md) |
| Executable contract | [`src/shared/contract.ts`](src/shared/contract.ts) (HTTP/SSE types) · [`src/server/types.ts`](src/server/types.ts) (server module interfaces) |
| Tasks | [`tasks/Task-1.md`](tasks/Task-1.md) … [`tasks/Task-17.md`](tasks/Task-17.md) |

---

## 1. Summary

orca-viz answers *"what does Orca's orchestration database say?"* — a DAG of orchestration
tasks and the messages agents sent each other. On this machine that database is nearly empty
(2 runs, 3 tasks, 0 dispatches) while the real work happens elsewhere: **662 OpenCode sessions
(288 of them subagents)**, 36 Copilot CLI sessions, and a dozen Orca terminals whose agents
flip between working, blocked and done all day.

The command center fuses every source Orca and its harnesses leave on disk into one live model:

- **Orca** — which agents are running in which worktree/terminal and their live state (hooks,
  CLI), plus orchestration runs, tasks, dependencies, dispatches and gates.
- **Harness transcripts** — the actual work: thinking, tool calls, MCP calls, file edits,
  subagent spawns, todos, tokens and cost (OpenCode first-class, Copilot CLI second;
  Claude Code / Codex adapters later behind the same interface).

…and presents it in orca-viz's visual language as a command console: a fleet rail, a live agent
DAG, an activity firehose, a timeline, a changes/artifacts browser, an overview scoreboard, and an
attention queue for anything that needs a human.

## 2. Vision

**"One screen that tells you, truthfully and live, what every agent is doing, why, and what it
changed."**

The experience is built around a four-beat loop:

1. **Glance (2 seconds).** Header pulse (`3 working · 1 needs you`), rail state dots, and the
   attention strip tell you whether anything needs you.
2. **Focus.** Pick a root agent session. The DAG shows its whole subagent tree, live: who
   spawned whom, who is working, who failed.
3. **Drill.** Click any node. The inspector streams that agent's thinking, tool calls, MCP calls
   and edits as they happen, with full inputs/outputs on demand.
4. **Verify.** The Changes view shows exactly which files each agent touched, with diffs, and
   what it produced (docs, new files, PRs, links).

Across all agents, the **Stream** is the firehose and the **Timeline** shows parallelism and
idle gaps. **Overview** answers "how much, how fast, what did it cost".

Positioning vs orca-viz: same look, same honesty principles, broader scope (harness
transcripts, live agent state, files and artifacts, cross-source joins). orca-viz remains the
reference for orchestration-DB semantics; the command center reimplements the parts it needs.

## 3. Goals & non-goals

**Goals**

- G1. Live situational awareness of all agents on this machine within ≤ 2 s of a change.
- G2. Explain any agent's work at every level: tree → session → turn → tool call → diff.
- G3. Surface everything that needs a human (permission, question, error, stall, gate).
- G4. Never compromise safety: read-only, no secrets, loopback by default.
- G5. Stay fast on real data (4 GB OpenCode DB): boot ≤ 1.5 s, idle CPU ≈ 0.
- G6. Look and feel like orca-viz (dark, dense, calm, precise).

**Non-goals (v1)**

- Controlling agents (sending input, approving permissions, stopping workers, resolving gates).
  The console observes; Orca acts. (Possible v2: deep links that *ask Orca* to focus a terminal.)
- Remote access, auth, multi-user. (Loopback only; `--host` is an explicit, warned opt-in.)
- Persisting its own history database. Everything is derived from the sources on demand.
- Claude Code / Codex adapters (no local data to verify against; interface is ready — §15).

## 4. Users & jobs to be done

Primary user: a developer running many concurrent agent sessions through Orca across several
repos/worktrees (OpenCode with subagents, Copilot CLI, occasional Orca orchestration runs).

| # | Job | Answered by |
|---|---|---|
| J1 | "Is anything waiting on me right now?" | Header pulse, Attention strip/panel |
| J2 | "What is running, where, and for how long?" | Fleet rail (grouped by workspace) |
| J3 | "How did this agent decompose the work, and who is doing what?" | DAG (session tree / orchestration) |
| J4 | "What is this agent doing *right now* and why?" | Inspector live transcript (thinking, tools, MCP) |
| J5 | "Which MCP servers/tools are being used, and are they failing?" | Stream filters, Overview MCP table, tool error counts |
| J6 | "What did the agents change / produce?" | Changes (files + diffs), Artifacts |
| J7 | "Where did time and money go?" | Timeline, Overview scoreboard, tokens/cost |
| J8 | "Can I trust this?" | Provenance captions, source health chips, honest unknowns |

## 5. Product principles

1. **Read-only, always** — no DB writes, no terminal input, only allowlisted read-only CLI
   commands (data-sources §0).
2. **Never touch secrets** — denylisted tables/files, redaction before serving, no `data:` URLs.
3. **Honest provenance** — every inferred fact says where it came from; unknown is shown as
   unknown, never guessed (e.g. "state from Orca hook" vs "state from transcript").
4. **Degrade per source, never crash** — each source has health; a missing/broken source
   disables only its features and says so in a banner.
5. **Live but cheap** — change-gated incremental reads (`PRAGMA data_version`, `event` rowid
   tail, `fs.watch` hints), bounded memory and payloads, lazy detail.
6. **Glanceable first, drill-down second** — state → who → what → why → what changed.
7. **Calm by default** — motion communicates liveness (alive rings, pulses, animated edges) and
   respects `prefers-reduced-motion`; nothing blinks without meaning.

## 6. Features & scope

Priority: **P0** = must ship in v1; **P1** = ships in v1 if Wave C completes, otherwise first
follow-up. All are planned and tasked.

| ID | Feature | Pri | Task(s) | Acceptance (summary) |
|---|---|---|---|---|
| F1 | Connection & source health: header pills, source chips + popover, banner, splash | P0 | 2, 7 | Orca pid shown when running; each source chip shows ok/degraded/missing/error with detail; banner lists degradations; reconnect shows amber pill and recovers via resync |
| F2 | Fleet rail: workspaces → root sessions → cast; live/harness/text filters; orchestrations section | P0 | 9 | Sessions in window grouped by workspace, sorted by urgency; live row shows current activity; cast lists subagents with states; j/k navigation |
| F3 | Agent DAG: root + subagent tree, live states, animated edges, minimap, legend, direction toggle | P0 | 10 | New subagent appears ≤ 2 s after spawn; working nodes have alive ring; click → inspector |
| F4 | Orchestration DAG (orca-viz parity): tasks/deps/assignee stripes/gates/isolated group/captions | P1 | 10 | Current DB renders "3 tasks dispatched independently" isolated group; deps draw edges |
| F5 | Inspector: header, Activity transcript (prompt/thinking/text/tool/MCP/file-change/subagent/todo/steps), Files, Todos, Info+provenance; orchestration task inspector | P0 | 11 | Live transcript appends ≤ 2 s; expanding a tool card loads full redacted I/O; diffs render; links to child sessions |
| F6 | Live activity stream: virtualized firehose, scope + kind + harness + text filters, follow/pause, expand, load older | P0 | 12 | 20k rows scroll at 60 fps; filters by MCP/errors; follow sticks to bottom; paused buffers count |
| F7 | Timeline: lanes per agent in a tree, activity blocks by kind, zoom/pan, live follow | P1 | 13 | Parallel subagents visibly overlap; click block → inspector selects activity |
| F8 | Changes & artifacts: file tree with +/−, per-file change history with diffs and attribution; artifacts (docs, new files, PRs, links, images) | P1 | 14 | Every edit/write/patch attributable to a session; PR URLs from `gh pr create` output appear as artifacts |
| F9 | Overview & scoreboard: KPIs, 60-min activity histogram, harness/model/agent breakdown, top tools, MCP servers, per-root scoreboard | P1 | 15 | Numbers reconcile with session counters; click row → select session |
| F10 | Attention: strip above canvas + dock panel; permission/question/error/stalled/gate/failed-task | P0 | 8, 15 | A pending permission in any Orca pane shows within ≤ 2 s; clears when resolved |
| F11 | Command palette (⌘K) and keyboard shortcuts | P1 | 16 | Jump to any session/workspace/run/view by typing |
| F12 | Deep links & persistence: URL state (`?s=&v=&r=&t=`), theme, dock width, filters | P1 | 7, 16 | Reload restores selection and view |
| F13 | Safety: read-only, denylist guard, redaction, loopback + Host-header check, no data URLs | P0 | 1, 2, 3–6 | Tests prove denied tables can't be queried and secrets are redacted |
| F14 | Resilience: Orca stopped, source missing, schema drift, server restart, DB reset | P0 | 2–8 | Every case renders with an honest banner; no crash; resync after restart |

## 7. UX specification

Visual spec: [`docs/design-system.md`](docs/design-system.md). This section defines behavior.

### 7.1 Layout

```text
┌ Header: logo · "Orca Command Center" · Orca pill · Stream pill · fleet pulse ·· source chips · last event · ⌘K · theme ┐
├ Banner (only when degraded / Orca stopped / schema newer than tested)                                              ┤
├──────────────┬──────────────────────────────────────────────────────────┬────────────────────────────────┤
│ FLEET  (14)  │ ⚠ Attention strip (only when items)                      │ INSPECTOR                      │
│ [search    ] │                       [DAG][Timeline][Stream][Changes][Overview] │ ● working · OC · build      │
│ All │ Live   │ ┌──────────────────────────────────────────────────────┐ │ "Orca command center web app"  │
│ ▾ acme-…  │ │                                                      │ │ [Activity][Files][Todos][Info] │
│  ● Session A │ │        view (DAG canvas / timeline / stream / …)     │ │  ▸ prompt bubble               │
│    ↳ CAST    │ │                                                      │ │  ◦ Thinking · 2.1s             │
│  ○ Session B │ │                                                      │ │  ▣ bash · npm test   ✓ 3.2s    │
│ ▾ insights-…   │ │                                                      │ │  ⧉ atlassian · jira_get_issue  │
│ ORCHESTRATIONS│ └──────────────────────────────────────────────────────┘ │  ✎ Edited src/app.ts +12 −3    │
└──────────────┴──────────────────────────────────────────────────────────┴────────────────────────────────┘
```

Below 1024 px the layout stacks (rail and dock become fold-out bands) exactly like orca-viz.

### 7.2 Selection model

- `selectedRootId` — the root session whose tree the DAG/Timeline/Changes scope to.
- `selectedSessionId` — the session shown in the inspector (root or any descendant).
- `selectedActivityId` — an activity highlighted in the inspector/stream/timeline.
- `selectedRunId` / `selectedTaskId` — orchestration run in the DAG / task in the inspector.
- Selecting a session sets `selectedRootId` to its root. Selecting a run clears the session
  selection for the DAG (inspector keeps the last session until a task is clicked).
- **Default on load:** URL selection if present; else the root with the highest
  `AGENT_STATE_PRIORITY` among live roots (ties → most recent activity); else the most recently
  updated root; else empty state.

### 7.3 Views

| View | Scope | Content | Key interactions |
|---|---|---|---|
| **Fleet** (default) | all projects | One live graph: project → worktree → root session / orchestration run, with rolled-up state; click selects, double-click drills into the DAG (see `docs/fleet-dashboard-plan.md`) | click → inspector; collapse; Active/All |
| **DAG** (default for `s=`/`r=` deep links) | selected root tree, or selected orchestration run | Session nodes (264×96) with state fill, agent stripe, current activity line; edges parent→child labelled with the task description; orchestration: orca-viz task nodes with deps | click node → inspector; hover edge → tooltip with task description; direction toggle (RIGHT default for session trees, DOWN for orchestration); fit; minimap; "Follow live" auto-pans to newly spawned working nodes |
| **Timeline** | selected root tree | One lane per session (indented by depth), session span bar, activity blocks colored by kind, spawn connectors, now-line | zoom (buttons / ctrl+wheel / presets 5m·15m·1h·All), pan (drag), Live follow, click block → select activity |
| **Stream** | All · This tree · This session | Virtualized rows, newest at bottom | kind/harness/text filters with counts; Errors-only; Follow; Pause (space); expand row; load older at top; click session chip → select |
| **Changes** | This tree · All (window) | Left: workspace → dir → file tree with change counts, +/−, agent monograms. Right: chronological changes for the file with DiffView; Artifacts tab | select file; expand diff; copy path; open session |
| **Overview** | All (window) | KPI tiles, 60-min histogram, harness/model/agent tables, top tools, MCP servers, scoreboard of roots | sort tables; click → select session/filter stream |

### 7.4 Inspector (dock)

- **Header:** title, state pill (+ "from Orca hook"/"from transcript" provenance tooltip),
  harness tile, agent monogram + name, model, elapsed, tokens/cost, copy id. Breadcrumb of
  ancestors for subagents (root › parent › this).
- **Activity tab:** paged transcript (latest 40 messages, "Load earlier"), live-appending while
  the session is live, auto-follow with "new activity below" chip. Items per design-system §11.
  Steps hidden behind a "Show steps" toggle. Thinking collapsed by default with duration.
  Tool cards expand to full input/output (lazy `GET /api/parts/:id`). File-change cards expand
  to DiffView. Subagent cards link to the child.
- **Files tab:** this session's file changes (toggle: include descendants).
- **Todos tab:** latest todo list with status icons (`circle`, `loader-circle`, `circle-check`,
  `circle-slash`) and priority.
- **Info tab:** ids, harness/agent/model, directory/workspace, created/updated/last activity,
  token breakdown, cost, facts, Orca link (worktree, branch, terminal handle, pane, hook event &
  state & time, orchestration role/run/task/dispatch), spawn info, provenance list.
- **Orchestration task inspector** (when a task node is selected): orca-viz parity — spec,
  result, dispatch attempts timeline, messages, gates, depends on / blocks.
- **Nothing selected:** the Attention panel (full list) + "Live now" list of working sessions.

### 7.5 Attention

Strip above the view (only when items exist; high severity first; max 3 rows visible, "+N more"
opens the panel) and a full panel in the dock. Kinds and copy:

| Kind | Example title | Severity |
|---|---|---|
| permission | "acme-ios · build needs permission" | high |
| question | "insights-agent · explore asked a question" | high |
| gate | "Run 'Demo task board' is blocked on a decision" | high |
| error | "paparazzi · 3 tool errors in the last 10 min" / "API error: …" | medium / high |
| stalled | "Granola sync · no activity for 14 min while working" | medium |
| failed-task | "Task 'Continue Insights Agent work' failed (2 attempts)" | medium |

### 7.6 Keyboard & URL

`⌘K`/`Ctrl+K` palette · `1–5` views · `j`/`k` next/prev root in rail · `Shift+J`/`Shift+K`
next/prev agent in the cast · `Esc` clear selection / close · `/` focus rail search · `.` toggle
Live only · `f` toggle Follow · `space` pause stream · `t` toggle theme · `?` shortcuts help.

URL: `?s=<sessionId>&v=dag|timeline|stream|changes|overview&r=<runId>&t=<taskId>`, synced with
`history.replaceState`.

### 7.7 States & copy

| Situation | Behavior |
|---|---|
| First load | Splash "Connecting to Orca…" (shimmer) until bootstrap |
| Orca not running | Grey Orca pill "Orca isn't running; showing last-known state." Data still renders |
| Source missing | Chip status `missing` + banner line, e.g. "Copilot CLI not found (~/.copilot) — Copilot sessions hidden." |
| Schema newer than tested | Banner "orchestration.db is from a newer Orca schema — some data may be missing or mislabeled. (schema v44)" |
| Stream drops | Amber "Stream reconnecting…"; on reconnect replay or resync; no duplicated rows |
| Empty fleet | "No agent sessions in the last 24 h." + hint to widen `--window-hours` |
| Empty tree | Single root node + caption "No subagents yet." |

## 8. Architecture

### 8.1 Process model & data flow

```text
                       ┌──────────────── occ server (Node ≥ 22.13, one process) ─────────────────┐
 opencode.db ─event tail┼▶ OpenCodeSource ─┐                                                        │
 ~/.copilot/session-state┼▶ CopilotSource ──┤ HarnessUpdate                                         │
 agent-hooks/last-status ┼▶ OrcaHooksSource ┼──────────────▶ Store (join · state · attention ·      │
 `orca status|worktree ps│                  │ OrcaCliUpdate      stats · artifacts · ring buffer)  │
   |terminal list`  ─────┼▶ OrcaCliSource ──┤                     │ publish(payload)  ▲ queries    │
 orchestration.db ───────┼▶ OrchestrationSrc┘                     ▼                   │            │
                         │                                  Hub (seq, coalesce 250ms, replay ring) │
                         │                                        │ SSE                │ REST       │
                         └────────────────────────────────────────┼────────────────────┼────────────┘
                                                                  ▼                    │
                                        Browser: EventSource /api/stream  +  fetch /api/* (React SPA)
```

- Sources own all I/O and normalization into contract types. The store owns joins, state
  rules, attention, stats and artifacts, and is the only publisher to the hub. Routes only call
  `StoreReader`. The client holds a zustand store fed by bootstrap + SSE, and lazily fetches
  details.
- All SQLite access is synchronous (`node:sqlite`), on the main thread, with short indexed
  queries (budgets in §11).

### 8.2 Directory layout & ownership

| Path | Owner |
|---|---|
| `Plan.md`, `docs/*`, `tasks/*`, `src/shared/contract.ts`, `src/server/types.ts` | Plan (Opus) — read-only for tasks |
| `package.json`, lockfile, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`, `README.md` (skeleton), `src/server/lib/**`, `src/server/store/index.ts` (stub) | Task-1 |
| `bin/occ.mjs`, `src/server/{main,cli,config,version}.ts`, `src/server/http/**`, `src/server/hub/**` | Task-2 |
| `src/server/sources/opencode/**`, `test/fixtures/opencode.ts` | Task-3 |
| `src/server/sources/orca/**`, `test/fixtures/orca.ts` | Task-4 |
| `src/server/sources/orchestration/**`, `test/fixtures/orchestration.ts` | Task-5 |
| `src/server/sources/copilot/**`, `test/fixtures/copilot.ts` | Task-6 |
| `src/client/{index.html,main.tsx,App.tsx}`, `src/client/{styles,ui,lib,state,api,shell,hooks}/**`, placeholder files for every view/rail/inspector/attention/palette, `test/client/**` | Task-7 |
| `src/server/store/**` (replaces stub), `test/integration/**` | Task-8 |
| `src/client/rail/**` | Task-9 |
| `src/client/views/dag/**` | Task-10 |
| `src/client/inspector/**` | Task-11 |
| `src/client/views/stream/**` | Task-12 |
| `src/client/views/timeline/**` | Task-13 |
| `src/client/views/changes/**` | Task-14 |
| `src/client/views/overview/**`, `src/client/attention/**` | Task-15 |
| `src/client/palette/**`, `src/client/hooks/useGlobalHotkeys.ts`; may refine `src/client/shell/**` and `App.tsx` | Task-16 |
| `test/e2e/**`, `README.md` (final), perf scripts `scripts/**` | Task-17 |

Tests are co-located (`*.test.ts(x)`) inside the owner's paths; shared fixtures live in
`test/fixtures/`.

### 8.3 Server modules

- **lib (Task-1):** `sqlite.ts` (read-only open, table denylist guard, `dataVersion()`,
  `columns(table)`, `explain(sql)`), `redact.ts`, `text.ts` (truncate, stripAnsi, oneLine,
  compactJson, extractLinks), `time.ts` (SQL/ISO → ms), `log.ts`, `paths.ts` (platform
  discovery), `tool-classify.ts` (data-sources §1.3), `fs-watch.ts` (debounced directory watch
  with polling fallback).
- **http (Task-2):** `node:http` server; Host-header allowlist (DNS-rebinding guard); no CORS
  headers; `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, CSP for the SPA;
  JSON helpers with `ApiError`; static serving of `dist/client` with SPA fallback and traversal
  guard; route table → `StoreReader`; SSE endpoint.
- **hub (Task-2):** seq counter, 250 ms flush with coalescing rules (types.ts `HubPublisher`),
  replay ring of the last 2,000 frames, per-client backpressure (drop the client and let it
  resync if its socket buffer exceeds 4 MB), `: ping` every 15 s, `hello` on connect.
- **sources (Tasks 3–6):** implement the interfaces in `src/server/types.ts` against
  [`docs/data-sources.md`](docs/data-sources.md).
- **store (Task-8):** `createStore()` constructs sources from config, seeds, subscribes, derives
  (§9), implements `StoreReader`, publishes to the hub.

### 8.4 Client modules

- **state (Task-7):** zustand store with slices `meta`, `connection`, `sessions`, `activity`
  (ring of 20k, indexes by session/root), `orca`, `attention`, `stats`, `orchestration`, `ui`
  (selection, view, filters, theme, dock width), `cache` (session details, trees, transcripts,
  parts, diffs, file changes, artifacts, runs, tasks — with loading/error state) and actions
  `applyBootstrap`, `applyStreamEvent`, `select*`, `fetch*`. Views read via selectors and call
  actions; views never fetch directly.
- **api (Task-7):** typed `api.get(route, params)` using `ApiResponses`; `connectStream()`
  (EventSource with `?since=`, auto-resume via `Last-Event-ID`, `resync` → refetch bootstrap,
  `bootId` change → resync); `mock.ts` (synthetic but realistic fleet with live updates,
  enabled with `?mock=1`, used by UI tasks and tests).
- **ui (Task-7):** primitives and shared components (Panel, Pill, Chip, Badge, Button, Monogram,
  LiveDot, StateDot, Segmented, ViewTabs, ScrollArea, Tooltip, Popover, EmptyState, RelativeTime,
  Duration, CopyButton, KindIcon, ToolBadge, DiffView, tones).

## 9. Derivation rules (store, Task-8)

### 9.1 Session state

Thresholds (config `thresholds`): `workingMs` 120 s, `stalledMs` 10 min, `liveMs` 10 min,
`idleMs` 30 min. Evaluate in order; first match wins:

1. **Orca hook** (root sessions whose id equals a hook entry's `providerSessionId`, newest
   entry wins):
   - hook `state` `blocked` → `blocked`; `waiting` → `waiting`; `working` → `working`;
   - `done` → `done`, or `idle` when `now − receivedAt > idleMs`;
   - …but if the transcript shows activity newer than `receivedAt + 30 s` and within
     `workingMs`, the transcript wins (hooks can lag) → `working` (source `transcript`).
   - Source: `orca-hook`.
2. **Parent tool** (subagents with `spawn`): spawn status `running`/`pending` → `working` (or the
   transcript's `waiting`/`error` if more specific); `completed` → `done`/`idle` by age;
   `error` → `error`. Source: `parent-tool`.
3. **Orchestration** (dispatched workers without hooks): dispatch `dispatched` → `working`,
   `completed` → `done`, `failed`/`circuit_broken` → `error`. Source: `orchestration`.
4. **Transcript:** `waiting` → `waiting`; `error` → `error`; `working` → `working` if
   `now − lastActivityAt ≤ workingMs`, `unknown` (+ stalled attention) if `> stalledMs`, else
   `working`; `done` → `done`, or `idle` when older than `idleMs`; `unknown` → `idle` when older
   than `idleMs` else `unknown`. Source: `transcript`.
5. Nothing → `idle`, source `none`.

`live` = state ∈ {working, blocked, waiting} OR `now − lastActivityAt ≤ liveMs`.
`stateSince` = hook `stateStartedAt` / transition time observed by the store / lastActivityAt.

### 9.2 Workspace & Orca link

Per data-sources §6. Roots get pane/terminal links via hooks; descendants inherit the root's
workspace. Orchestration roles: a session whose terminal handle equals `runs.coordinator_handle`
is `coordinator`; one whose handle equals a dispatch `assignee_handle` is `worker`.

### 9.3 Attention

Recomputed on any change; published only when the list changes (stable ids):

| Kind | Condition | Severity | id |
|---|---|---|---|
| permission | session state `blocked`, or an unresolved Copilot `permission.requested` | high | `permission:<sessionId>` |
| question | session state `waiting` | high | `question:<sessionId>` |
| gate | orchestration gate `blocking` | high | `gate:<gateId>` |
| error | latest assistant message has `error` (session state `error`) and the session is a live root or was active in the last `liveMs` | high | `error:<sessionId>` |
| error | ≥ 1 tool error in the last 10 min in a live session | medium | `tool-errors:<sessionId>` |
| stalled | transcript `working` but no activity for `stalledMs` | medium | `stalled:<sessionId>` |
| failed-task | orchestration task `failed` or dispatch `circuit_broken` in a run active in the last 24 h | medium | `failed-task:<taskId>` |

Sort: severity, then `since` descending.

### 9.4 Artifacts

From activity and file changes in scope: `write`/`create` of `.md .mdx .txt .html .pdf .csv
.json .yaml .yml` → `document` (`report` when the path contains `report`/`Report`); other
`create` → `new-file`; links matching `https://github.com/<o>/<r>/pull/<n>` (and GHE hosts with
`/pull/`) in tool output or assistant text → `pull-request` (dedupe by URL); other links in
assistant `text` items → `url` (dedupe, max 50 per root); image `file` parts → `image`
(filename only). Each artifact keeps session attribution and a source tag.

### 9.5 Stats

Over sessions in the window: counts by state; tool/MCP/thinking/file-change/subagent totals from
`getCounters` (cached per session, refreshed ≤ every 5 s for live sessions); tokens and cost from
session rows; breakdowns by harness/model/agent; `topTools` and `mcpServers` from
`getToolStats(windowSessionIds)` (cached 15 s); histogram from the ring buffer (last 60 min,
1-minute buckets). Published at most every 5 s.

### 9.6 Ring buffer

The 20,000 most recent activity events across all sources, upserted by id keeping the highest
`rev`, ordered by `ts`. Seeded at boot from each harness's `recentActivity` (last 24 h, ≤ 3,000
events per source) and orchestration messages. Indexes: by sessionId and rootId.

## 10. API & streaming protocol

### 10.1 Transport

JSON over HTTP on the same origin as the SPA. Errors: `ApiError` with 400/404/503/500.
Server-Sent Events per contract `StreamEvent` (default `message` events, `id` = seq, `: ping`
every 15 s). Client flow: `GET /api/bootstrap` → `EventSource('/api/stream?since=<seq>')`. On
reconnect the browser sends `Last-Event-ID`; if that seq is still in the replay ring, frames are
replayed; otherwise the server sends `resync` and the client refetches bootstrap. A different
`bootId` in `hello` also triggers resync.

### 10.2 Routes

| Route | Query params | Notes |
|---|---|---|
| `GET /api/meta` | — | |
| `GET /api/bootstrap` | — | snapshot + `seq` |
| `GET /api/sessions` | `windowHours`, `harness`, `state`, `live=1`, `q`, `limit` (≤ 2000) | |
| `GET /api/sessions/:id` | — | any session id, even outside the window |
| `GET /api/sessions/:id/tree` | — | tree of `:id`'s root |
| `GET /api/sessions/:id/transcript` | `before`, `limit` (default 40, ≤ 200) | |
| `GET /api/activity` | `sessionId` \| `rootId` (else fleet ring), `kinds` (csv), `before`, `sinceMs`, `limit` (≤ 5000) | |
| `GET /api/parts/:id` | — | full redacted detail (≤ 256 KB) |
| `GET /api/file-changes` | `rootId` \| `sessionId`, `windowHours` | |
| `GET /api/file-changes/:id/diff` | — | ≤ 512 KB |
| `GET /api/artifacts` | `rootId`, `windowHours` | |
| `GET /api/attention` | — | |
| `GET /api/stats` | `windowHours` | |
| `GET /api/orca` | — | |
| `GET /api/orchestration` | — | |
| `GET /api/orchestration/runs/:id` | — | |
| `GET /api/orchestration/tasks/:id` | — | |
| `GET /api/stream` | `since` | SSE |
| `GET /*` | — | SPA (dist/client), fallback to index.html |

Unknown query keys → 400 (catches client typos early). All responses `Cache-Control: no-store`.

## 11. Non-functional requirements

| Area | Requirement |
|---|---|
| Boot | First bootstrap ≤ 1.5 s on this machine (4 GB opencode.db, ~15 sessions in 24 h) |
| Idle cost | No SQL beyond `PRAGMA data_version` when nothing changes; Orca CLI every 5 s; CPU < 2% idle |
| Latency | Source change → UI ≤ 2 s (p95) for OpenCode/hooks; ≤ 6 s for Orca CLI facts |
| Payloads | Bootstrap ≤ 2 MB; SSE ≤ 4 frames/s/client; per-event strings bounded by `LIMITS` |
| Memory | Server RSS ≤ 300 MB; ring 20k events; caches LRU-bounded |
| Client | 60 fps scrolling with 20k stream rows (virtualized); DAG up to 300 nodes; layout off the critical path (ELK async) |
| Safety | data-sources §0 rules enforced in code + tests; loopback default; Host allowlist; no CORS; CSP |
| Reliability | Any source may be missing/erroring/changing schema without crashing the server or the UI |
| A11y | Keyboard reachable, visible focus rings, `aria-label`s on icon buttons, `role=tablist` tabs, reduced motion, WCAG AA contrast in both themes |
| Compatibility | macOS first (paths); Linux/Windows paths implemented in discovery; Node ≥ 22.13 |

## 12. Testing & verification

- **Unit (vitest, node):** lib helpers (redaction cases, truncation, ANSI, tool classification,
  time parsing, denylist guard); each source against real fixture files/DBs built by
  `test/fixtures/*` (never mock `node:sqlite`); hub coalescing/replay/resync; HTTP routes with a
  fake `StoreReader`; store derivations with fake sources and fixed clocks.
- **Query-plan tests:** every query touching `part`/`message`/`event` asserts `EXPLAIN QUERY
  PLAN` contains `SEARCH` on that table.
- **Integration (Task-8):** real server + real sources over fixture data → HTTP + SSE
  assertions (bootstrap shape, live append ≤ 1 poll, resync after cursor loss).
- **Client (vitest + jsdom + Testing Library):** components render from the mock store; key
  interactions (select, filter, expand) — `data-testid` on major regions.
- **E2E (Task-17):** build, start against the **real** machine data read-only, Playwright
  headless: load, wait for "Live", accessibility snapshot of header/rail/DAG/inspector, no console
  errors, switch every view, measure boot time and idle CPU. (Accessibility snapshots only — no
  OS-level screenshots.)
- **Definition of done (every task):** owned files only; `npm run typecheck` clean for owned
  files; `npx vitest run <owned paths>` green; no new dependencies unless the task allows it;
  a task report (summary, files, tests run + results, deviations, follow-ups).

## 13. Delivery plan

### 13.1 Phases, waves & milestones

| Phase | Wave | Tasks (parallel within a wave) | Milestone |
|---|---|---|---|
| 0 Plan | — | Plan.md, docs, contract (done) | Plan approved |
| 1 Foundation | A | **Task-1** scaffold, tooling, shared server libs, store stub | `npm run typecheck`, `npm test`, `npm run build` all green on an empty app |
| 2 Core | B | **2** server core · **3** OpenCode · **4** Orca live · **5** orchestration · **6** Copilot · **7** client foundation | **M1 "Data flows":** server runs with the stub store; each source passes fixture tests; UI shell runs on `?mock=1` |
| 3 Experience | C | **8** store/integration · **9** rail · **10** DAG · **11** inspector · **12** stream · **13** timeline · **14** changes · **15** overview+attention · **16** palette/keys/polish | **M2 "Live console"** (8+9+10+11 on real data) → **M3 "Full console"** |
| 4 Hardening | D | **17** e2e on real data, perf, docs, packaging; review pass + fixes | **M4 "Ship"** |

### 13.2 Dependency graph

```text
Task-1 ─┬─▶ 2 ─────────────┐
        ├─▶ 3 ─┐           │
        ├─▶ 4 ─┼──────────▶ 8 ───────────────┐
        ├─▶ 5 ─┤           │                 │
        ├─▶ 6 ─┘           │                 ▼
        └─▶ 7 ─▶ 9 · 10 · 11 · 12 · 13 · 14 · 15 · 16 ──▶ 17
```

Wave C UI tasks build against the mock store (`?mock=1`) and do not wait for Task-8; Task-17
verifies everything together on real data.

### 13.3 Task index

| Task | Title | Wave | Depends on | Size |
|---|---|---|---|---|
| [1](tasks/Task-1.md) | Scaffold, tooling, shared server libs | A | — | M |
| [2](tasks/Task-2.md) | Server core: CLI, config, HTTP, SSE hub, security | B | 1 | L |
| [3](tasks/Task-3.md) | OpenCode harness adapter | B | 1 | XL |
| [4](tasks/Task-4.md) | Orca live sources: CLI poller + hooks watcher | B | 1 | M |
| [5](tasks/Task-5.md) | Orca orchestration DB reader | B | 1 | M |
| [6](tasks/Task-6.md) | Copilot CLI harness adapter | B | 1 | L |
| [7](tasks/Task-7.md) | Client foundation: theme, shell, store, API/SSE, mock | B | 1 | XL |
| [8](tasks/Task-8.md) | Store & integration: joins, state, attention, stats, artifacts | C | 2–6 | XL |
| [9](tasks/Task-9.md) | Fleet rail | C | 7 | L |
| [10](tasks/Task-10.md) | DAG view (agent tree + orchestration) | C | 7 | L |
| [11](tasks/Task-11.md) | Inspector dock | C | 7 | XL |
| [12](tasks/Task-12.md) | Stream view | C | 7 | L |
| [13](tasks/Task-13.md) | Timeline view | C | 7 | L |
| [14](tasks/Task-14.md) | Changes & artifacts view | C | 7 | M |
| [15](tasks/Task-15.md) | Overview, scoreboard & attention | C | 7 | M |
| [16](tasks/Task-16.md) | Command palette, shortcuts, URL state, polish | C | 7 | M |
| [17](tasks/Task-17.md) | E2E on real data, performance, docs, packaging | D | all | M |

### 13.4 Execution protocol (subagents)

- The coordinator (Opus) owns the plan, the contract files, git, and acceptance. Implementation
  is done by `sonnet-coder` subagents, one per task, launched in parallel per wave.
- Each subagent prompt: *"Implement tasks/Task-N.md for the Orca Command Center at
  ~/Development/orca-command-center. Read Plan.md (§ listed in the task), the referenced docs, and
  the contract files first. Only create/modify files listed under Ownership. Do not add
  dependencies unless the task says so. Do not commit. Verify with the task's commands. Report:
  summary, files changed, commands run with results, deviations, follow-ups."*
- Parallel safety: disjoint file ownership; dependencies are installed once in Task-1; a
  typecheck error in a file owned by another in-flight task is ignored by the reporting task (but
  its own files must be clean).
- After each wave the coordinator: reviews diffs against the task, runs `npm run typecheck`,
  `npm test`, (from Wave C) `npm run build`, fixes integration seams or re-dispatches, then makes
  a local checkpoint commit (`feat: … [wave X]`). No pushes.
- Contract changes are made only by the coordinator, additively, and announced in the next
  wave's prompts.

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Orca / OpenCode change their private schemas | Column introspection, per-feature degradation, source health + banner, fixtures mirroring real shapes, tested version noted |
| 4 GB DB → slow queries / WAL growth | Index-only queries + EXPLAIN tests, `data_version` gating, event-rowid tail, short read txns, no long-lived statements |
| Secrets in transcripts (tokens in commands, `.env` reads) | Redaction (patterns + secret keys), `read` outputs omitted from stream, denylist guard, loopback + Host check |
| Event flood while models stream | Coalescing at source (per poll) and hub (250 ms); bounded summaries |
| Hook file holds only the latest state per pane | Treat as current state; transitions derived by diffing; transcript cross-check rule (§9.1) |
| Parallel subagents collide | Strict ownership table, deps installed once, coordinator-only commits and contract changes |
| UI tasks built on mock drift from real data | Mock generated from contract types with real-shaped samples; Task-17 runs on real data; Task-8 integration tests |
| Orca CLI slow/unavailable | 3 s timeout, last-good snapshot marked stale, health `error`, rest of the console unaffected |
| Copilot transcripts large | Byte-offset tailing, window filter, parse only what's needed |

## 15. Future work

- Claude Code (`~/.claude/projects/**.jsonl`, `mcp__server__tool` naming, sidechains) and Codex
  (`~/.codex/sessions/**/rollout-*.jsonl`) adapters behind `HarnessSource`.
- Orca-native actions via official CLI (focus terminal, open file diff in Orca) — opt-in.
- Run archives (export/replay a root tree like orca-viz `--archive`).
- Cost budgets & alerts; desktop notifications for attention items.
- Remote viewing via `tailscale serve` recipe (documented, not automated).
