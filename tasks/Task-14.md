# Task-14 — Changes & artifacts view

**Wave:** C (parallel with 8–13, 15, 16) · **Size:** M · **Depends on:** Task-7

## Goal

Answer "what did the agents change and produce?": a file tree of every file touched (by the
selected tree, or by everyone in the window) with per-file change history, attribution and
diffs; and an artifacts gallery (documents, new files, pull requests, links, images).

## Read first

- `docs/design-system.md` §6, §7.5 (diff colors), §13 (icons)
- `Plan.md` §6 (F8), §7.3, §9.4 (artifact rules)
- Task-7 code: store (`fileChanges`/`fetchFileChanges`, `artifacts`/`fetchArtifacts`,
  `diffs`/`fetchDiff`, `sessions`, `selectSession`), `ui/DiffView.tsx`, `lib/diff.ts`, `ui/**`

## Ownership

`src/client/views/changes/**` (replace the placeholder; keep `export function ChangesView()`),
with co-located tests.

## Requirements

1. **Header:** Segmented scope "This tree · All agents" (tree disabled without a selected root);
   Segmented tab "Files · Artifacts"; counts; refresh on the stream (refetch with `force` at most
   every 10 s while the scope has live sessions).
2. **Files tab — left pane (tree, ~40%):** group by `workspaceRoot` (workspace name header) →
   directories (collapsible, compacted single-child chains like `src/client/ui`) → files. File
   row: icon by extension, name, change count, `+a −d` totals (green/red tabular-nums), agent
   monogram stack (up to 3 + "+N"), last-change relative time; deleted/created markers. Filter
   input (path substring) and sort (recent · most changed · path).
3. **Files tab — right pane (history):** for the selected file, changes newest first: agent
   monogram, session title (click → `selectSession(sessionId, { activityId: change.id })`),
   tool, kind badge (edit/write/create/patch/delete), status, time, `+/−`; expand → `fetchDiff`
   → `DiffView` (first change expanded by default). Copy path button. Patch-snapshot changes
   show the note "changed during a step (e.g. via shell) — diff not recorded".
4. **Artifacts tab:** cards grouped by kind (Pull requests, Documents, New files, Links, Images,
   Reports) with icon, label, path/url (links open in a new tab with `rel=noreferrer`), session
   attribution (monogram + title), time; documents/new files have "Show in Changes" (switch to
   Files tab with that file selected).
5. **Empty states:** "No file changes in this scope yet.", "No artifacts yet."
6. Large scopes (≥ 2,000 changes): virtualize the file list.

## Tests

Tree building (grouping, compaction, totals, sorting), history ordering, diff expansion
triggers `fetchDiff`, artifacts grouping and link attributes, scope switching fetches the right
keys.

## Acceptance

`?mock=1`: files from the mock edits/writes appear with totals and attribution, diffs render,
the PR URL appears under Pull requests, the `Plan.md` write appears under Documents. Tests green
(`npx vitest run src/client/views/changes`), typecheck clean for owned files.

## Report

Summary, files, tests + results, deviations.
