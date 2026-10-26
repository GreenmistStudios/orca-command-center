# Task-7 — Client foundation: theme, shell, store, API/SSE, mock

**Wave:** B (parallel with 2–6) · **Size:** XL · **Depends on:** Task-1 · **Blocks:** 9–16

## Goal

Everything the UI tasks (9–16) build on: the orca-viz look (tokens, recipes, motion), the app
shell (header, banner, rail/center/dock layout, view tabs, splash), the typed API client and SSE
connection, the zustand store with all slices/actions/selectors, a realistic **mock backend**
(`?mock=1`) so UI work does not depend on the server, shared UI primitives, and placeholder
components for every view/panel owned by later tasks.

## Read first

- `docs/design-system.md` — the whole file (normative for visuals)
- `Plan.md` §2, §7 (UX — normative for behavior), §8.4, §10, §11
- `src/shared/contract.ts` (all client data types; `StreamEvent`, `ApiResponses`, `LIMITS`, `HARNESS_META`, `AGENT_STATE_PRIORITY`)

## Ownership

- `src/client/index.html`, `src/client/main.tsx`, `src/client/App.tsx`
- `src/client/styles/**`, `src/client/ui/**`, `src/client/lib/**`, `src/client/state/**`,
  `src/client/api/**`, `src/client/shell/**`, `src/client/hooks/**` (except the body of
  `useGlobalHotkeys.ts`, which Task-16 replaces)
- Placeholder files (create them with the exact exports below; later tasks replace their content):
  `src/client/rail/Rail.tsx`, `src/client/views/dag/DagView.tsx`,
  `src/client/views/timeline/TimelineView.tsx`, `src/client/views/stream/StreamView.tsx`,
  `src/client/views/changes/ChangesView.tsx`, `src/client/views/overview/OverviewView.tsx`,
  `src/client/inspector/Inspector.tsx`, `src/client/attention/AttentionStrip.tsx`,
  `src/client/attention/AttentionPanel.tsx`, `src/client/palette/CommandPalette.tsx`,
  `src/client/hooks/useGlobalHotkeys.ts`
- `test/client/**` (setup + helpers)

Do not add dependencies (all are installed by Task-1).

## Requirements

### 1. Styles — `styles/theme.css`

- `@import "tailwindcss";` + `@custom-variant dark (&:where(.dark, .dark *));`
- `:root` and `.dark` blocks with **every token** in design-system §2, §3 (status base/soft/ink
  for pending, ready, dispatched, completed, failed, blocked, unknown, gate), §7.1 (agent-1…8 +
  agent-ink), §7.2 (harness tiles), §7.3 (`--kind-*`), shadows `--lift-1/2`.
- `@theme inline` mapping to Tailwind colors: `field, background, panel, panel-solid, muted,
  muted-foreground, accent, panel-border, border, input, foreground, primary,
  primary-foreground, selection, selection-soft, selection-ink, destructive, ring`,
  `status-<x>`, `status-<x>-soft`, `status-<x>-ink` for every status token, `kind-<x>`, plus
  `shadow-lift-1/2`, `radius-xl = calc(var(--radius) + 4px)`, font stacks.
- `@layer components` classes for recipes in design-system §6: `.panel`, `.panel-header`,
  `.section-label`, `.float-pill`, `.chip`, `.status-pill`, `.neutral-pill`, `.monogram`,
  `.pre-block`, `.focus-ring`, `.field-bg`, `.view-tab`, `.seg-track`, `.seg-item`.
- Keyframes `orca-radar`, `orca-pulse`, `orca-drift`, `orca-shimmer`, the `@property
  --orca-angle` + `.orca-alive` ring, `.orca-spotlight`; xyflow overrides (design-system
  §10.2, incl. `--xy-background-pattern-color`); `prefers-reduced-motion` rule; thin scrollbars.
- `index.html`: inline pre-paint theme script (`localStorage['occ-theme']` → `prefers-color-scheme`),
  `<meta name="color-scheme" content="light dark">`, title "Orca Command Center", favicon as an
  inline SVG data URI of a radar glyph.

### 2. `lib/`

