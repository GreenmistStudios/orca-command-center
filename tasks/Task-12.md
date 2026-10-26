# Task-12 — Stream view (activity firehose)

**Wave:** C (parallel with 8–11, 13–16) · **Size:** L · **Depends on:** Task-7

## Goal

A live, virtualized, filterable firehose of everything every agent is doing — thinking, tool
calls, MCP calls, edits, subagent spawns, state changes, errors — across the fleet or scoped to
the selected tree/session. The "monitor" surface of the command center.

## Read first

- `docs/design-system.md` §7.3–7.4 (kinds, tool icons), §10.5 (stream rows — normative), §12
- `Plan.md` §6 (F6), §7.3 (Stream row), §7.6 (`f`, `space` keys are wired by Task-16 through
  store actions)
- Task-7 code: store (`activity` ring, `scopedActivity`/`fetchScopedActivity`,
  `ui.streamFilters`/`setStreamFilters`, `selectActivity`, `selectSession`), selectors
  (`selectActivityForScope`), `ui/**`

## Ownership

`src/client/views/stream/**` (replace the placeholder; keep `export function StreamView()`),
with co-located tests.

## Requirements

1. **Sources of rows:** scope `all` → the store ring (`activity.order`); scope `tree`/`session`
   → ring events for that scope merged with `scopedActivity` history (fetched on scope change;
   "Load older" fetches `older: true`). Dedupe by id, sort by `ts` ascending, newest at bottom.
2. **Filter bar** (sticky `.panel-header`): Segmented scope (All · This tree · This session —
   disabled without a selection); kind toggle chips with live counts and kind-color dots
   (Prompts, Thinking, Text, Tools, MCP, Files, Subagents, Todos, State, Permission, Errors,
   Orchestration; Steps off by default); harness select; "Errors only" toggle (status `error`
   or kind `error`); search box (matches title, summary, tool name, MCP server, file paths,
   session title; debounced 150 ms); Follow toggle (`arrow-down-to-line`); Pause toggle
   (`pause`/`play`). All persisted via `setStreamFilters`.
3. **Rows** (design-system §10.5): `HH:MM:SS`, agent monogram, session short title (click →
   `selectSession`), `KindIcon`, title with MCP server badge, status glyph + duration (live
   ticking for running items). Rows that arrive live animate in (`y:-6`, opacity) — not on
   initial render. Selected row (`selectedActivityId`) highlighted.
4. **Expand** a row (click or Enter): summary text (`pre`/Markdownish for text/thinking), tool
   input/output previews, files as chips, links; buttons "Open in inspector"
   (`selectSession(sessionId, { activityId })`) and "Full detail" (`fetchPart(detailRef)` →
   show inline).
5. **Follow & pause:** Follow on → stick to the bottom as rows arrive; user scroll-up turns
   Follow off and shows a floating chip "N new events ↓" that re-enables it. Pause freezes the
   visible list (buffering new arrivals; the chip shows the buffered count; Resume flushes).
6. **Virtualization:** `@tanstack/react-virtual` with dynamic row heights (collapsed rows 30 px);
   smooth with 20,000 rows; stable keys; no layout thrash when rows update in place (`rev`).
7. **Grouping hint:** when consecutive rows share a session, dim the repeated session label.
8. **Empty states:** no activity yet; filters exclude everything ("Clear filters").
9. Accessibility: the list is a `role="log"` with `aria-live="off"` (too chatty) plus a
   visually-hidden live region announcing only errors and attention-worthy items.

## Tests

Filtering (kinds, errors only, search, harness, scope), ordering/dedupe with `rev` updates,
follow/pause behavior (buffered count), expand shows details and the inspector link calls
`selectSession` with `activityId`, load older triggers `fetchScopedActivity`. Pure filter/
match functions unit-tested separately.

## Acceptance

`?mock=1`: the stream fills live, MCP rows show server badges, errors-only shows the failing
`bitrise_get_build_log`, follow/pause behave, 20k synthetic rows (add a dev-only test helper,
not shipped UI) scroll smoothly. Tests green (`npx vitest run src/client/views/stream`), typecheck
clean for owned files.

## Report

Summary, files, tests + results, deviations.
