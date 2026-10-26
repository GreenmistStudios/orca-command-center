# Feature plan — Token Flow (token tracking, cost & live flow animation)

> Every LLM call your agents make — metered, rolled up per session, per workflow, per
> orchestration run and across the fleet — with cost, burn rate, cache efficiency and what the
> tokens produced, animated live as tokens flow into and out of the models.

| | |
|---|---|
| Parent plan | [`../../Plan.md`](../../Plan.md) (Orca Command Center) |
| Branch | `geoff-powell/token-flow` |
| Contract | additive section "Token usage & flow" in [`src/shared/contract.ts`](../../src/shared/contract.ts); `getUsageSamples?`, `usage?`/`usageCalls?`, `UsageQuery` in [`src/server/types.ts`](../../src/server/types.ts) |
| Design | [`docs/design-system.md` §15 Token flow](../../docs/design-system.md) |
| Tasks | [`tasks/Task-18.md`](tasks/Task-18.md) … [`tasks/Task-28.md`](tasks/Task-28.md) |

---

## 1. Summary

The console already shows each session's lifetime `tokens`/`cost`, but nothing answers the
questions people actually ask while agents run: *how fast are we burning, which agent is
expensive, is the cache working, what did this workflow cost end to end, and what did we get
for it?* Token Flow adds a **usage ledger** of every metered LLM call, rollups at every level,
and an interactive, animated **Tokens** view plus token overlays on the DAG, inspector, rail
and header.

Grounding (verified on this machine, 2026-10-26):

- **OpenCode is exact and call-granular.** For the coordinator session, Σ of its 74
  `step-finish` parts equals the `session` table totals *exactly* ($18.7544; input 152;
  output 170,749; reasoning 109,213; cache read 20,483,274; cache write 1,811,581). One
  assistant message = one step = one LLM call in this OpenCode version.
- **Copilot CLI meters every call too**: `model.model_call_success` carries OpenAI-style
  `responseUsage` (`prompt_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens`,
  `completion_tokens_details`), `copilotUsage.total_nano_aiu`, `ttftMs`, `modelCallDurationMs`,
  `interTokenLatencyMs`; `session.shutdown` carries context composition (`systemTokens`,
  `toolDefinitionsTokens`, `conversationTokens`) and `totalPremiumRequests`.
- **…but only for auxiliary calls (found during E1).** On this machine the 16 logged
  `model_call_success` events are small `gpt-4o-mini` calls (3,272 tokens) while the
  `session.shutdown` summaries report 6.4M input tokens and ≈ 367 AIU for the main models. The
  authoritative Copilot numbers are the per-model `session.shutdown.modelMetrics`
  (`usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}`,
  `totalNanoAiu`, `requests.cost` = premium requests), available when a session ends. Task-20b
  turns them into **session-summary samples** (remainder after per-call samples, never double
  counted), labelled "reported at session end"; live Copilot sessions show AIU/premium
  requests from `session.usage_checkpoint` and a coverage note.
- **Inflow is ~92% cache reads** (20.5M read vs 152 fresh input on the coordinator session) —
  visualizations must stay legible at extreme ratios.
- **Cost is a list-price estimate.** Every model here is served through `github-copilot`;
  OpenCode computes USD from public list prices (7-day total ≈ $225 across 107 sessions) while
  real billing is a Copilot subscription (premium requests). The UI must say so.

## 2. Goals & non-goals

**Goals**

- T1. Per-call ledger: every metered call with tokens (fresh/cached/written/output/reasoning),
  cost, AI units, model, agent, timing (TTFT, duration, tokens/s).
- T2. Rollups for **session**, **workflow** (root + all subagents), **orchestration run**
  (linked sessions) and **fleet** (time window), all reconciling exactly with harness totals.
- T3. Live: calls appear ≤ 2 s after they finish; in-flight calls show a streaming estimate
  that is replaced by the metered numbers.