`cn.ts` (clsx + tailwind-merge); `format.ts` — `formatDuration(ms)` (`12s`, `3m`, `2h 5m`,
`1d 3h`), `formatRelative(ts, now)` (`now`, `12s ago`, `3m ago`, `2h ago`, `Oct 25`),
`formatClock(ts)` (`HH:MM:SS`), `formatDay(ts)` (`Mon, Oct 26`), `formatCost(n)` (`$0.42`,
`<$0.01`, `$0`), `formatTokens(n)` (`950`, `113.5k`, `2.1M`), `formatCount(n)`,
`shortModel(model)` (`claude-opus-5.5` → `opus-5.5`; `gpt-5.4-codex` stays), `shortPath(path,
root?)`, `basename(path)`; `hash.ts` (`stableHash(str)` FNV-1a); `diff.ts` — 
`parseUnifiedDiff(text)` → `{ files: Array<{ oldPath, newPath, hunks: Array<{ header, lines:
Array<{ type:'add'|'del'|'ctx'|'meta', text, oldNo, newNo }> }> }>, additions, deletions }` and
`parsePatchText(text)` for `*** Begin Patch` format; `storage.ts` (typed localStorage get/set
with JSON + try/catch). Unit tests for format and diff parsing.

### 3. `ui/` (shared primitives; each small and typed; `data-testid` where useful)

`tones.ts`:
```ts
export type Tone = 'pending'|'ready'|'dispatched'|'completed'|'failed'|'blocked'|'unknown'|'gate'
export function stateTone(s: AgentState): Tone          // design-system §3.1
export function orchStatusTone(s: string): Tone         // unknown → 'unknown', circuit_broken → 'failed'
export function activityStatusTone(s: ActivityStatus | null): Tone
export function toneClasses(t: Tone): { surface: string; dot: string; border: string; text: string; accentVar: string }
export function kindColorVar(k: ActivityKind): string    // 'var(--kind-mcp)'
export function agentColorIndex(agent: string | null): number   // 1..8 via stableHash; 0 = unknown
export function agentColorVar(agent: string | null): string      // 'var(--agent-3)'
export function agentMonogram(agent: string | null): string      // design-system §7.1
export const STATE_LABEL: Record<AgentState, string>             // 'Working', 'Needs permission', 'Waiting for you', 'Error', 'Done', 'Idle', 'Unknown'
```
Components: `Panel`, `PanelHeader`, `SectionLabel`, `StatusPill` (tone + optional LiveDot/icon),
`Chip`, `Badge` (outline/solid/mono), `Button` (variants `outline|ghost|subtle`, sizes
`sm|icon`), `IconButton` (requires `aria-label`), `AgentMonogram` (agent name, size 17|20|24),
`HarnessTile` (harness, size), `LiveDot` (live boolean, size), `StateDot` (state), `Segmented`
(generic options, `layoutId` pill), `TabList` (view tabs pattern, `role=tablist`),
`ScrollArea` (radix), `Tooltip` (radix, 300 ms delay), `Popover` (radix), `EmptyState` (icon,
title, hint), `RelativeTime` (uses `useNow`), `Duration` (start, end|null → live ticking),
`CopyButton`, `Kbd`, `Spinner`, `KindIcon` (kind, optional tool category; icons from
design-system §7.3/§7.4), `ToolBadge` (ToolCallInfo → icon + name + MCP server badge),
`StatusGlyph` (ActivityStatus → spinner/check/x/dashed circle), `DiffView` (`FileDiff` →
renders unified / new-file / patch-text with gutters and design-system §7.5 colors; `maxLines`
with "show all"), `Markdownish` (safe minimal rendering: paragraphs, `code` fences with
language label, inline code, **bold**, *italic*, links as `<a target=_blank rel=noreferrer>`,
lists; never `dangerouslySetInnerHTML`), `useSpotlight()` (cursor spotlight vars).

### 4. API — `api/client.ts`, `api/sse.ts`, `api/mock.ts`

- `api.get<R extends ApiRoute>(route: R, opts?: { params?: Record<string, string|number|boolean|undefined>; path?: Record<string,string>; signal?: AbortSignal }): Promise<ApiResponses[R]>` — builds the URL (encodes path ids), throws `ApiRequestError {status, code, message}` on non-2xx.
- `connectStream({ since, onEvent, onState }) → { close() }` — `EventSource('/api/stream?since=…')`;
  `onopen` → `live`, `onerror` → `reconnecting` (EventSource auto-retries with
  `Last-Event-ID`); parse each `message` as `StreamEvent`; malformed → ignore + console.warn once.
