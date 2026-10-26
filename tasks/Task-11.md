# Task-11 — Inspector dock

**Wave:** C (parallel with 8–10, 12–16) · **Size:** XL · **Depends on:** Task-7

## Goal

The right dock's inspector: everything about one agent session — live transcript with thinking,
tool calls, MCP calls, file edits (with diffs) and subagent spawns; its files, todos, and
identity/provenance — plus the orchestration task inspector. This is where "drill" happens.

## Read first

- `docs/design-system.md` §4, §6, §7 (kinds/tools/diff colors), §11 (dock — normative), §12
- `Plan.md` §6 (F5), §7.4 (inspector — normative), §7.7
- Task-7 code: store (`selectedSessionId`, `selectedTaskId`, `details`/`fetchSessionDetail`,
  `transcripts`/`fetchTranscript`, `parts`/`fetchPart`, `diffs`/`fetchDiff`, `tasks`/`fetchTask`,
  `selectSession`, `selectActivity`), `ui/**` (`KindIcon`, `ToolBadge`, `StatusGlyph`,
  `DiffView`, `Markdownish`, `Segmented`, tones), `lib/format.ts`

## Ownership

`src/client/inspector/**` (replace the placeholder; keep `export function Inspector()`), with
co-located tests.

## Requirements

### A. Session inspector

- **Header** (design-system §11): tinted by state accent; title; close (`selectSession(null)`);
  chips: state pill with provenance tooltip ("from Orca hook · SessionBusy 12s ago" / "from
  transcript"), harness tile + label, agent monogram + name, model (mono), elapsed
  (`Duration`), tokens (`formatTokens(input+output)`), cost; copy-id chip. Breadcrumb of
  ancestors for subagents (clickable). Live current-activity line under the title.
- **Tabs** (Segmented, `layoutId="inspector-tab"`): Activity · Files (count) · Todos
  (done/total) · Info. Remember the tab per session kind.
- **Activity tab** — transcript:
  - `fetchTranscript(id)` on open; "Load earlier" at the top (`older: true`); live items merged
    by the store; auto-follow at bottom while live with a "new activity below" chip when the
    user scrolled up. Virtualize when > 300 items (`@tanstack/react-virtual`, dynamic heights).
  - Items by kind:
    - `prompt` → right-aligned bubble (Markdownish), attachments as chips (filename).
    - `text` → left bubble (Markdownish), links clickable.
    - `thinking` → collapsed row: brain icon, "Thinking · <duration>", first line muted italic;
      expand to full text (fetch part detail if `summary` truncated).
    - `tool` / `mcp` → compact card: `ToolBadge`, input preview (mono), `StatusGlyph`, duration;
      MCP shows the server badge prominently; click expands → `fetchPart(detailRef)` → pretty
      input JSON, output `pre` (with "copy"), error in red. Running tools show the live output
      preview and a spinner.
    - `file-change` → card: file icon, relative path(s), `+a −d`, status; expand →
      `fetchDiff(id)` → `DiffView`.
    - `subagent` → card: agent monogram + subagent type, description, status; click →
      `selectSession(childSessionId)`.
    - `todo` → compact checklist snapshot (from the item's tool input if present, else link to
      the Todos tab).
    - `step` → hidden unless "Show steps" toggle; thin separator with tokens/cost.
    - `state`/`permission`/`error`/`orchestration` → system rows (icon + text, muted; errors
      red).
  - Day separators; message headers (agent · model · time · tokens/cost for assistant messages;
    `error` shown as a red banner on the message).
  - `selectedActivityId` → scroll into view + highlight ring (set by stream/timeline/DAG).
- **Files tab**: `details[id].fileChanges` (toggle "include subagents" → use the tree's
  sessions via `fetchFileChanges({ rootId })` filtered to descendants) grouped by path with
  counts; expand → `DiffView`.
- **Todos tab**: `details[id].todos` with status icons (`circle`, `loader-circle` animated,
  `circle-check`, `circle-slash`), priority dot, content.
- **Info tab**: key/value grid — ids (copy), harness/agent/model, directory/workspace (repo,
  branch), created/updated/last activity, token breakdown (input/output/reasoning/cache
  read/write), cost, counters, `facts`, Orca link (worktree, terminal handle/title, paneKey,
  hook event/state/time, orchestration role/run/task/dispatch with buttons to select the run/
  task), spawn info, provenance list.
- Refresh: `fetchSessionDetail(id)` on open and when the session's `updatedAt` changes
  (throttle 3 s).

### B. Orchestration task inspector (`selectedTaskId`)

orca-viz parity: header (title, status chip, attempts, duration, copy id), sections Spec
(`pre`), Result, Dispatch attempts (vertical dot-and-line timeline: status, assignee (linked
session button), dispatched/completed/heartbeat, failures, termination reason), Messages
(thread list with type chips), Gates (question, options, status/resolution), Depends on /
Blocks (clickable task chips).

### C. States

Loading skeletons (shimmer lines), errors with retry, "Session not found" (outside window and
unknown), empty transcript ("No activity recorded yet.").

## Tests

With the mock store: header chips and provenance tooltip, tab switching, transcript renders each
item kind, expanding a tool card fetches and shows detail, file-change expands to a diff,
subagent card selects the child, steps toggle, task inspector sections.

## Acceptance

`?mock=1`: selecting the working root shows a live-appending transcript (tools completing,
thinking blocks, MCP calls with server badges), diffs render with colors, subagent navigation
and breadcrumbs work, task inspector renders for the mock run. Tests green
(`npx vitest run src/client/inspector`), typecheck clean for owned files.

## Report

Summary, files, tests + results, deviations.