- T4. An interactive Tokens view with industry-standard visuals and motion: rolling counters,
  live mirrored in/out stream chart, animated Sankey flow, leaderboards with animated
  reordering, cache gauge, delta chips.
- T5. Token flow everywhere it helps: DAG edges/nodes, inspector Usage tab, rail cost tickers,
  header burn-rate pill, Overview.
- T6. Honest numbers: metered vs estimated, list-price cost disclaimer, coverage notes, and a
  reconciliation script proving totals.
- T7. Smooth and cheap: 60 fps animations with zero per-frame React renders; respects
  `prefers-reduced-motion`; pauses in hidden tabs.

**Non-goals (this feature)**

- Billing-accurate costs (subscription/premium-request pricing), budgets and alerts (future).
- Editing prices or models; exporting to OpenTelemetry (future).
- Claude Code / Codex adapters (no local data; the ledger is harness-agnostic).

## 3. Definitions

| Term | Definition |
|---|---|
| **Call** | One metered LLM request: an OpenCode `step-finish`, or a Copilot `model.model_call_success`. The atomic `UsageSample`. |
| **Session** | One agent (root or subagent). |
| **Workflow** | A root session plus every descendant subagent — the DAG. |
| **Orchestration run** | An Orca run; its usage = calls of sessions linked to its coordinator or dispatches (and their descendants). |
| **Fleet** | All sessions; usage is **time-windowed** (calls whose `ts` is in the window). |
| **Inflow** | Tokens into the model: `input` (fresh) + `cacheRead` + `cacheWrite`. |
| **Outflow** | Tokens out of the model: `output` + `reasoning`. |
| **Context size** | Inflow of one call (the prompt the model saw). |
| **Cache hit rate** | `cacheRead / inflow`. |
| **Burn rate** | Cost per hour over a sliding window (default 5 min). |
| **Throughput** | `outflow / (durationMs − ttftMs)` tokens/s, when timing is known. |
| **Metered** | From the harness's usage record. **Estimated** = streamed chars ÷ 4 for a call still in flight; never summed into totals. |
| **Cost** | USD computed by the harness from public list prices. Copilot CLI reports AI units (`aiu`) and premium requests, not USD — shown separately, never converted. |

## 4. Metrics catalog

| Metric | Scope | Source | Shown in |
|---|---|---|---|
| Calls | all | ledger | KPI, tables |
| Inflow / outflow (+ breakdown fresh·cache read·cache write / output·reasoning) | all | ledger | KPI, Sankey, stream chart, DAG rings |
| Cost (list price) + costed-calls coverage | all | ledger | KPI, leaderboards, rail, DAG |
| AI units, premium requests | Copilot | ledger / facts | KPI (when present), Info |
| Burn rate ($/h), tokens/min, calls/min | live scopes | sliding window | header pill, KPI, DAG |
| Cache hit rate | all | ledger | radial gauge, tables |
| TTFT p50/p95, throughput tokens/s | calls with timing | ledger | KPI, calls table |
| Context size per call (growth & compaction drops) | session | ledger | Inspector Usage chart |
| Share of workflow tokens / cost | workflow | rollup | DAG rings, leaderboard |
| Output: files changed, +/− lines, artifacts, PRs | workflow, session | file changes + artifacts | "Yield" panel |
| Cost per outcome ($/file changed, $/PR) | workflow | derived | Yield panel |

## 5. UX

### 5.1 Tokens view (new center view, tab 6 · icon `coins`)