- `mock.ts` — `createMockBackend({ now?, seed? })` implementing the same surface as the real API
  (`get(route, opts)`) and `connect(onEvent)`; enabled when `location.search` contains
  `mock=1` (the API module switches implementation). Data must be realistic and exercise every
  UI state:
  - 3 workspaces (`acme-android` main, `insights-agent`, `orca-command-center`), 6 roots:
    one `working` OpenCode `build` root with 6 subagents (2× `explore`, 3× `sonnet-coder`,
    1× `pm-reviewer`; mixed working/done/error), one `blocked` (permission via Orca hook), one
    `waiting` (question), one `done`, one `idle`, one Copilot CLI root (`working`).
  - Activity of every kind incl. MCP (`atlassian_jira_get_issue`, `github_create_pull_request`,
    `bitrise_get_build_log` with an error), edits with real-looking unified diffs, a write of
    `Plan.md`, thinking with multi-line text, todos, step usage, orchestration messages, state
    transitions; a PR URL in assistant text.
  - Orca snapshot (running pid 97499, worktrees, terminals, hooks), an orchestration run with 6
    tasks/deps/dispatches and one blocking gate, plus the "3 ready tasks, no deps" run.
  - Attention items of each kind; stats with a plausible 60-minute histogram.
  - Live: every ~800 ms emit `activity` (tool started → completed, thinking, MCP), every ~6 s
    spawn a subagent or flip a state, update stats every 5 s; each frame carries an increasing
    `seq`.
  - Every REST route returns consistent data for any id the mock produced (trees, transcripts
    with paging, parts, diffs, file changes, artifacts, runs, tasks).

### 5. Store — `state/store.ts` (zustand, no middleware except `subscribeWithSelector`)

