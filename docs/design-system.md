# Design system — Orca Command Center

The command center must look like a sibling of **orca-viz** (dark, dense "command console"):
same tokens, same panel recipes, same type scale, same motion. Values in §1–§6 are copied from
orca-viz 0.7.0's built CSS (`App-D6pZt35n.css`) and component class strings. §7 onwards are
command-center additions built from the same vocabulary.

> Rule of thumb: if orca-viz has a pattern for it, copy it. If not, compose it from these tokens.

---

## 1. Theme mechanics

- Dark mode = class `dark` on `<html>`. An inline script in `index.html` runs before first
  paint, reads `localStorage['occ-theme']` (`light` | `dark`), falls back to
  `prefers-color-scheme`. `<meta name="color-scheme" content="light dark">`.
- Tailwind v4: `@custom-variant dark (&:where(.dark, .dark *));` and an `@theme inline` block
  mapping every token below to `--color-*` so utilities like `bg-panel`, `text-muted-foreground`,
  `border-panel-border`, `bg-status-working-soft` exist.
- Opacity modifiers (`bg-selection/15`) compile to `color-mix(in oklab, var(--x) 15%, transparent)`.
- Base: `body { background: var(--field); color: var(--foreground); overflow: hidden; -webkit-font-smoothing: antialiased }`,
  `* { border-color: var(--border); scrollbar-width: thin; scrollbar-color: var(--border) transparent }`.
- No webfonts.
  - Sans: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
  - Mono: `ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace`

## 2. Surface & text tokens (exact)

| Token | Role | Light | Dark |
|---|---|---|---|
| `--field` | app background (deepest) | `oklch(95.5% .003 286.3)` | `oklch(11.5% .008 274)` |
| `--background` | inputs/buttons, inverted text | `oklch(99.5% 0 0)` | `oklch(15.5% .006 274)` |
| `--panel` | translucent panels (header/rail/dock/pills) | `oklch(100% 0 0 / .86)` | `oklch(20.5% .008 274 / .72)` |
| `--panel-solid` | canvas, cards, minimap, controls | `oklch(100% 0 0)` | `oklch(20.5% .008 274)` |
| `--muted` | segmented track, code blocks, neutral pills | `oklch(97.3% .001 286.4)` | `oklch(25% .008 274)` |
| `--accent` | hover background | `oklch(96.7% .001 286.4)` | `oklch(29% .01 274)` |
| `--panel-border` | panel borders, dividers | `oklch(90% .004 286.3)` | `oklch(32% .009 274)` |
| `--border` | default border, scrollbar thumb | `oklch(92% .004 286.3)` | `oklch(32% .009 274)` |
| `--input` | input border | `oklch(92% .004 286.3)` | `oklch(34% .01 274)` |
| `--foreground` | primary text | `oklch(21% .006 285.9)` | `oklch(96% .001 286.4)` |
| `--muted-foreground` | secondary text (tertiary = /80 /70 /60) | `oklch(55.2% .014 285.9)` | `oklch(70% .014 280)` |
| `--primary` / `--primary-foreground` | logo tile | `oklch(21% .006 285.9)` / `oklch(98.5% 0 0)` | `oklch(92% .004 286.3)` / `oklch(21% .006 285.9)` |
| `--selection` (= `--ring`) | accent blue: selection, focus, chips | `oklch(62% .19 259.8)` | same |
| `--selection-soft` | selected row/chip bg | `oklch(97% .014 254.6)` | `oklch(32% .07 258.4)` |
| `--selection-ink` | chip text | `oklch(42% .16 264.4)` | `oklch(93% .03 255.5)` |
| `--destructive` | errors | `oklch(57.7% .245 27.3)` | `oklch(66% .2 25.3)` |
| `--grid-line` | field grid lines | `oklch(21% .006 285.9 / .045)` | `oklch(96% .001 286.4 / .035)` |
| `--field-glow` | top radial glow | `oklch(62% .19 259.8 / .06)` | `oklch(62% .19 259.8 / .1)` |
| `--sheen` | inset top highlight on nodes | `oklch(100% 0 0 / .75)` | `oklch(100% 0 0 / .07)` |
| `--glow-strength` / `--spotlight-strength` | effect multipliers | `.42` / `.1` | `.85` / `.16` |
| `--radius` | base radius | `.625rem` (10px) | — |

Shadows:

```css
/* light */
--lift-1: 0 1px 2px oklch(21% .006 285.9/.05), 0 1px 1px oklch(21% .006 285.9/.04);
--lift-2: 0 2px 4px oklch(21% .006 285.9/.04), 0 6px 16px -4px oklch(21% .006 285.9/.08), 0 0 0 1px oklch(21% .006 285.9/.03);
/* dark */
--lift-1: 0 1px 2px oklch(0% 0 0/.4);
--lift-2: 0 2px 6px oklch(0% 0 0/.35), 0 8px 24px -6px oklch(0% 0 0/.5), 0 0 0 1px oklch(100% 0 0/.03);
```

## 3. Status palette (`--status-*`)

Base hue is the same in both modes; `soft` = fill, `ink` = text on that fill.

| Status token | Base | Light soft / ink | Dark soft / ink |
|---|---|---|---|
| `pending` | `#a1a1aa` | `#f4f4f5` / `#3f3f46` | `#27272a` / `#d4d4d8` |
| `ready` | `#3b82f6` | `#dbeafe` / `#1e3a8a` | `#172554` / `#bfdbfe` |
| `dispatched` | `#f59e0b` | `#fef3c7` / `#78350f` | `#431f07` / `#fde68a` |
| `completed` | `#22c55e` | `#dcfce7` / `#14532d` | `#052e16` / `#bbf7d0` |
| `failed` | `#ef4444` | `#fee2e2` / `#7f1d1d` | `#450a0a` / `#fecaca` |
| `blocked` | `#a855f7` | `#f3e8ff` / `#581c87` | `#2e1065` / `#e9d5ff` |
| `unknown` | `#71717a` | `#e4e4e7` / `#27272a` | `#3f3f46` / `#e4e4e7` |
| `gate` | `#f97316` | `#ffedd5` / `#9a3412` | `#431407` / `#fed7aa` |

A **tone** = four class groups: `surface` = `bg-status-X-soft text-status-X-ink border-status-X`,
`accent` = `var(--status-X)`, `dot` = `bg-status-X`, `border` = `border-status-X`.

Fixed warning text colors: amber-700 `#bb4d00` / amber-400 `#ffb900` (retries, stale); red-700
`#c10007` / red-400 `#ff6467` (failure counts).

### 3.1 Command-center tone mapping

| Domain value | Tone token | Extra treatment |
|---|---|---|
| AgentState `working` | `dispatched` (amber) | LiveDot + rotating alive ring on nodes |
| AgentState `blocked` | `gate` (orange) | `octagon-alert` icon, counts as "needs you" |
| AgentState `waiting` | `blocked` (purple) | `message-circle-question` icon, "needs you" |
| AgentState `error` | `failed` (red) | `circle-x` icon |
| AgentState `done` | `completed` (green) | `circle-check` icon |
| AgentState `idle` | `pending` (grey) | — |
| AgentState `unknown` | `unknown` (zinc) | dashed border |
| Orch task `pending/ready/dispatched/completed/failed/blocked` | same-named token (exactly orca-viz) | dispatch `circuit_broken` → `failed` |
| ActivityStatus `running` | `dispatched` | spinner (`loader-circle` animate-spin) |
| ActivityStatus `completed` | `completed` | `check` |
| ActivityStatus `error` | `failed` | `x` |
| ActivityStatus `pending` | `pending` | `circle-dashed` |

## 4. Typography (exact sizes)

| Use | Spec |
|---|---|
| Header app name | 14px/20px semibold, tracking-tight |
| Section headers ("FLEET", "INSPECTOR") | 11px semibold uppercase, tracking .1em, muted |
| Sub-sections ("THE CAST", inspector headings) | 10px semibold uppercase, tracking .1em, muted/60 |
| Pills, chips, segmented buttons, tabs, counts | 11px medium; counts `tabular-nums` muted/70 |
| Version badge "v43" | mono 10px outline badge (`rounded-full border px-1.5 py-0`) |
| Rail row title | 13px semibold, truncate |
| Rail mono line | mono 10.5px muted/80 |
| Rail meta line | 11px muted, `·` separators at opacity .4 |
| Node status label ("WORKING") | 9px bold uppercase, tracking .09em, opacity .8 |
| Node title | 11.5px medium, leading-tight, `line-clamp-2` |
| Node meta | 9–10px, opacity .6 (mono for activity line) |
| Node markers (`↻N`, `✗N`) | 10px bold |
| Monograms | 8.5px (17px tile), 9.5px (20px tile), 10px (24px tile), mono bold |
| Body / bubble text | 12.5px, leading-relaxed |
| Turn header, provenance caption | 10px (caption mono, muted/70) |
| Kind chip | mono 9.5px bold, `rounded px-1.5` |
| Dock title | 13px semibold, tracking-tight; subtitle 11px muted |
| Code/pre blocks | mono 11px, leading-relaxed |
| Empty states, banners | 12px |