```text
┌ Scope: [Fleet | Workflow ▸ <root> | Session ▸ <s> | Run ▸ <r>]  Window [15m 1h 24h All]  Units [Tokens|Cost]  Scale [Balanced|Linear]  ● Live ┐
├ KPI ribbon — odometer counters + delta chips ───────────────────────────────────────────────────────────────────────────────────┤
│ INFLOW 22.3M (fresh 152 · read 20.5M · write 1.8M) │ OUTFLOW 280k (out 171k · reasoning 109k) │ COST $18.75 ⓘ list price │      │
│ BURN $3.40/h · 42k tok/min                          │ CACHE HIT ◔ 91.9%                         │ CALLS 74 · TTFT p50 1.2s     │      │
├────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────┤
│ FLOW  Sankey: sources → agents|sessions|models → outputs   │ LEADERBOARD  [Agents | Models | Sessions]   (FLIP-animated bars)   │
│ particles stream along links at live rates; hover = values │ ▇▇▇▇▇▇▇▇▇ build · opus-5.5     $14.21   in 18.0M · out 210k  76%   │
│ click a middle node → select that session/agent            │ ▇▇▇ sonnet-coder ×12           $3.92                        21%   │
├────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────┤
│ STREAM  mirrored live area chart — inflow stacked above the axis, outflow below; scrolls with time; crosshair; brush to zoom   │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ CALLS (toggle)  virtualized ledger: time · agent · model · in · cache · out · reasoning · cost · TTFT · tok/s — new rows slide │
│ YIELD (workflow/session): 37 files · +2.1k/−300 · 1 PR · $0.51 per file changed                                                │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Scope** defaults: a selected run → Run; a selected session → its Workflow (toggle to
  Session); nothing → Fleet. Window applies to Fleet (default 24 h) and optionally narrows
  other scopes (default All).
- **Units** switches Sankey/leaderboard/stream values between tokens and cost.
- **Scale** "Balanced" (√-scaled link widths, exact values in labels) keeps fresh input visible
  next to 20M cache reads; "Linear" shows exact proportions.
- **In-flight** calls appear as shimmering rows in the ledger and as "≈" counters on the
  outflow KPI, morphing into metered numbers when the call completes.
- **CSV export** of the calls ledger for the scope.
- Empty/coverage states: "No metered calls in this scope yet." · "3 Copilot CLI sessions predate
  per-call usage events." · "No sessions are linked to this run."

### 5.2 DAG token-flow overlay (toggle "Token flow", default on)

- **Edges animate both directions:** cyan particles parent → child at the child's inflow rate
  (context fed to the subagent's model), emerald particles child → parent at its outflow rate
  (tokens it generated, rolling up into the workflow). Idle edges are still.
- **Nodes** gain an in/out ring (two arcs proportional to the node's share of workflow
  inflow/outflow) and a cost ticker; a call completing pulses the node and floats a delta chip.
- **Workflow pill** (top-center): odometers for workflow inflow · outflow · cost + burn rate.

### 5.3 Inspector · Usage tab

KPIs for the session (and, on roots, the workflow); **context growth** chart (inflow per
call — growth and compaction drops annotated); cumulative cost sparkline; per-call table
(virtualized; in-flight row at the bottom with a live estimate); on roots a per-subagent
breakdown with animated bars.

### 5.4 Rail · Header · Overview · Palette

- Rail root rows: cost ticker (odometer), micro in/out bar, in-flight shimmer while streaming.
- Header **burn pill**: fleet `$/h · tok/min`, gently pulsing while anything streams; click →
  Tokens view (Fleet).
- Overview: tokens/cost tiles switch to **window-bounded** usage (`FleetStats.usage`) with
  rolling counters, and link to the Tokens view.
- Palette: "Tokens view", "Token usage for <workflow>"; hotkey `6`.

### 5.5 Accessibility

Every animated number has a stable accessible label with the exact value; the Sankey exposes a
table alternative (`role=table`, visually hidden) and labelled nodes; charts have text
summaries; animation is decorative (never the only signal); reduced motion → no particles,
counters snap, charts update once per second.

## 6. Animation system

| Animation | Industry pattern | Spec (design-system §15) | Reduced motion |
|---|---|---|---|
| Rolling counters | odometer / number ticker (Stripe, Vercel, Linear) | per-digit columns translate on a spring (stiffness 220, damping 26, mass .8), ~600 ms; suffix units (k/M) cross-fade | instant swap |
| Delta chips | trading-ticker deltas | "+12.4k in · +1.1k out · +$0.21" rise 16 px & fade over 1.2 s; ≤ 3 visible, merged when bursty | none |
| Sankey particles | particle flow over Sankey links | canvas; spawn rate per link ∝ log(tokens/s EWMA, τ = 8 s), burst on each call (n ∝ log10 tokens); 2–3 px, glow; ≤ 600 particles | static gradient links |
| Live stream chart | mirrored in/out traffic chart (Grafana/Datadog network panels) | canvas, continuous scroll at 60 fps while Live; new buckets ease in; crosshair tooltip; now-line pulse | 1 Hz redraw |
| Leaderboard | bar-chart race / FLIP reordering | `motion` `layout` spring; width springs; rank change flash 400 ms | instant |
| Cache gauge | radial gauge | arc springs to value; color thresholds | instant |
| In-flight meter | shimmer + estimate → metered morph | dashed "≈" counter climbs with streamed chars; on completion cross-fades to the metered value with a check tick | static "streaming…" label |
| DAG edge flow | traffic dots on service graphs (Kiali/xyflow animated edges) | SVG `animateMotion` dots, count/speed ∝ rate, two directions/colors | static colored edges |
| Burn pill pulse | live status pulse | 2 s soft glow while any call is in flight | none |

**Engineering rules:** animation loops run in `requestAnimationFrame` against refs/canvas —
never React state per frame; one shared rAF scheduler; DPR-aware canvases; pause when
`document.hidden`; cap particles; spring values via `motion` (`useSpring`/`animate`); all
counters accept `prefers-reduced-motion`. Budgets: ≥ 55 fps median, no long task > 50 ms, ≤ 4 ms
script per frame with 600 particles.

## 7. Architecture

```text
opencode.db event tail ──▶ OpenCode adapter ──┐  UsageSample (step-finish), UsageEstimate (Δchars/4)
~/.copilot events.jsonl ─▶ Copilot adapter ───┤  UsageSample (model_call_success)
                                              ▼
                          Store · UsageLedger (ledgerSeq, by session/root, bounded)
                            ├─ rollups: SessionSummary.usage (session · tree · rates · inFlight)
                            ├─ FleetStats.usage (window-bounded totals + rates)
                            ├─ GET /api/usage (report: totals·rates·series·breakdowns·sankey·calls·output·coverage)
                            ├─ GET /api/usage/calls (paged ledger)
                            └─ SSE { type:'usage', samples, estimates } (+ sessions frames)
                                              ▼