```ts
export type ViewId = 'dag' | 'timeline' | 'stream' | 'changes' | 'overview'
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline'
export interface Loadable<T> { status: 'idle'|'loading'|'ready'|'error'; data: T | null; error: string | null; fetchedAt: number | null }
export interface StreamFilters { scope: 'all'|'tree'|'session'; kinds: ActivityKind[]; harness: Harness|'all'; query: string; errorsOnly: boolean; follow: boolean; paused: boolean }

export interface OccState {
  meta: ServerMeta | null; bootstrapped: boolean; connection: ConnectionState; lastEventAt: number | null; seq: number
  sessions: Record<string, SessionSummary>
  activity: { byId: Record<string, ActivityEvent>; order: string[]; version: number }   // order: by ts asc; ≤ 20k
  orca: OrcaSnapshot | null; attention: AttentionItem[]; stats: FleetStats | null; orchestration: OrchestrationSummary | null
  details: Record<string, Loadable<SessionDetail>>            // by sessionId
  trees: Record<string, Loadable<SessionTree>>                // by rootId
  transcripts: Record<string, Loadable<TranscriptPage>>       // by sessionId (pages merged)
  parts: Record<string, Loadable<PartDetail>>
  diffs: Record<string, Loadable<FileDiff>>
  fileChanges: Record<string, Loadable<FileChange[]>>         // key 'root:<id>' | 'session:<id>' | 'all'
  artifacts: Record<string, Loadable<Artifact[]>>             // key 'root:<id>' | 'all'
  scopedActivity: Record<string, Loadable<ActivityPage>>      // key 'root:<id>' | 'session:<id>'
  runs: Record<string, Loadable<OrchRunDetail>>
  tasks: Record<string, Loadable<OrchTaskDetail>>
  ui: {
    view: ViewId; selectedRootId: string | null; selectedSessionId: string | null; selectedActivityId: string | null
    selectedRunId: string | null; selectedTaskId: string | null
    liveOnly: boolean; harnessFilter: Harness | 'all'; railQuery: string
    theme: 'light' | 'dark'; dockWidth: number; paletteOpen: boolean; shortcutsOpen: boolean
    streamFilters: StreamFilters
    dagDirection: { session: 'RIGHT'|'DOWN'; orchestration: 'RIGHT'|'DOWN' }
    collapsedWorkspaces: Record<string, boolean>
  }
  // lifecycle
  init(): Promise<void>                           // bootstrap + connect stream (real or mock)
  applyBootstrap(b: BootstrapPayload): void
  applyStreamEvent(e: StreamEvent): void
  setConnection(c: ConnectionState): void
  // selection & ui
  selectSession(id: string | null, opts?: { activityId?: string }): void   // sets selectedRootId to its root
  selectRoot(id: string | null): void
  selectActivity(id: string | null): void
  selectRun(id: string | null): void
  selectTask(id: string | null): void
  selectAdjacentRoot(delta: 1 | -1): void          // over the visible, filtered rail order
  selectAdjacentCast(delta: 1 | -1): void          // over the selected root's descendants
  setView(v: ViewId): void
  setLiveOnly(v: boolean): void; setHarnessFilter(h: Harness | 'all'): void; setRailQuery(q: string): void
  setTheme(t: 'light'|'dark'): void; toggleTheme(): void; setDockWidth(px: number): void
  setPaletteOpen(v: boolean): void; setShortcutsOpen(v: boolean): void
  setStreamFilters(p: Partial<StreamFilters>): void
  setDagDirection(kind: 'session'|'orchestration', d: 'RIGHT'|'DOWN'): void
  toggleWorkspaceCollapsed(key: string): void
  // fetchers: dedupe in-flight, keep stale data while refreshing, store errors
  fetchSessionDetail(id: string, o?: { force?: boolean }): Promise<void>
  fetchTree(rootId: string, o?: { force?: boolean }): Promise<void>
  fetchTranscript(sessionId: string, o?: { older?: boolean; force?: boolean }): Promise<void>
  fetchPart(id: string): Promise<void>
  fetchDiff(id: string): Promise<void>
  fetchFileChanges(scope: { rootId?: string; sessionId?: string }, o?: { force?: boolean }): Promise<void>
  fetchArtifacts(scope: { rootId?: string }, o?: { force?: boolean }): Promise<void>
  fetchScopedActivity(scope: { rootId?: string; sessionId?: string }, o?: { older?: boolean; kinds?: ActivityKind[]; force?: boolean }): Promise<void>
  fetchRun(id: string, o?: { force?: boolean }): Promise<void>
  fetchTask(id: string, o?: { force?: boolean }): Promise<void>
}
export const useOcc: UseBoundStore<…>   // zustand hook
```

`applyStreamEvent` merge rules:
- `hello`: if `meta.bootId` differs from the current meta's bootId → resync (refetch bootstrap).
- `resync`: refetch bootstrap, replace state data, keep `ui`.
- `activity`: upsert by id when `rev >=` existing; keep `order` sorted by `ts` (insert by binary
  search); cap 20k (drop oldest); bump `activity.version`. Also merge into loaded
  `transcripts[sessionId]` (into the message with `messageId`, appending a placeholder message
  when unknown) and into loaded `scopedActivity` entries whose scope contains the event
  (`session:<sessionId>` or `root:<rootId>`).
- `sessions`: upsert/remove; for loaded `trees[rootId]`, add/update nodes and add an edge
  `{from: parentId, to: id, label: spawn?.description}` for new children.
- `orca`: shallow merge; `attention`, `stats`, `orchestration`, `meta`: replace. When an
  orchestration event lists `changedRunIds` that are loaded in `runs`, refetch them.
- Always update `seq`, `lastEventAt`.
- Default selection after the first bootstrap per Plan §7.2 (unless the URL selected one).
- Persist `theme`, `dockWidth`, `liveOnly`, `harnessFilter`, `streamFilters` (except
  `paused`), `dagDirection`, `collapsedWorkspaces` to localStorage (`occ-*` keys); theme also
  toggles the `dark` class on `<html>`.

`state/selectors.ts` (pure, memoization-friendly; with unit tests):
`selectRootSessions(s)` (window roots after `liveOnly`/`harnessFilter`/`railQuery`, sorted by
`AGENT_STATE_PRIORITY` then `lastActivityAt` desc), `selectWorkspaceGroups(s)` →
`Array<{ workspace: WorkspaceRef; roots: SessionSummary[]; liveCount: number; needsYou: number }>`,
`selectDescendants(s, rootId)` (DFS via `childIds`, depth order), `selectSelectedSession(s)`,
`selectFleetPulse(s)` → `{ working, needsYou, idle, live, total }`, `selectActivityForScope(s,
scope)` (ids filtered from the ring), `selectSessionAncestors(s, id)`.

