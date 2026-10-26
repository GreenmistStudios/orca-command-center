# Task-21 — Animation & chart kit

**Feature:** Token Flow · **Wave:** E1 (parallel with 18, 19, 20) · **Size:** L · **Blocks:** 24–27

## Goal

A reusable, performant kit of animated token-flow components in the orca-viz visual language:
rolling counters, delta chips, KPI tiles, sparklines, radial gauge, animated bar list, in-flight
meter, a particle engine, an animated Sankey, and a live mirrored stream chart. The views (Tasks
24–27) compose these; they contain no domain fetching.

## Read first

- `features/token-flow/Plan.md` §5 (surfaces), §6 (animation system — normative), §9
- `docs/design-system.md` §15 (normative visuals & motion tokens), plus §2–§6, §12
- `src/shared/contract.ts` (`UsageSankey`, `SankeyNode`, `SankeyLink`, `UsageBucket`, `FlowKind`)
- Existing UI: `src/client/ui/index.ts`, `src/client/lib/format.ts` (`formatTokens`, `formatCost`),
  `src/client/hooks/useElementSize.ts`, `src/client/styles/theme.css`

## Ownership

- `src/client/ui/flow/**` (new; export everything from `src/client/ui/flow/index.ts`)
- `src/client/styles/theme.css`: **append** the `--flow-*` tokens (light + dark) and their
  `@theme inline` mappings (`--color-flow-input`, …) — don't change existing rules
- `package.json` + lockfile: add `d3-sankey` (^0.12.3) and `@types/d3-sankey` (devDependency) —
  the only dependency change allowed in this feature
- Co-located tests

## Requirements

### A. Infrastructure

- `frame.ts` — one shared `requestAnimationFrame` loop: `subscribeFrame(cb: (now, dt) => void) → unsubscribe`;
  stops when no subscribers; pauses while `document.hidden`; exposes `getFrameStats()` →
  `{ fps (EMA), lastFrameMs }` for the e2e perf probe (also set `window.__occFrameStats` in dev
  and when `?perf=1`).
- `motion.ts` — `useFlowMotion()` → `{ reduced: boolean }` combining `motion`'s
  `useReducedMotion()` and a test override; constants from design-system §15.2.

### B. Components (props typed and documented)

1. `Odometer` — `{ value: number; format: 'tokens'|'cost'|'int'|'percent'; className?; size?: 'sm'|'md'|'lg' }`.
   Formats the value (reuse `formatTokens`/`formatCost` rules), splits digits into columns that
   spring (`motion` `useSpring`) to the new digit; non-digits static; `aria-label` = exact
   value (e.g. "20,483,274 tokens"); digits `aria-hidden`; reduced motion → plain text.
2. `DeltaChips` — imperative handle `push({ label, flow })` (via `useRef` handle or an
   `emitter` prop); ≤ 3 visible, merges bursts within 300 ms; motion per §15.2.
3. `KpiTile` — label, `Odometer`, sub-line slots, optional `Sparkline`, chips area, optional
   `info` (cost disclaimer).
4. `Sparkline` — SVG polyline/area, props `values: number[]`, color var.
5. `RadialGauge` — `{ value: number | null; label; thresholds? }` spring arc.
6. `AnimatedBarList` — `{ rows: Array<{ key; label: ReactNode; value: number; split?: Array<{ flow: FlowKind | 'cost'; value: number }>; right?: ReactNode; onClick? }>; max?: number }`
   with `motion` `layout` reordering and rank-delta glyphs.
7. `InFlightMeter` — `{ estTokens: number; startedAt: number; metered?: number | null }`
   shimmer + "≈ 1.2k out · streaming", morph to metered with check tick.
8. `CostDisclaimer` — `info` icon + tooltip copy from §15.3.
9. `FlowLegend` — chips for the five flows.

### C. Particle engine (`particles.ts`, framework-free)

`class ParticleEngine { constructor(canvas, opts: { maxParticles?: number; reduced?: boolean }); setPaths(paths: Array<{ id; points: Array<[x, y]>; color: string; width?: number }>); setRate(pathId, tokensPerSec); burst(pathId, tokens); resize(w, h, dpr); start(); stop(); destroy(); stats() }`
— spawn rates & bursts per §15.2 (log mapping, caps), particles move along a polyline with
ease-in-out-sine progress, color per path, DPR-aware, pooled objects (no per-frame allocation),
driven by `subscribeFrame`; `reduced` → never animates; no-op when `getContext` returns null
(jsdom).

### D. `SankeyChart`

- Props: `{ sankey: UsageSankey; scale: 'balanced'|'linear'; units: 'tokens'|'cost'; rates?: Record<linkId, number>; burstEmitter?: { subscribe(fn: (linkId: string, tokens: number) => void): () => void }; selectedNodeId?; onNodeClick?(node); height? }`.
- Layout with `d3-sankey` (`nodeAlign: sankeyJustify`, node width 10, padding 12, fixed 3
  columns via `column`); balanced scale lays out on `√value` (labels/tooltips show true values);
  links rendered as SVG paths (`sankeyLinkHorizontal`), node cards per §15.3; particle canvas
  overlay using link path polylines (sample `getPointAtLength` or the Bézier analytically);
  hover highlights; keyboard-focusable nodes with `aria-label`; a visually-hidden
  `<table>` alternative listing links (source, target, tokens).
- Responsive (`useElementSize`), relayout only when structure/values change (memo).

### E. `MirroredStreamChart`

- Props: `{ buckets: UsageBucket[]; bucketMs: number; domain: [from, to] | 'live'; spanMs?: number; units: 'tokens'|'cost'; markers?: number[]; onBrush?(range: [number, number]); height? }`.
- Canvas: stacked inflow areas above the axis (input, cacheRead, cacheWrite), outflow below
  (output, reasoning); symmetric y scale with a "balanced" option (√); in live mode the x-domain
  slides with `now` every frame; newly appended buckets ease their height in; SVG overlay for axes,
  now-line, crosshair + tooltip (`.panel` 11px with all five values and cost), brush (drag) →
  `onBrush`. Pure helpers (`scaleLinear`, `stackBucket`, tick generation) exported and unit-tested.

### F. Tests

jsdom with a stubbed `HTMLCanvasElement.prototype.getContext` (spy recording draw calls) and
`matchMedia` reduced-motion toggles. Cover: Odometer final text & aria-label for each format,
reduced-motion plain render; DeltaChips push/merge/cap; RadialGauge thresholds; AnimatedBarList
order & rank delta; InFlightMeter morph; ParticleEngine (fake frame clock): spawn rate mapping,
burst size, cap, pooling (no growth past max), reduced no-op; SankeyChart: node/link counts,
balanced vs linear widths, hidden table, node click; MirroredStreamChart helpers (scales,
stacking, live domain, brush math) and render smoke; frame loop pauses when hidden.

## Verify

```bash
npm install            # after adding d3-sankey (+ @types/d3-sankey)
npx tsc -p tsconfig.client.json 2>&1 | grep -E "ui/flow|styles"
npx tsc -p tsconfig.test.json 2>&1 | grep ui/flow
npx vitest run src/client/ui/flow
npx vite build --outDir "$TMPDIR/occ-task-21" --emptyOutDir   # bundling check only
```

## Report

Summary, files, component API list (exact props), tests, deviations, notes for view authors.