Client: usage slice (ring of samples, estimates) ─ usageBus (non-React) ─▶ animation engines
        useLiveUsage(scope): baseline report + live deltas (ledgerSeq > report.ledgerSeq), via the SAME
        src/shared/usage-math.ts the server uses; reconcile refetch every 60 s
```

- **One math module** (`src/shared/usage-math.ts`) is used by the server (rollups, reports)
  and the client (live deltas), so a live view and a fresh report can never disagree.
- **Ledger:** `Map<id, UsageSample>` + per-session arrays sorted by `ts` + root index;
  monotonic `ledgerSeq` on ingest. Seeded in background chunks after boot for window sessions
  (≈ 20 ms per session via `part_session_idx`); sessions outside the window load on demand when
  a workflow/session report asks for them (cached, LRU-bounded, ≤ 200k samples).
- **Live merge protocol:** a report carries `ledgerSeq`; the client applies only samples with a
  higher `ledgerSeq` (no double counting, no gaps), recomputes at ≤ 4 Hz, and refetches every
  60 s to reconcile windows.
- **Estimates:** OpenCode adapter tracks streamed text/reasoning length and tool-input JSON per
  in-flight call (`step-start` → `step-finish`); Copilot exposes no streaming, so its estimates
  only signal "in flight" (0 tokens) between `model_call_started` and `model_call_success`.
- **Safety:** usage records are numbers; Copilot `requestMessages`, `responseChunk`,
  `quotaSnapshots`, `requestSettings` are dropped at parse time and never retained or served.

## 8. API & stream (normative; types in the contract)

| Route | Params | Response |
|---|---|---|
| `GET /api/usage` | `scope=fleet\|workflow\|session\|run` (required), `id` (required unless fleet), `windowMinutes` (1–43,200; preferred — sub-hour windows such as 15 m need it) or `windowHours` (1–720; legacy; mutually exclusive with `windowMinutes`; fleet default = server window), `bucketMs` (≥ 1000), `middle=agent\|session\|model` (default agent; session for workflow scope) | `UsageReport` (404 unknown id) |
| `GET /api/usage/calls` | `scope`, `id`, `before`, `limit` (≤ 2000, default 200) | `UsageCallsPage` |
| SSE `usage` | — | `{ samples, estimates }`, coalesced per flush: samples by id (highest ledgerSeq), estimates by sessionId (latest `updatedAt`) |

`SessionSummary.usage` and `FleetStats.usage` ride the existing `sessions`/`stats` frames.

## 9. Non-functional requirements

| Area | Requirement |
|---|---|
| Accuracy | Session totals from the ledger equal harness totals exactly (OpenCode tokens; cost within 1e-6); workflow = Σ its sessions; reconcile script proves it on real data |
| Latency | Call → UI ≤ 2 s p95; estimate updates ≤ 1 s |
| Boot | Unchanged first-bootstrap budget (≤ 1.5 s): usage seeding is background work |
| Server cost | Usage report ≤ 50 ms for a 26-session workflow when warm; ledger memory ≤ 60 MB |
| Client | ≥ 55 fps median in the Tokens view with live mock traffic; no long task > 50 ms; Tokens view chunk lazy-loaded |
| Safety | No transcript text in usage payloads; dropped Copilot request bodies; existing audits stay green |

## 10. Testing & verification

- Unit: usage math (inflow/outflow/cache/rates/bucketing/breakdowns/sankey/percentiles,
  estimate math); adapters against fixtures (OpenCode step-finish/step-start/streaming growth;
  Copilot model_call_* incl. stripped bodies); ledger (ordering, ledgerSeq, eviction, rollups,
  windows, run scope); hub coalescing of `usage`; routes params/errors.
- Client: counters/chips/gauge/sankey/stream chart render & reduced-motion paths (canvas
  stubbed in jsdom); live merge (`ledgerSeq` watermark, no double count); views with mock data.
- `scripts/usage-reconcile.mjs` (real data): per-session ledger totals vs `/api/sessions/:id`
  totals; workflow totals vs Σ sessions; fleet window sanity. PASS/FAIL.
- E2E (Playwright, Chrome, real + mock): Tokens view surfaces, DAG overlay, Usage tab,
  reduced-motion emulation, animation performance probe (rAF fps + long-task observer).

## 11. Delivery

### 11.1 Waves

| Wave | Tasks (parallel within a wave) | Exit criteria |
|---|---|---|
| E1 | **18** shared usage math · **19** OpenCode usage · **20** Copilot usage · **21** animation kit | math tested; both adapters emit samples/estimates on fixtures + real-data check; kit renders in tests |
| E2 | **22** client usage state, live merge, mock, view registration · **23** server ledger, rollups, API, SSE | `/api/usage` correct on fixtures + real data; mock serves usage; live merge tested |
| E3 | **24** Tokens view · **25** DAG overlay · **26** Inspector Usage tab · **27** rail/header/overview/palette | every surface works on `?mock=1` |
| E4 | **28** reconcile, e2e, animation perf, docs → independent review → fix wave | all gates green on real data |

### 11.2 Dependency graph

```text
18 ─┬────────────▶ 22 ─┬─▶ 24 · 25 · 26 · 27 ─▶ 28 ─▶ review ─▶ fixes
19 ─┼────────────▶ 23 ─┘                         ▲
20 ─┘                                            │
21 ──────────────────────────────────────────────┘ (kit used by 24–27)
```

### 11.3 Task index & ownership

| Task | Title | Wave | Owns |
|---|---|---|---|
| [18](tasks/Task-18.md) | Shared usage math | E1 | `src/shared/usage-math.ts` (+ test) |
| [19](tasks/Task-19.md) | OpenCode usage extraction & streaming estimates | E1 | `src/server/sources/opencode/**`, `test/fixtures/opencode.ts` |
| [20](tasks/Task-20.md) | Copilot usage extraction | E1 | `src/server/sources/copilot/**`, `test/fixtures/copilot.ts` |
| [20b](tasks/Task-20b.md) | Copilot session-summary usage (added after the E1 finding) | E2 | `src/server/sources/copilot/**`, `test/fixtures/copilot.ts` |
| [21](tasks/Task-21.md) | Animation & chart kit | E1 | `src/client/ui/flow/**`, token block in `src/client/styles/theme.css`, `package.json` deps (`d3-sankey`, `@types/d3-sankey`) |
| [22](tasks/Task-22.md) | Client usage state, live merge, mock, view registration | E2 | `src/client/state/**`, `src/client/api/**`, `src/client/shell/{ViewTabs,CenterView}.tsx`, `src/client/hooks/useGlobalHotkeys.ts`, placeholder `src/client/views/tokens/TokensView.tsx`, `test/client/**` |
| [23](tasks/Task-23.md) | Server usage ledger, rollups, API & SSE | E2 | `src/server/store/**`, `src/server/hub/**`, `src/server/http/routes.ts` (+ tests), `test/integration/**` |
| [24](tasks/Task-24.md) | Tokens view | E3 | `src/client/views/tokens/**` |
| [25](tasks/Task-25.md) | DAG token-flow overlay | E3 | `src/client/views/dag/**` |
| [26](tasks/Task-26.md) | Inspector Usage tab | E3 | `src/client/inspector/**` |
| [27](tasks/Task-27.md) | Rail, header, overview & palette integration | E3 | `src/client/rail/**`, `src/client/shell/Header.tsx`, `src/client/views/overview/**`, `src/client/palette/**` |
| [28](tasks/Task-28.md) | Verification, reconciliation, animation perf, docs | E4 | `scripts/**`, `test/e2e/**`, `README.md` |

### 11.4 Execution protocol

Same as the parent plan §13.4: coordinator (Opus) owns plan/contract/git; `sonnet-coder`
subagents implement one task each in parallel waves with disjoint ownership; no new
dependencies except Task-21's `d3-sankey` + `@types/d3-sankey`; the coordinator verifies each
wave (`typecheck`, `test`, `build`), fixes seams, and commits a checkpoint on
`geoff-powell/token-flow`. Wave E4 adds an independent review and a fix wave before final gates.

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Extreme ratios (20M cache vs 152 fresh) flatten visuals | Balanced (√) scale default, exact labels, separate fresh/cache series, log-mapped particle rates |
| Cost misread as billing | "List price" badge + tooltip everywhere cost appears; Copilot AI units/premium requests shown separately |
| Animation jank / battery | rAF outside React, particle caps, hidden-tab pause, reduced motion, perf probe in e2e |
| Double counting between report and live stream | `ledgerSeq` watermark + id dedupe; periodic reconcile |
| Ledger memory on long histories | window seeding, LRU for on-demand sessions, sample cap with coverage note |
| Copilot event shapes drift | tolerant parsing, coverage notes, fixtures from real shapes |
| Estimates mistaken for metered numbers | "≈" prefix, dashed styling, never summed, morph-to-metered transition |

## 13. Future

Budgets & alerts per workflow/agent · pricing overrides (premium-request accounting) ·
OpenTelemetry GenAI export · Claude Code / Codex usage (`message.usage`, `token_count` events) ·
cost forecasts for in-flight workflows.