`state/url.ts`: read `?s=&v=&r=&t=&mock=` at init; subscribe to `ui` and `replaceState`
(keep `mock=1` when present).

### 6. Hooks — `hooks/`

`useNow(intervalMs = 1000)` (one shared ticking clock store; components re-render only on the
interval they ask for), `useInterval`, `useDebouncedValue`, `useElementSize`,
`useGlobalHotkeys.ts` placeholder: `export function useGlobalHotkeys(): void {}` (Task-16).

### 7. Shell — `shell/`

- `Shell.tsx`: layout per design-system §8 (field background, header, banner, rail, center
  column with `<AttentionStrip/>`, `<ViewTabs/>`, active view in a panel, dock). Responsive
  compact mode below `lg` (rail/dock fold-out bands) — a basic version is enough here;
  Task-16 polishes.
- `Header.tsx`: design-system §8.1 in full — logo, name, Orca pill (`meta.orca` / `orca.status`),
  stream pill (`connection`), fleet pulse (`selectFleetPulse`; "needs you" opens the dock
  attention panel by clearing selection), source chips with a Popover listing each
  `SourceHealth` (status, path, version, detail, last read/change), "Last event Ns ago",
  ⌘K button (`setPaletteOpen(true)`), theme toggle.
- `Banner.tsx`: lines for: Orca not running; each source with status `error`/`degraded`/
  `missing` (one sentence each using `detail`); orchestration `degraded[]` and newer schema.
  Hidden when nothing to say.
- `ViewTabs.tsx`: the five views with icons and keyboard-accessible `role=tab`s; DAG tab label
  switches to "Run DAG" when a run is selected.
- `CenterView.tsx`: renders the active view component inside the view panel; wraps each view in
  an error boundary showing an `EmptyState` with the error and a "Retry" button.
- `Dock.tsx`: resizable (drag handle on the left edge, 320–640 px, persisted); renders
  `<Inspector/>` when `selectedSessionId` or `selectedTaskId` is set, else `<AttentionPanel/>`.
- `Splash.tsx`: design-system splash ("Connecting to Orca…", shimmer) until `bootstrapped`; if
  bootstrap fails, show the error and retry every 3 s.
- `App.tsx`: `<MotionConfig reducedMotion="user">`, `Tooltip.Provider`, `useGlobalHotkeys()`,
  `<CommandPalette/>`, `<Shell/>`; calls `useOcc.getState().init()` once.

### 8. Placeholders (exact exports — later tasks replace the bodies)

Each renders an `EmptyState` naming the feature and its task, e.g. "Stream view — Task-12":
`export function Rail()`, `DagView()`, `TimelineView()`, `StreamView()`, `ChangesView()`,
`OverviewView()`, `Inspector()`, `AttentionStrip()` (returns `null` when no attention items),
`AttentionPanel()`, `CommandPalette()` (returns `null`). The Rail placeholder should at least
list root session titles so the shell is usable for manual testing.

### 9. Tests — `test/client/setup.ts` + co-located tests

Setup: `@testing-library/jest-dom/vitest`, `matchMedia`/`ResizeObserver`/`EventSource` stubs.
Helper `test/client/render.tsx`: `renderWithMockStore(ui, { bootstrap?, uiState? })` that resets
the zustand store, applies a mock bootstrap, and renders. Tests: format/diff utils, selectors,
store `applyStreamEvent` (upsert/rev, cap, tree edge insertion, transcript merge), header
renders pills and source popover, banner lines, dock switching, splash → shell after bootstrap
with the mock backend.

## Acceptance

- `npm run dev:client` then `http://localhost:5173/?mock=1` shows the full shell in dark mode
  with live-updating header pulse, placeholder views/rail/inspector, working theme toggle, view
  tabs and resizable dock. (The server is not required in mock mode.)
- `npm run typecheck` clean for owned files; `npx vitest run src/client test/client` green;
  `npm run build:client` succeeds.

## Report

Summary, files, tests + results, a short description of the mock fleet, any contract
ambiguities you resolved, deviations.