Line heights: tight 1.25, snug 1.375, relaxed 1.625. Tracking: widest .1em, tight −.025em.

## 5. Shape, spacing, metrics

- Radii: 4px (timeline bars, kind chips) · 8px `md` (buttons, monograms, segmented items) ·
  10px `lg` (rail rows, code blocks) · **14px `xl`** (panels, node cards, minimap, banners) ·
  16px `2xl` (regions, splash tile) · full (pills, chips).
- Spacing base 4px. Shell padding 8px, gap 8px. Panel header `px-4 py-3`.
- Fixed sizes: header **52px** (`h-13`); left rail **18rem = 288px**; right dock **24rem = 384px**
  (orca-viz uses 22rem; the inspector needs more room — resizable 320–640px, persisted);
  orchestration task node **240×84**; session node **264×96**; live dot 6px (8px in rail);
  icon buttons 28px; header buttons 28px tall.
- Breakpoint `lg` = 64rem. Below it the layout stacks (rail and dock become 48px fold-out bands),
  minimap and legend hide, touch targets grow to 40px.

## 6. Recipes (orca-viz class strings — implement as `@layer components` classes or helpers)

```text
panel        = rounded-xl border border-panel-border bg-panel shadow-lift-2 backdrop-blur-xl
shell        = relative isolate flex h-full flex-col gap-2 bg-field p-2
fieldBg      = radial-gradient(60% 50% at 50% 0%, var(--field-glow), transparent),
               linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
               linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)
               / 100% 100%, 32px 32px, 32px 32px   (absolute inset-0 -z-10 behind the shell)
panelHeader  = flex shrink-0 flex-col gap-2.5 border-b border-panel-border/70 px-4 py-3
sectionLabel = text-muted-foreground text-[11px] font-semibold tracking-widest uppercase
floatPill    = bg-panel border-panel-border shadow-lift-2 rounded-full border backdrop-blur-xl
chip         = inline-flex items-center gap-1 rounded-full border border-selection/35 bg-selection-soft
               px-2 py-0.5 text-[11px] font-medium text-selection-ink hover:border-selection/60
statusPill   = flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium
neutralPill  = text-muted-foreground bg-muted border-transparent
monogram     = flex shrink-0 items-center justify-center rounded-md font-mono font-bold tracking-tight
focus        = focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none
segTrack     = bg-muted/70 rounded-lg p-0.5 gap-0.5 ; segItem = flex-1 rounded-md px-2 py-1 text-[11px] font-medium
segActive    = motion span layoutId pill: bg-panel-solid shadow-lift-1 rounded-md (200ms slide)
viewTab      = flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium ;
               active: bg-selection/15 text-foreground ; idle: text-muted-foreground hover:text-foreground
pre          = bg-muted/60 border border-panel-border/60 rounded-lg p-2.5 font-mono text-[11px] leading-relaxed max-h-56 overflow-auto
```

## 7. Command-center palettes

### 7.1 Agent stripe palette (8 colors, by stable hash of the agent name)

Agent identity (e.g. `build`, `sonnet-coder`, `explore`, `prr-validator`) → color via
`hash(name) % 8`, so the same agent type always has the same color across views.
`--agent-ink` (monogram text) = `#fff` light / `#09090b` dark.

| # | Light | Dark |
|---|---|---|
| 1 teal | `#0d9488` | `#2dd4bf` |
| 2 pink | `#db2777` | `#f472b6` |
| 3 indigo | `#4f46e5` | `#a5b4fc` |
| 4 stone | `#57534e` | `#a8a29e` |
| 5 cyan | `#0891b2` | `#67e8f9` |
| 6 lime | `#65a30d` | `#bef264` |
| 7 fuchsia | `#c026d3` | `#f0abfc` |
| 8 rose | `#e11d48` | `#fda4af` |

Stripe: 4px pill, `box-shadow: 0 0 10px 0 color-mix(in oklch, AGENT 55%, transparent)`. Unknown
agent: `color-mix(in oklch, currentColor 22%, transparent)`.

Agent monogram text = first two letters of the agent name, uppercased (`sonnet-coder` → `SC`
using initials of hyphen/space parts when ≥ 2 parts, else first two letters).

### 7.2 Harness tiles

