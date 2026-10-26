# Task-16 — Command palette, shortcuts, URL state, polish

**Wave:** C (parallel with 8–15) · **Size:** M · **Depends on:** Task-7

## Goal

Make the console fast to drive and pleasant at every size: a ⌘K command palette, global
keyboard shortcuts with a help overlay, robust deep links, and a polished responsive/compact
layout and accessibility pass over the shell.

## Read first

- `docs/design-system.md` §5 (breakpoint), §8 (shell), §12 (motion), §13
- `Plan.md` §6 (F11, F12), §7.6 (keys & URL — normative), §11 (a11y)
- Task-7 code: `App.tsx`, `shell/**`, `state/{store,selectors,url}.ts`, `hooks/**`, `ui/**`

## Ownership

`src/client/palette/**` (replace the placeholder; keep `export function CommandPalette()`),
`src/client/hooks/useGlobalHotkeys.ts` (replace the placeholder body; keep the export), plus
**refinements** to `src/client/shell/**`, `src/client/App.tsx` and `src/client/state/url.ts`
(you are the only Wave C task allowed to touch these; keep their public exports stable). Do not
edit rail/views/inspector/attention folders.

## Requirements

1. **Command palette** (`cmdk` inside a radix Dialog, `.panel` styling, opens with ⌘K/Ctrl+K and
   the header button, closes with Esc):
   - Groups: **Needs you** (attention items), **Live sessions**, **Sessions** (all in window;
     matches title, agent, workspace, directory, id prefix), **Workspaces** (select → filter
     rail via `setRailQuery`), **Orchestration runs**, **Views** (DAG, Timeline, Stream,
     Changes, Overview), **Actions** (Toggle theme, Toggle Live only, Toggle stream follow,
     Clear selection, Show shortcuts, Copy link to current view).
   - Rows show icons/monograms, state dots, and right-aligned hints (workspace, relative time,
     shortcut). Empty: "No matches".
2. **Global hotkeys** (`useGlobalHotkeys`), ignored while typing in inputs/textareas/
   contenteditable (except Esc): Plan §7.6 — `⌘K/Ctrl+K`, `1–5`, `j/k` (`selectAdjacentRoot`),
   `J/K` (`selectAdjacentCast`), `Esc` (close palette/help → clear task → clear session →
   clear run), `/` (focus `#rail-search`), `.` (Live only), `f` (stream follow), `space`
   (stream pause, only when the Stream view is active), `t` (theme), `?` (shortcuts overlay).
3. **Shortcuts overlay** (`shortcutsOpen`): a Dialog listing all shortcuts with `Kbd` chips.
4. **URL state** (`state/url.ts`): robust parse/serialize of `s`, `v`, `r`, `t` (+ preserve
   `mock`); unknown ids are kept until bootstrap then dropped with a toast-like inline notice
   in the banner area ("Session … is outside the 24 h window" → still try
   `fetchSessionDetail`); back/forward (`popstate`) restores selection.
5. **Responsive compact layout** (< 1024 px, design-system §5): header condenses (hide source
   chips and last-event behind a "Sources" popover), rail and dock become fold-out bands with
   chevrons (rail max 45dvh, dock max `min(60dvh, 32rem)`), view tabs scroll horizontally,
   minimap/legend hidden (views read a `compact` flag — expose `useCompact()` from
   `src/client/hooks/useCompact.ts` (you own this new file)).
6. **Accessibility pass on the shell**: landmarks (`header`, `nav`, `main`, `aside`), skip link
   "Skip to view", focus management when the dock switches content (focus the inspector title),
   visible focus rings everywhere in the shell, `aria-live="polite"` region for connection state
   changes, color-contrast check of status pills in both themes (adjust only shell styles).
7. **Polish**: favicon reflects attention (draw a small orange dot on the radar favicon when
   `attention` has high-severity items, via a canvas-generated data URI); document title
   `"(N) Orca Command Center"` when N items need you.

## Tests

Palette search/grouping and actions (select session, switch view, toggle theme), hotkeys
(including ignore-while-typing and Esc cascade), URL parse/serialize round trip and popstate,
compact layout toggles, document title/favicon updates.

## Acceptance

`?mock=1`: ⌘K finds sessions/runs/views and executes actions; all shortcuts work; reload keeps
the selection and view; narrow window shows the compact layout; keyboard-only navigation works
across header → rail → view → dock. Tests green (`npx vitest run src/client/palette
src/client/hooks src/client/shell src/client/state`), typecheck clean for owned files.

## Report

Summary, files, tests + results, deviations.