| Harness | Monogram | Light bg / fg | Dark bg / fg |
|---|---|---|---|
| opencode | OC | `var(--foreground)` / `var(--background)` | same (inverted tile like orca-viz's orchestrator tile) |
| copilot | CP | `#6d28d9` / `#fff` | `#a78bfa` / `#09090b` |
| claude | CC | `#c2410c` / `#fff` | `#fdba74` / `#09090b` |
| codex | CX | `#047857` / `#fff` | `#6ee7b7` / `#09090b` |
| unknown | ?? | `var(--muted)` / `var(--muted-foreground)` | same |

### 7.3 Activity kind colors (`--kind-*`)

| Kind | Light | Dark | Lucide icon |
|---|---|---|---|
| prompt | `#0284c7` | `#7dd3fc` | `message-square-text` |
| thinking | `#7c3aed` | `#c4b5fd` | `brain` |
| text | `var(--muted-foreground)` | same | `message-square` |
| tool | `#2563eb` | `#93c5fd` | by category (§7.4) |
| mcp | `#0d9488` | `#5eead4` | `plug` |
| file-change | `#16a34a` | `#86efac` | `file-diff` |
| subagent | `#db2777` | `#f9a8d4` | `bot` |
| todo | `#475569` | `#cbd5e1` | `list-checks` |
| step | `var(--muted-foreground)` | same | `footprints` |
| state | `#d97706` | `#fcd34d` | `activity` |
| permission | `#f97316` | `#fdba74` | `shield-alert` |
| error | `#dc2626` | `#fca5a5` | `circle-x` |
| orchestration | `#4f46e5` | `#a5b4fc` | `waypoints` |

### 7.4 Tool category icons (lucide)

shell `square-terminal` · read `file-text` · search `search` · edit `file-pen-line` ·
write `file-plus` · patch `file-diff` · web `globe` · subagent `bot` · todo `list-checks` ·
question `message-circle-question` · skill `sparkles` · mcp `plug` · plugin `puzzle` · other `wrench`.
MCP calls additionally show a server badge: mono 9.5px `rounded px-1.5` in the mcp kind color
(e.g. `atlassian`).

### 7.5 Diff colors

Added line bg `color-mix(in oklch, var(--status-completed) 14%, transparent)`, text
`var(--status-completed-ink)`; removed line bg `color-mix(in oklch, var(--status-failed) 14%,
transparent)`, text `var(--status-failed-ink)`; hunk header muted/70 on `bg-muted/60`; gutter mono
10px muted/60. Font mono 11px.

## 8. Shell layout

```text
main.shell ┬ fieldBg layer (absolute, -z-10)
           ├ Header (panel, h-13)
           ├ Banner (only when a source is degraded / Orca stopped / schema newer)
           └ div.flex.gap-2.min-h-0.flex-1
               ├ Rail  <nav> panel w-[18rem]           ── FLEET + ORCHESTRATIONS
               ├ Center column (flex-1 flex-col gap-2)
               │    AttentionStrip? (only when items)
               │    ViewTabs row (justify-end): DAG · Timeline · Stream · Changes · Overview
               │    View panel (panel bg-panel-solid, fills)
               └ Dock <aside> panel w-[24rem] (resizable) ── Inspector | Attention panel
```

### 8.1 Header (left → right)

1. Logo tile 24px `rounded-md bg-primary text-primary-foreground`, `box-shadow: 0 0 18px -4px
   var(--selection)`, lucide `radar` 14px.
2. App name "Orca Command Center" (14px semibold) + 20px vertical separator.
3. **Orca pill** (`statusPill`): live = completed surface + `box-shadow: 0 0 16px -6px
   color-mix(in oklch, var(--status-completed) 90%, transparent)` + LiveDot, text "Connected to a
   running Orca (pid 97499)."; otherwise `neutralPill` + grey dot, "Orca isn't running; showing
   last-known state."
4. **Stream pill**: "Stream connecting…" (neutral) / "Live" (neutral + green dot) / "Stream
   reconnecting…" (dispatched surface, amber).
5. **Fleet pulse** (11px): `● 3 working · 1 needs you · 12 idle` with tone dots; "needs you"
   in gate ink, clickable → opens the Attention panel.
6. `ml-auto` metadata `dl` (11px muted): **source chips** — one compact chip per source
   (`database` icon + name + status dot; e.g. `opencode.db`, `hooks`, `orchestration v43`,
   `copilot`) opening a Popover with SourceHealth details; "Last event 2s ago" (hidden < lg).
7. ⌘K button (outline sm: `h-7 gap-1.5 px-2 text-[11px]`, `command` icon + "Search").
8. Theme toggle: ghost 28px, `sun` in dark / `moon` in light, icon animates rotate −90→0, scale .6→1.

LiveDot: 6px `rounded-full bg-status-completed` + two absolute rings animated
`orca-radar 2s ease-out infinite` (second delayed 1s). Not live: `bg-muted-foreground/40`.

### 8.2 Banner

`flex flex-col gap-px overflow-hidden rounded-xl border text-xs shadow-lift-1` + gate surface.
Each line `px-4 py-2`, e.g. "orchestration.db is from a newer Orca schema — some data may be
missing or mislabeled. (schema v43)" with the parenthetical at opacity .7. Degraded features in
`ul.list-disc.pl-5.mt-1.opacity-90`.

### 8.3 Attention strip (orca-viz "gate strip" pattern)

Above the canvas, only while items exist: `rounded-xl border px-4 py-2.5 max-h-40 overflow-y-auto`
+ gate surface, `box-shadow: 0 0 0 1px color-mix(in oklch, var(--gate) 35%, transparent),
var(--lift-2)`, three blurred (`blur-3xl`) drifting radial blobs at 20% gate color (`orca-drift`
19s/25s/22s). Row: kind icon 16px, title 13px semibold `line-clamp-2`, detail 11px opacity .8,
age, "Open" chip. High severity first.

## 9. Rail (FLEET)

- `nav.panel w-[18rem] flex-col overflow-hidden`, enters `x:-12`.
- Header: `sectionLabel` "FLEET" + count (11px muted/70 tabular-nums); below it a search input
  (`h-7 rounded-md border border-panel-border/70 bg-transparent px-2 text-[11px]`) and a filter
  row: segmented "All · Live" + harness chips.
- Workspace group header: 10px uppercase muted/60 label (repo / worktree name) + branch mono
  10px + live count; collapsible with `chevron-down/right`.
- **Session row** (orca-viz RunRow): `button.group relative w-full rounded-lg py-2 pr-2.5 pl-3`;
  hover bg motion span `layoutId="rail-hover"` `bg-accent/60`; selected motion span
  `layoutId="rail-selected"` `bg-selection-soft/70 border border-selection/25` + left accent bar
  `absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-selection`.
  - Line 1: state dot (8px; LiveDot when working) + title (13px semibold truncate) + harness
    monogram (17px) + `octagon-alert` (gate color) when blocked/waiting, `ml-auto`.
  - Line 2 (`pl-4`, mono 10.5px muted/80): `agent · model` (model shortened, e.g. `opus-5.5`).
  - Line 3 (`pl-4`, 11px muted): `3h 12m · 6 subagents · 214 tools · $1.42`.
  - Line 4 (`pl-4`, mono 10.5px, kind color, only while live): `▸ bash · npm test` (current
    activity) — truncated.
- **THE CAST** under the selected root: 10px label at muted/60; agent rows `py-1.5 pl-7 pr-9`
  with 20px monogram (agent color), agent name (12.5px semibold) + `· title` muted, state pill on
  the right (`rounded-full px-1.5 py-px text-[10px]` + tone surface). Indent by depth (+12px).
- **ORCHESTRATIONS** section: orca-viz RunRow anatomy (health dot, objective, mono coordinator
  handle, meta "N tasks · N done / N failed", gate icon).
- Empty: "No agent sessions in the last 24 h." / "Nothing live right now." (12px muted).

## 10. Center views

### 10.1 View tabs
`role=tablist` in `panel p-0.5 gap-0.5`, right-aligned above the view. Icons 14px: DAG
`git-branch`, Timeline `square-chart-gantt`, Stream `activity`, Changes `file-diff`, Overview
`layout-dashboard`. Optional count badge (11px muted/70).

### 10.2 DAG canvas (@xyflow/react)
- Container `panel bg-panel-solid h-full overflow-hidden`. `fitView` padding .2 maxZoom 1,
  `minZoom .05`, nodes not draggable/connectable, attribution hidden.
- `.react-flow { --xy-background-color: transparent; --xy-background-pattern-color:
  color-mix(in oklch, var(--muted-foreground) 26%, transparent) }` (orca-viz forgot the latter);
  `<Background variant=dots gap={20} size={1}/>`.
- Controls bottom-left: radius 14px, 1px `--panel-border`, `--lift-2`; buttons 26×26;
  `--xy-controls-button-background-color: var(--panel-solid)`, hover `var(--accent)`.
- MiniMap bottom-right (hidden < lg): node color = tone accent; radius 14px; mask
  `color-mix(in oklch, var(--field) 70%, transparent)`.
- Floating `floatPill` panels: top-left toggles ("Isolated tasks (N)" for orchestration runs;
  layout direction `arrow-down-wide-narrow` / `arrow-right-left`), top-center caption
  (`px-3.5 py-1.5 text-xs muted`), bottom-center legend "fill = state · stripe = agent".
- Edges: bezier, stroke `color-mix(in oklch, var(--muted-foreground) 50%, transparent)` 1.5px,
  `markerEnd ArrowClosed 18×18`. Into a working node: animated, 2px, dash `6 4`, stroke
  `#f59e0b`. Into an errored node: `--status-failed`. Dimmed: opacity .15.
- ELK: `{ 'elk.algorithm':'layered', 'elk.direction':'DOWN'|'RIGHT', 'elk.separateConnectedComponents':'true',
  'elk.layered.spacing.nodeNodeBetweenLayers':'70', 'elk.spacing.nodeNode':'30', 'elk.spacing.componentComponent':'60' }`.

### 10.3 Session node (command-center addition, 264×96)
`motion.div group relative flex flex-col gap-1 rounded-xl py-2 pr-2.5 pl-4 text-[11px]` + tone
surface; `box-shadow: inset 0 1px 0 0 var(--sheen), var(--lift-2)`; working/error prepend glow
`0 0 24px -6px color-mix(in oklch, ACCENT calc(var(--glow-strength)*100%), transparent)`.
Layers: agent stripe (`absolute top-2 bottom-2 left-1.5 w-[4px] rounded-full`), status wash
`linear-gradient(to right, color-mix(in oklch, ACCENT 20%, transparent), transparent 62%)`,
`.orca-alive` rotating conic ring when working (`inset:-3px`, radius 17px, 2.6s linear infinite),
cursor spotlight.
- Row 1: agent monogram 17px · STATE label 9px · harness tag (mono 9px muted) · `✗N` tool
  errors (red) · `ml-auto` elapsed (9px tabular-nums).
- Row 2: title 11.5px medium `line-clamp-2`.
- Row 3 (`mt-auto`, mono 9.5px, opacity .7): current activity `▸ bash · npm test` when live,
  else `214 tools · 12 files · $1.42`.
- Selected: `outline-2 outline-offset-2 outline-selection`. Hover `y:-2`. Pulse ring
  (`orca-pulse 1s`) when new activity arrives.

### 10.4 Orchestration task node (exactly orca-viz, 240×84)
Monogram (assignee A1…), STATUS label, gate badge, `↻N`, `✗N` (ml-auto); title `line-clamp-2`;
bottom "last seen 12s ago" (stale > 10 min → bold amber). Fill = status soft, stripe = assignee.

### 10.5 Stream rows
Row (min-height 30px, `px-3`, `hover:bg-accent/50`, divider `border-b border-panel-border/40`):
time `HH:MM:SS` (mono 10.5px muted/70, tabular-nums, w-16) · agent monogram 17px · session
short title (11px muted, max 22ch) · kind icon (14px, kind color) · title (12px, truncate;
MCP server badge inline) · `ml-auto` status glyph + duration (10px tabular-nums). Expanded:
`pl-[7.5rem] pb-2` with `pre` recipe blocks for input/output/thinking and file chips.
Sticky filter bar: `panelHeader` with segmented scope + kind toggle chips (each chip shows a 6px
kind-color dot and a count) + search + Follow toggle (`arrow-down-to-line`) + Pause.

### 10.6 Timeline (orca-viz timeline vocabulary)
Label gutter 160px (monogram + agent + title), lane row 26px, bar 18px, `rounded border px-1.5
text-[10px]` + tone surface; open bars fade right (`mask-image: linear-gradient(to right, black
60%, transparent)`); activity ticks inside lanes as 6–10px colored blocks by kind; axis ticks
10px muted/70; a vertical "now" line in `--selection`; spawn connectors dashed `3 2` muted.

## 11. Dock (Inspector)
- `aside.panel` w 384px resizable, enters `x:18`.
- Header tint `radial-gradient(120% 100% at 0% 0%, ACCENT, transparent 70%)` at opacity .07.
  Title 14px semibold leading-snug + close `x`; chips row: state pill, harness tile + label,
  agent monogram + name, model (mono 10.5px), elapsed, cost; copy-id chip.
- Tabs (segmented, `layoutId="inspector-tab"`): Activity · Files · Todos · Info.
- Sections `border-b border-panel-border/60 px-4 py-3`, 10px uppercase labels.
- Transcript (orca-viz conversation vocabulary): user prompt = right-aligned bubble
  `rounded-xl border px-3 py-2 text-[12.5px] bg-muted/60` with prompt-kind border; assistant text
  = left bubble `bg-panel-solid`; thinking = collapsible row (`brain` icon, "Thinking · 2.1s",
  first line muted italic); tool/MCP/file-change/subagent = compact cards `rounded-lg border
  border-panel-border/70 bg-panel-solid px-2.5 py-1.5` with icon, name, server badge, input
  preview mono 11px, status glyph, duration; expand reveals `pre` blocks (lazy-loaded detail).
  Day separators: hairlines + "Mon, Oct 26" 10.5px. Floating chip "new activity below ↓".
- Empty: "Select an agent to inspect it." with the Attention panel below.

## 12. Motion (`motion` library, `<MotionConfig reducedMotion="user">`)

- Springs: panels/nodes/header `{type:'spring', stiffness:380, damping:34, mass:.9}`; list
  items `{stiffness:520, damping:40, mass:.6}`; micro (layoutId pills, hover, theme icon)
  `{duration:.2, ease:[.22,1,.36,1]}`.
- Entrances: nodes `{opacity:0, scale:.92, filter:'blur(6px)'}` stagger `min(i*.012,.28)s`; dock
  `x:18`; rail `x:-12`; header `y:-8`; stream rows `y:-6` (only for rows that arrive live).
- Keyframes:
  - `orca-radar`: `0%{opacity:.55;transform:scale(1)} 70%{opacity:0} to{opacity:0;transform:scale(2.8)}`
  - `orca-pulse`: `0%{box-shadow:0 0 0 3px var(--orca-pulse)} to{box-shadow:0 0 0 10px #0000}` 1s once
  - `orca-alive`: `@property --orca-angle {syntax:'<angle>'; inherits:false; initial-value:0deg}`;
    conic gradient of ACCENT rotating via `--orca-angle` 0→360deg, 2.6s linear infinite, masked to a 1.5px ring
  - `orca-drift` (attention blobs), `orca-shimmer` (splash text 1.8s linear), xyflow `dashdraw`
- `prefers-reduced-motion: reduce` → all durations .01ms.

## 13. Iconography (lucide-react, stroke 2, sizes 12/14/16px)

`radar` logo · `database` sources · `git-branch` DAG · `square-chart-gantt` Timeline ·
`activity` Stream · `file-diff` Changes · `layout-dashboard` Overview · `octagon-alert`
blocked/gates · `message-circle-question` waiting · `circle-check` done · `circle-x` error ·
`loader-circle` running · `sun`/`moon` theme · `command` palette · `copy`/`check` copy ·
`external-link` links · `chevron-down/right` collapse · `x` close · `bot` subagent · `brain`
thinking · `plug` MCP · `square-terminal` shell · `folder-git-2` workspace · `git-pull-request` PRs.
Glyphs: `↻` retries, `✗` failures, `▸` current activity, `·` separators.

## 14. Copy & tone

Plain, specific, honest. Prefer "Orca isn't running; showing last-known state" over "Error".
Always say where a fact came from when it is inferred ("state from transcript", "from Orca hook").
Durations: `12s`, `3m`, `2h 5m`, `1d 3h`. Costs: `$0.42` (2 decimals, `<$0.01` when tiny).
Tokens: `113.5k`, `2.1M`.

## 15. Token flow (feature: `features/token-flow`)

### 15.1 Flow colors (`--flow-*`, add to `:root` / `.dark` and map in `@theme inline`)

| Token | Meaning | Light | Dark |
|---|---|---|---|
| `--flow-input` | fresh (uncached) input | `#0284c7` | `#38bdf8` |
| `--flow-cache-read` | cache read | `#0891b2` | `#67e8f9` |
| `--flow-cache-write` | cache write | `#4f46e5` | `#a5b4fc` |
| `--flow-output` | output | `#059669` | `#34d399` |
| `--flow-reasoning` | reasoning | `#7c3aed` | `#c4b5fd` |
| `--flow-cost` | cost / burn | `#d97706` | `#fbbf24` |
| `--flow-estimate` | streaming estimate | `color-mix(in oklch, var(--flow-output) 55%, transparent)` | same |

Inflow = blue family (input → cache read → cache write), outflow = green/violet. Particles use
the link's flow color at alpha .9 with `shadowBlur` 6 (dark) / 3 (light). Sankey links: flow
color at 28% (hover 55%); nodes: `bg-panel-solid` cards with a 3px left stripe in the node's
color (middle nodes use the agent palette §7.1).

### 15.2 Motion tokens

| Token | Value |
|---|---|
| Counter spring | `{ stiffness: 220, damping: 26, mass: 0.8 }` per digit column |
| Bar/FLIP spring | `{ stiffness: 380, damping: 34, mass: 0.9 }` (same as panels) |
| Gauge spring | `{ stiffness: 160, damping: 22 }` |
| Delta chip | enter `{ y: 6, opacity: 0 }` → `{ y: -10, opacity: 1 }` 180 ms, hold 700 ms, exit `{ y: -22, opacity: 0 }` 320 ms ease-out |
| Particle speed | link traverse 1.6–2.4 s (shorter for higher rates), ease-in-out-sine on progress |
| Particle spawn | rate/link = `clamp(log10(1 + tokensPerSec) * 6, 0, 30)` per second; burst per call `min(24, 4 + 3·log10(tokens))` |
| EWMA | `rate ← rate·e^(−Δt/τ) + tokens/τ`, τ = 8 s |
| Stream chart | scroll continuously (x = time); new bucket heights ease from 0 over 400 ms; now-line pulse 2 s |
| In-flight → metered | estimate cross-fades to metered over 250 ms; `check` tick scales .6 → 1 then fades after 1.5 s |
| Burn pill pulse | `box-shadow` glow 0 → 12px → 0 over 2 s, infinite while any call is in flight |
| Reduced motion | no particles/chips/pulses; counters and gauges snap; charts redraw at 1 Hz |

### 15.3 Components (kit: `src/client/ui/flow/`)

- **Odometer** — inline-flex of digit columns (`0–9` stacked, `translateY(-n·1em)`), tabular
  nums, mono for metric tiles; separators/decimals static; unit suffix (`k`, `M`, `$`) outside
  the columns. Props: `value`, `format` (`tokens` | `cost` | `int` | `percent`), `size`. The
  element carries `aria-label` with the exact value; digits are `aria-hidden`.
- **KPI tile** — `.panel` on `bg-panel-solid`, `px-4 py-3`; label 10px uppercase tracking .1em
  muted; value 22px semibold mono odometer; sub-line 11px muted (breakdown with flow-color dots);
  delta chips stack at the top-right; an optional sparkline at the bottom (24px tall).
- **Delta chip** — `rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums` on
  `color-mix(in oklch, FLOW 18%, transparent)` with FLOW ink; content like `+12.4k in`.
- **Sankey** — 3 columns; node cards 140×(value-proportional, min 22px) with label 11px + value
  10px muted; links = cubic Bézier ribbons; hover dims other links to 12%; selected middle node
  outlined `--selection`. Particle canvas sits above the SVG (pointer-events none).
- **Mirrored stream chart** — inflow stacked above the axis (input, cache read, cache write),
  outflow below (output, reasoning); axis line `--panel-border`; y labels 10px muted with
  symmetric scale; crosshair `--muted-foreground` 1px dashed; tooltip `.panel` 11px; brush =
  `bg-selection/15` with `--selection` edges; call markers as 2px ticks on the axis.
- **Radial gauge** — 56px, 6px stroke, track `--muted`, arc in `--flow-cache-read`; center
  value 13px semibold; thresholds: < 40% `--status-failed`, < 70% `--flow-cost`, else cache color.
- **Animated bar list** — rows 28px: label (agent monogram/model), bar (flow-split: inflow
  share blue, outflow share green, or cost amber in Cost units), value right (tabular-nums);
  `motion` `layout` reorder; rank delta glyph `▲2` / `▼1` flashes 400 ms.
- **In-flight meter** — shimmer bar (`orca-shimmer`) 3px tall + "≈ 1.2k out · streaming" in
  `--flow-estimate` with dashed underline; becomes the metered value on completion.
- **DAG overlay** — node ring: two concentric 2px arcs outside the card (`inset:-6px`), inflow
  arc `--flow-input`, outflow arc `--flow-output`, length ∝ node share of workflow; cost ticker
  in the node's row 3; edge dots r=2.5 via `animateMotion` (cyan down, emerald up).
- **Burn pill** (header) — `statusPill` + `flame` icon in `--flow-cost`; text "$3.40/h · 42k
  tok/min"; neutral when nothing is running.
- **Cost disclaimer** — an `info` icon (12px) next to every cost with tooltip: "Estimated by the
  harness at public list prices. GitHub Copilot bills by subscription/premium requests."

### 15.4 Icons

`coins` Tokens view · `arrow-down-to-line` inflow · `arrow-up-from-line` outflow · `database-zap`
cache · `flame` burn · `timer` TTFT · `gauge` throughput · `receipt` cost · `download` CSV.
