import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import {
  LIMITS, type ActivityEvent, type ActivityKind, type ActivityPage, type Artifact, type AttentionItem, type BootstrapPayload,
  type FileChange, type FileDiff, type FleetStats, type Harness, type OrchRunDetail, type OrchTaskDetail, type OrchestrationSummary,
  type OrcaSnapshot, type PartDetail, type ServerMeta, type SessionDetail, type SessionSummary, type SessionTree, type StreamEvent,
  type TranscriptMessage, type TranscriptPage, type UsageCallsPage, type UsageEstimate, type UsageReport, type UsageSample, type UsageScope,
  type UsageScopeKind,
} from '../../shared/contract'
import { compareSamples } from '../../shared/usage-math'
import { api } from '../api/client'
import { connectStream, type StreamHandle } from '../api/sse'
import { getStored, setStored } from '../lib/storage'
import { addNotice } from '../shell/notices'
import { selectDescendants, selectRootSessions } from './selectors'
import { readUrlSelection, startUrlSync } from './url'
import { usageBus } from './usage-bus'

export type ViewId = 'dag' | 'timeline' | 'stream' | 'changes' | 'overview' | 'tokens'
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline'

/** A lazily fetched resource: stale data is kept while refreshing; errors are stored, not thrown. */
export interface Loadable<T> {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: T | null
  error: string | null
  fetchedAt: number | null
}

export interface StreamFilters {
  scope: 'all' | 'tree' | 'session'
  kinds: ActivityKind[]
  harness: Harness | 'all'
  query: string
  errorsOnly: boolean
  follow: boolean
  paused: boolean
}

/** Tokens view preferences (persisted as `occ-tokens`). */
export interface TokensPrefs {
  scope: 'auto' | UsageScopeKind
  /** null = all time (fleet: the server window). */
  windowMs: number | null
  units: 'tokens' | 'cost'
  middle: 'agent' | 'session' | 'model' | 'auto'
  scale: 'balanced' | 'linear'
  showCalls: boolean
  overlay: boolean
}

export const DEFAULT_TOKENS_PREFS: TokensPrefs = {
  scope: 'auto', windowMs: null, units: 'tokens', middle: 'auto', scale: 'balanced', showCalls: false, overlay: true,
}

export interface UiState {
  view: ViewId
  selectedRootId: string | null
  selectedSessionId: string | null
  selectedActivityId: string | null
  selectedRunId: string | null
  selectedTaskId: string | null
  liveOnly: boolean
  harnessFilter: Harness | 'all'
  railQuery: string
  theme: 'light' | 'dark'
  dockWidth: number
  paletteOpen: boolean
  shortcutsOpen: boolean
  streamFilters: StreamFilters
  dagDirection: { session: 'RIGHT' | 'DOWN'; orchestration: 'RIGHT' | 'DOWN' }
  collapsedWorkspaces: Record<string, boolean>
  tokens: TokensPrefs
}

export const ACTIVITY_RING_MAX = 20_000
export const DOCK_MIN = 320
export const DOCK_MAX = 640
/** Ring cap for live usage samples. */
export const USAGE_RING_MAX = 50_000

export interface UsageSlice {
  samples: { byId: Record<string, UsageSample>; /** compareSamples order */ order: string[]; version: number }
  /** In-flight estimates keyed by sessionId. */
  estimates: Record<string, UsageEstimate>
}

/** Cache key of a usage report: `${kind}:${id ?? ''}:${windowMs ?? 'all'}:${middle ?? ''}`. */
export function usageReportKey(scope: UsageScope, windowMs: number | null | undefined, middle?: string | null): string {
  return `${scope.kind}:${scope.id ?? ''}:${windowMs ?? 'all'}:${middle ?? ''}`
}
export const usageCallsKey = (scope: UsageScope): string => `${scope.kind}:${scope.id ?? ''}`

export interface OccState {
  meta: ServerMeta | null
  bootstrapped: boolean
  /** Last bootstrap failure (cleared on success); the splash shows it and `init` retries every 3 s. */
  bootstrapError: string | null
  connection: ConnectionState
  lastEventAt: number | null
  seq: number
  sessions: Record<string, SessionSummary>
  /** Ring of the newest ≤ 20k events. `order` is ts-ascending; `version` bumps on every change. */
  activity: { byId: Record<string, ActivityEvent>; order: string[]; version: number }
  orca: OrcaSnapshot | null
  attention: AttentionItem[]
  stats: FleetStats | null
  orchestration: OrchestrationSummary | null
  details: Record<string, Loadable<SessionDetail>>
  trees: Record<string, Loadable<SessionTree>>
  transcripts: Record<string, Loadable<TranscriptPage>>
  parts: Record<string, Loadable<PartDetail>>
  diffs: Record<string, Loadable<FileDiff>>
  /** key: `root:<id>` | `session:<id>` | `all` */
  fileChanges: Record<string, Loadable<FileChange[]>>
  /** key: `root:<id>` | `all` */
  artifacts: Record<string, Loadable<Artifact[]>>
  /** key: `root:<id>` | `session:<id>` */
  scopedActivity: Record<string, Loadable<ActivityPage>>
  runs: Record<string, Loadable<OrchRunDetail>>
  tasks: Record<string, Loadable<OrchTaskDetail>>
  usage: UsageSlice
  /** key: see `usageReportKey` */
  usageReports: Record<string, Loadable<UsageReport>>
  /** key: `${kind}:${id ?? ''}` (pages merged, oldest → newest) */
  usageCalls: Record<string, Loadable<UsageCallsPage>>
  ui: UiState

  init(): Promise<void>
  applyBootstrap(b: BootstrapPayload): void
  applyStreamEvent(e: StreamEvent): void
  setConnection(c: ConnectionState): void

  /** Select a session (any depth); also selects its root, clears run/task selection. */
  selectSession(id: string | null, opts?: { activityId?: string }): void
  selectRoot(id: string | null): void
  selectActivity(id: string | null): void
  selectRun(id: string | null): void
  selectTask(id: string | null): void
  selectAdjacentRoot(delta: 1 | -1): void
  /** Steps over the selected root followed by its descendants (DFS order). */
  selectAdjacentCast(delta: 1 | -1): void
  setView(v: ViewId): void
  setLiveOnly(v: boolean): void
  setHarnessFilter(h: Harness | 'all'): void
  setRailQuery(q: string): void
  setTheme(t: 'light' | 'dark'): void
  toggleTheme(): void
  setDockWidth(px: number): void
  setPaletteOpen(v: boolean): void
  setShortcutsOpen(v: boolean): void
  setStreamFilters(p: Partial<StreamFilters>): void
  setDagDirection(kind: 'session' | 'orchestration', d: 'RIGHT' | 'DOWN'): void
  toggleWorkspaceCollapsed(key: string): void
  setTokensPrefs(p: Partial<TokensPrefs>): void

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
  fetchUsageReport(scope: UsageScope, o?: { windowMs?: number | null; bucketMs?: number; middle?: 'agent' | 'session' | 'model' | 'auto'; force?: boolean }): Promise<void>
  fetchUsageCalls(scope: UsageScope, o?: { older?: boolean; force?: boolean }): Promise<void>
}

/* ───────────────────────── helpers ───────────────────────── */

const idle = <T,>(): Loadable<T> => ({ status: 'idle', data: null, error: null, fetchedAt: null })

export const DEFAULT_STREAM_FILTERS: StreamFilters = {
  scope: 'all', kinds: [], harness: 'all', query: '', errorsOnly: false, follow: true, paused: false,
}

function loadUi(): UiState {
  const stored = getStored<Partial<StreamFilters>>('occ-stream-filters', {})
  return {
    ...defaultUi(),
    theme: getStored<'light' | 'dark'>('occ-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light') === 'light' ? 'light' : 'dark',
    dockWidth: clampDock(getStored<number>('occ-dock-width', 384)),
    liveOnly: getStored('occ-live-only', false),
    harnessFilter: getStored<Harness | 'all'>('occ-harness-filter', 'all'),
    streamFilters: { ...DEFAULT_STREAM_FILTERS, ...stored, paused: false },
    dagDirection: { session: 'RIGHT', orchestration: 'DOWN', ...getStored('occ-dag-direction', {}) },
    collapsedWorkspaces: getStored('occ-collapsed-workspaces', {}),
    tokens: { ...DEFAULT_TOKENS_PREFS, ...getStored<Partial<TokensPrefs>>('occ-tokens', {}) },
  }
}

function defaultUi(): UiState {
  return {
    view: 'dag', selectedRootId: null, selectedSessionId: null, selectedActivityId: null, selectedRunId: null, selectedTaskId: null,
    liveOnly: false, harnessFilter: 'all', railQuery: '', theme: 'dark', dockWidth: 384, paletteOpen: false, shortcutsOpen: false,
    streamFilters: { ...DEFAULT_STREAM_FILTERS }, dagDirection: { session: 'RIGHT', orchestration: 'DOWN' }, collapsedWorkspaces: {}, tokens: { ...DEFAULT_TOKENS_PREFS },
  }
}

const clampDock = (n: number) => (Number.isFinite(n) ? Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(n))) : 384)

function emptyData() {
  return {
    meta: null as ServerMeta | null, bootstrapped: false, bootstrapError: null as string | null, connection: 'connecting' as ConnectionState,
    lastEventAt: null as number | null, seq: 0, sessions: {} as Record<string, SessionSummary>,
    activity: { byId: {}, order: [], version: 0 } as OccState['activity'],
    orca: null as OrcaSnapshot | null, attention: [] as AttentionItem[], stats: null as FleetStats | null, orchestration: null as OrchestrationSummary | null,
    details: {}, trees: {}, transcripts: {}, parts: {}, diffs: {}, fileChanges: {}, artifacts: {}, scopedActivity: {}, runs: {}, tasks: {},
    usage: emptyUsage(), usageReports: {}, usageCalls: {},
  }
}

function emptyUsage(version = 0): UsageSlice {
  return { samples: { byId: {}, order: [], version }, estimates: {} }
}

/** Binary-search insert position keeping `order` sorted by event ts (stable for equal ts). */
function insertIndex(order: string[], byId: Record<string, ActivityEvent>, ts: number): number {
  let lo = 0
  let hi = order.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (byId[order[mid]].ts <= ts) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Binary-search insert position keeping `order` sorted by compareSamples. */
function usageInsertIndex(order: string[], byId: Record<string, UsageSample>, x: UsageSample): number {
  let lo = 0
  let hi = order.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compareSamples(byId[order[mid]], x) <= 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upsertSorted(events: ActivityEvent[], e: ActivityEvent): ActivityEvent[] {
  const i = events.findIndex((x) => x.id === e.id)
  if (i >= 0) {
    if (events[i].rev > e.rev) return events
    const next = events.slice()
    if (events[i].ts === e.ts) { next[i] = e; return next }
    next.splice(i, 1)
    next.splice(sortedIndex(next, e.ts), 0, e)
    return next
  }
  const next = events.slice()
  next.splice(sortedIndex(next, e.ts), 0, e)
  return next
}
function sortedIndex(events: ActivityEvent[], ts: number) {
  let lo = 0
  let hi = events.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (events[mid].ts <= ts) lo = mid + 1; else hi = mid }
  return lo
}

function mergeEventIntoTranscript(p: TranscriptPage, e: ActivityEvent, session: SessionSummary | undefined): TranscriptPage {
  if (!e.messageId) return p
  const mi = p.messages.findIndex((m) => m.id === e.messageId)
  if (mi >= 0) {
    const m = p.messages[mi]
    const items = upsertSorted(m.items, e)
    if (items === m.items) return p
    const messages = p.messages.slice()
    messages[mi] = { ...m, items }
    return { ...p, messages }
  }
  const msg: TranscriptMessage = {
    id: e.messageId, sessionId: e.sessionId ?? p.sessionId, role: e.kind === 'prompt' ? 'user' : 'assistant', agent: session?.agent ?? null, model: session?.model ?? null,
    createdAt: e.ts, completedAt: null, tokens: null, cost: null, finish: null, error: null, items: [e],
  }
  return { ...p, messages: [...p.messages, msg] }
}

/** Default selection after first bootstrap (Plan §7.2). */
function defaultRoot(sessions: Record<string, SessionSummary>): string | null {
  const roots = Object.values(sessions).filter((s) => s.parentId == null)
  if (!roots.length) return null
  const pri = (s: SessionSummary) => ({ blocked: 0, waiting: 1, working: 2, error: 3, unknown: 4, done: 5, idle: 6 })[s.state]
  const at = (s: SessionSummary) => s.lastActivityAt ?? s.updatedAt
  const live = roots.filter((s) => s.live).sort((a, b) => pri(a) - pri(b) || at(b) - at(a))
  if (live.length) return live[0].id
  return roots.sort((a, b) => b.updatedAt - a.updatedAt)[0].id
}

/* ───────────────────────── store ───────────────────────── */

const inflight = new Map<string, Promise<void>>()
let stream: StreamHandle | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let stopUrlSync: (() => void) | null = null
let resyncing: Promise<void> | null = null
/** Bumped per refetch; only the latest refetch may apply its bootstrap. */
let resyncEpoch = 0
/** Bumped whenever lazy caches are reset, so stale in-flight loads can't repopulate them. */
let cacheGen = 0
/** Stream frames received while a bootstrap refetch is in flight (re-applied if newer than it). */
let resyncBuffer: StreamEvent[] | null = null

export const useOcc = create<OccState>()(
  subscribeWithSelector((set, get) => {
    const patchUi = (p: Partial<UiState>) => set((s) => ({ ui: { ...s.ui, ...p } }))

    /** Generic cached fetch: dedupes in-flight requests, keeps stale data while loading, stores errors. */
    function load<T>(
      slice: 'details' | 'trees' | 'transcripts' | 'parts' | 'diffs' | 'fileChanges' | 'artifacts' | 'scopedActivity' | 'runs' | 'tasks' | 'usageReports' | 'usageCalls',
      key: string, fetcher: () => Promise<T>, o: { force?: boolean; dedupeKey?: string; merge?: (prev: T | null, next: T) => T } = {},
    ): Promise<void> {
      const cur = (get()[slice] as Record<string, Loadable<T>>)[key]
      if (!o.force && cur && (cur.status === 'ready' || cur.status === 'loading') && !o.merge) return inflight.get(`${slice}:${key}`) ?? Promise.resolve()
      const dk = `${slice}:${key}${o.dedupeKey ?? ''}`
      const running = inflight.get(dk)
      if (running) return running
      const gen = cacheGen
      const put = (l: Loadable<T>) => { if (gen === cacheGen) set((s) => ({ [slice]: { ...(s[slice] as Record<string, Loadable<T>>), [key]: l } }) as Partial<OccState>) }
      put({ status: 'loading', data: cur?.data ?? null, error: null, fetchedAt: cur?.fetchedAt ?? null })
      const p = fetcher().then(
        (data) => {
          const prev = ((get()[slice] as Record<string, Loadable<T>>)[key]?.data) ?? null
          put({ status: 'ready', data: o.merge ? o.merge(prev, data) : data, error: null, fetchedAt: Date.now() })
        },
        (err: unknown) => {
          const prev = ((get()[slice] as Record<string, Loadable<T>>)[key]?.data) ?? null
          put({ status: 'error', data: prev, error: err instanceof Error ? err.message : String(err), fetchedAt: null })
        },
      ).finally(() => { inflight.delete(dk) })
      inflight.set(dk, p)
      return p
    }

    /** Re-fetch what the current selection shows (lazy caches were just reset). */
    function refreshSelection() {
      const { selectedSessionId, selectedRootId } = get().ui
      if (selectedSessionId) {
        void get().fetchSessionDetail(selectedSessionId)
        void get().fetchTranscript(selectedSessionId)
      }
      const root = selectedRootId ?? (selectedSessionId ? get().sessions[selectedSessionId]?.rootId : null)
      if (root) void get().fetchTree(root)
    }

    function refetchBootstrap(): Promise<void> {
      const mine = ++resyncEpoch
      if (!resyncBuffer) resyncBuffer = []
      const run: Promise<void> = (async () => {
        try {
          const b = await api.get('GET /api/bootstrap')
          if (mine !== resyncEpoch) return // superseded by a newer refetch
          const buffered = resyncBuffer ?? []
          resyncBuffer = null
          get().applyBootstrap(b)
          for (const e of buffered) if ('seq' in e && e.seq > b.seq) get().applyStreamEvent(e)
          refreshSelection()
        } catch (err) {
          if (mine !== resyncEpoch) return
          resyncBuffer = null
          set({ bootstrapError: err instanceof Error ? err.message : String(err) })
        } finally { void Promise.resolve().then(() => { if (resyncing === run) resyncing = null }) }
      })()
      resyncing = run
      return run
    }

    const selectionPatch = (sessionId: string | null, activityId: string | null = null): Partial<UiState> => {
      const s = sessionId ? get().sessions[sessionId] : null
      return {
        selectedSessionId: sessionId, selectedActivityId: activityId, selectedRunId: null, selectedTaskId: null,
        ...(sessionId ? { selectedRootId: s ? s.rootId : get().ui.selectedRootId } : {}),
      }
    }

    return {
      ...emptyData(),
      ui: loadUi(),

      /* ───── lifecycle ───── */
      async init() {
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
        stream?.close(); stream = null
        stopUrlSync?.()
        const url = readUrlSelection()
        const ui = get().ui
        if (!get().bootstrapped) {
          patchUi({
            view: url.v ?? ui.view, selectedSessionId: url.s ?? ui.selectedSessionId, selectedRunId: url.r ?? ui.selectedRunId, selectedTaskId: url.t ?? ui.selectedTaskId,
          })
        }
        set({ connection: 'connecting' })
        try {
          const b = await api.get('GET /api/bootstrap')
          const again = get().bootstrapped
          get().applyBootstrap(b)
          if (again) refreshSelection()
        } catch (err) {
          set({ bootstrapError: err instanceof Error ? err.message : String(err), connection: 'offline' })
          retryTimer = setTimeout(() => { void get().init() }, 3000)
          return
        }
        stream = connectStream({ since: get().seq, onEvent: (e) => get().applyStreamEvent(e), onState: (c) => get().setConnection(c) })
        stopUrlSync = startUrlSync((cb) => useOcc.subscribe((s) => s.ui, cb))
      },

      applyBootstrap(b) {
        if (get().bootstrapped) { cacheGen++; inflight.clear() }
        set((s) => {
          const sessions: Record<string, SessionSummary> = {}
          for (const x of b.sessions) sessions[x.id] = x
          const byId: Record<string, ActivityEvent> = {}
          const sorted = [...b.activity].sort((a, c) => a.ts - c.ts)
          const capped = sorted.slice(-ACTIVITY_RING_MAX)
          for (const e of capped) byId[e.id] = e
          let ui = s.ui
          if (!s.bootstrapped) {
            const sel = ui.selectedSessionId && sessions[ui.selectedSessionId] ? ui.selectedSessionId : null
            if (sel) ui = { ...ui, selectedRootId: sessions[sel].rootId }
            else if (!ui.selectedRunId) {
              const d = defaultRoot(sessions)
              ui = { ...ui, selectedSessionId: d, selectedRootId: d }
            } else ui = { ...ui, selectedSessionId: null }
          }
          const reset = s.bootstrapped ? { details: {}, trees: {}, transcripts: {}, parts: {}, diffs: {}, fileChanges: {}, artifacts: {}, scopedActivity: {}, runs: {}, tasks: {}, usageReports: {}, usageCalls: {}, usage: emptyUsage(s.usage.samples.version + 1) } : {}
          return {
            ...reset,
            meta: b.meta, bootstrapped: true, bootstrapError: null, seq: b.seq, sessions, activity: { byId, order: capped.map((e) => e.id), version: s.activity.version + 1 },
            orca: b.orca, attention: b.attention, stats: b.stats, orchestration: b.orchestration, lastEventAt: Date.now(), ui,
          }
        })
      },

      applyStreamEvent(e) {
        const st = get()
        if (e.type === 'hello') {
          if (st.meta && st.meta.bootId !== e.bootId) { void refetchBootstrap(); return }
          set({ meta: e.meta, lastEventAt: Date.now() })
          return
        }
        if (e.type === 'resync') { void refetchBootstrap(); return }
        if (resyncBuffer) { resyncBuffer.push(e); return }
        if (e.seq <= st.seq) return // replayed frame we already applied
        switch (e.type) {
          case 'activity': {
            set((s) => {
              const byId = s.activity.byId
              const order = s.activity.order
              let changed = false
              let transcripts = s.transcripts
              let scoped = s.scopedActivity
              for (const ev of e.events) {
                const prev = byId[ev.id]
                if (prev && prev.rev > ev.rev) continue
                changed = true
                if (prev) {
                  byId[ev.id] = ev
                  if (prev.ts !== ev.ts) { order.splice(order.indexOf(ev.id), 1); order.splice(insertIndex(order, byId, ev.ts), 0, ev.id) }
                } else {
                  byId[ev.id] = ev
                  order.splice(insertIndex(order, byId, ev.ts), 0, ev.id)
                }
                const t = ev.sessionId ? transcripts[ev.sessionId] : undefined
                if (t?.data) {
                  const next = mergeEventIntoTranscript(t.data, ev, ev.sessionId ? s.sessions[ev.sessionId] : undefined)
                  if (next !== t.data) transcripts = { ...transcripts, [ev.sessionId!]: { ...t, data: next } }
                }
                for (const k of [ev.sessionId ? `session:${ev.sessionId}` : null, ev.rootId ? `root:${ev.rootId}` : null]) {
                  const sc = k ? scoped[k] : undefined
                  if (k && sc?.data) {
                    const events = upsertSorted(sc.data.events, ev)
                    if (events !== sc.data.events) scoped = { ...scoped, [k]: { ...sc, data: { ...sc.data, events } } }
                  }
                }
              }
              while (order.length > ACTIVITY_RING_MAX) { const id = order.shift()!; delete byId[id] }
              if (!changed) return { seq: e.seq, lastEventAt: Date.now() }
              return { seq: e.seq, lastEventAt: Date.now(), activity: { byId, order, version: s.activity.version + 1 }, transcripts, scopedActivity: scoped }
            })
            return
          }
          case 'sessions': {
            set((s) => {
              const sessions = { ...s.sessions }
              let trees = s.trees
              let details = s.details
              for (const x of e.sessions) {
                sessions[x.id] = x
                const tr = trees[x.rootId]
                if (tr?.data) {
                  const nodes = tr.data.nodes.slice()
                  const ni = nodes.findIndex((n) => n.id === x.id)
                  let edges = tr.data.edges
                  if (ni >= 0) nodes[ni] = x
                  else {
                    nodes.push(x)
                    if (x.parentId && !edges.some((ed) => ed.to === x.id)) {
                      edges = [...edges, { id: `edge:${x.parentId}:${x.id}`, from: x.parentId, to: x.id, label: x.spawn?.description ?? null, status: x.spawn?.status ?? null, activityId: x.spawn?.activityId || null }]
                    }
                  }
                  if (ni >= 0 && x.spawn) edges = edges.map((ed) => (ed.to === x.id ? { ...ed, label: x.spawn!.description, status: x.spawn!.status } : ed))
                  trees = { ...trees, [x.rootId]: { ...tr, data: { ...tr.data, nodes, edges } } }
                }
                const d = details[x.id]
                if (d?.data) details = { ...details, [x.id]: { ...d, data: { ...d.data, session: x } } }
              }
              for (const id of e.removed) {
                const old = sessions[id]
                delete sessions[id]
                const tr = old ? trees[old.rootId] : undefined
                if (old && tr?.data) {
                  trees = { ...trees, [old.rootId]: { ...tr, data: { ...tr.data, nodes: tr.data.nodes.filter((n) => n.id !== id), edges: tr.data.edges.filter((ed) => ed.from !== id && ed.to !== id) } } }
                }
              }
              return { seq: e.seq, lastEventAt: Date.now(), sessions, trees, details }
            })
            // A selected session evicted from the window keeps its selection (no blank inspector):
            // show the "outside the 24 h window" notice and still try to load its detail.
            const sel = get().ui.selectedSessionId
            if (sel && e.removed.includes(sel)) {
              addNotice(`s:${sel}`, `Session ${sel} is outside the 24 h window.`)
              void get().fetchSessionDetail(sel, { force: true })
            }
            return
          }
          case 'orca':
            set((s) => ({ seq: e.seq, lastEventAt: Date.now(), orca: { ...(s.orca ?? { status: e.orca.status ?? { running: false, reachable: false, pid: null, version: null, runtimeState: null, checkedAt: Date.now(), error: null }, worktrees: [], terminals: [], hooks: [] }), ...e.orca } as OrcaSnapshot }))
            return
          case 'attention': set({ seq: e.seq, lastEventAt: Date.now(), attention: e.items }); return
          case 'stats': set({ seq: e.seq, lastEventAt: Date.now(), stats: e.stats }); return
          case 'meta': set({ seq: e.seq, lastEventAt: Date.now(), meta: e.meta }); return
          case 'usage': {
            const accepted: UsageSample[] = []
            set((s) => {
              const byId = s.usage.samples.byId
              const order = s.usage.samples.order
              for (const x of e.samples) {
                const prev = byId[x.id]
                if (prev && prev.ledgerSeq > x.ledgerSeq) continue
                accepted.push(x)
                if (prev) {
                  byId[x.id] = x
                  if (prev.ts === x.ts) continue
                  order.splice(order.indexOf(x.id), 1)
                } else byId[x.id] = x
                order.splice(usageInsertIndex(order, byId, x), 0, x.id)
              }
              while (order.length > USAGE_RING_MAX) { const id = order.shift()!; delete byId[id] }
              let estimates = s.usage.estimates
              if (e.estimates.length) {
                estimates = { ...estimates }
                for (const est of e.estimates) {
                  if (est.inFlight) estimates[est.sessionId] = est
                  else delete estimates[est.sessionId]
                }
              }
              return {
                seq: e.seq, lastEventAt: Date.now(),
                usage: { samples: { byId, order, version: s.usage.samples.version + 1 }, estimates },
              }
            })
            // After the state update, so listeners reading the store see the new data.
            usageBus.emit({ samples: accepted, estimates: e.estimates })
            return
          }
          case 'orchestration':
            set({ seq: e.seq, lastEventAt: Date.now(), orchestration: e.summary })
            for (const id of e.changedRunIds) if (get().runs[id]) void get().fetchRun(id, { force: true })
            return
        }
      },

      setConnection(c) { set({ connection: c }) },

      /* ───── selection ───── */
      selectSession(id, opts) { patchUi(selectionPatch(id, opts?.activityId ?? null)) },
      selectRoot(id) {
        patchUi({ selectedRootId: id, selectedSessionId: id, selectedActivityId: null, selectedRunId: null, selectedTaskId: null })
      },
      selectActivity(id) { patchUi({ selectedActivityId: id }) },
      selectRun(id) { patchUi({ selectedRunId: id, selectedTaskId: null }) },
      selectTask(id) { patchUi({ selectedTaskId: id }) },
      selectAdjacentRoot(delta) {
        const roots = selectRootSessions(get())
        if (!roots.length) return
        const i = roots.findIndex((r) => r.id === get().ui.selectedRootId)
        const n = i < 0 ? (delta > 0 ? 0 : roots.length - 1) : (i + delta + roots.length) % roots.length
        get().selectRoot(roots[n].id)
      },
      selectAdjacentCast(delta) {
        const root = get().ui.selectedRootId
        if (!root || !get().sessions[root]) return
        const cast = [get().sessions[root], ...selectDescendants(get(), root)]
        const i = cast.findIndex((c) => c.id === get().ui.selectedSessionId)
        const n = i < 0 ? 0 : (i + delta + cast.length) % cast.length
        get().selectSession(cast[n].id)
      },
      setView(v) { patchUi({ view: v }) },
      setLiveOnly(v) { patchUi({ liveOnly: v }) },
      setHarnessFilter(h) { patchUi({ harnessFilter: h }) },
      setRailQuery(q) { patchUi({ railQuery: q }) },
      setTheme(t) { patchUi({ theme: t }) },
      toggleTheme() { patchUi({ theme: get().ui.theme === 'dark' ? 'light' : 'dark' }) },
      setDockWidth(px) { patchUi({ dockWidth: clampDock(px) }) },
      setPaletteOpen(v) { patchUi({ paletteOpen: v }) },
      setShortcutsOpen(v) { patchUi({ shortcutsOpen: v }) },
      setStreamFilters(p) { patchUi({ streamFilters: { ...get().ui.streamFilters, ...p } }) },
      setDagDirection(kind, d) { patchUi({ dagDirection: { ...get().ui.dagDirection, [kind]: d } }) },
      setTokensPrefs(p) { patchUi({ tokens: { ...get().ui.tokens, ...p } }) },
      toggleWorkspaceCollapsed(key) {
        const c = get().ui.collapsedWorkspaces
        patchUi({ collapsedWorkspaces: { ...c, [key]: !c[key] } })
      },

      /* ───── fetchers ───── */
      fetchSessionDetail(id, o) { return load('details', id, () => api.get('GET /api/sessions/:id', { path: { id } }), o) },
      fetchTree(rootId, o) { return load('trees', rootId, () => api.get('GET /api/sessions/:id/tree', { path: { id: rootId } }), o) },
      fetchTranscript(sessionId, o) {
        const cur = get().transcripts[sessionId]
        if (o?.older) {
          const before = cur?.data?.before
          if (!cur?.data?.hasMore || !before) return Promise.resolve()
          return load('transcripts', sessionId, () => api.get('GET /api/sessions/:id/transcript', { path: { id: sessionId }, params: { before, limit: LIMITS.transcriptPageDefault } }), {
            force: true, dedupeKey: ':older',
            merge: (prev, next) => {
              const seen = new Set(prev?.messages.map((m) => m.id))
              return { ...next, messages: [...next.messages.filter((m) => !seen.has(m.id)), ...(prev?.messages ?? [])] }
            },
          })
        }
        return load('transcripts', sessionId, () => api.get('GET /api/sessions/:id/transcript', { path: { id: sessionId }, params: { limit: LIMITS.transcriptPageDefault } }), o)
      },
      fetchPart(id) { return load('parts', id, () => api.get('GET /api/parts/:id', { path: { id } })) },
      fetchDiff(id) { return load('diffs', id, () => api.get('GET /api/file-changes/:id/diff', { path: { id } })) },
      fetchFileChanges(scope, o) {
        const key = scope.sessionId ? `session:${scope.sessionId}` : scope.rootId ? `root:${scope.rootId}` : 'all'
        return load('fileChanges', key, async () => (await api.get('GET /api/file-changes', { params: { rootId: scope.sessionId ? undefined : scope.rootId, sessionId: scope.sessionId } })).changes, o)
      },
      fetchArtifacts(scope, o) {
        const key = scope.rootId ? `root:${scope.rootId}` : 'all'
        return load('artifacts', key, async () => (await api.get('GET /api/artifacts', { params: { rootId: scope.rootId } })).artifacts, o)
      },
      fetchScopedActivity(scope, o) {
        const key = scope.sessionId ? `session:${scope.sessionId}` : scope.rootId ? `root:${scope.rootId}` : ''
        if (!key) return Promise.resolve()
        const params = { sessionId: scope.sessionId, rootId: scope.sessionId ? undefined : scope.rootId, kinds: o?.kinds?.length ? o.kinds.join(',') : undefined, limit: 500 }
        if (o?.older) {
          const cur = get().scopedActivity[key]?.data
          if (!cur?.hasMore || !cur.before) return Promise.resolve()
          return load('scopedActivity', key, () => api.get('GET /api/activity', { params: { ...params, before: cur.before! } }), {
            force: true, dedupeKey: ':older',
            merge: (prev, next) => {
              const seen = new Set(prev?.events.map((x) => x.id))
              return { events: [...next.events.filter((x) => !seen.has(x.id)), ...(prev?.events ?? [])], before: next.before, hasMore: next.hasMore }
            },
          })
        }
        return load('scopedActivity', key, () => api.get('GET /api/activity', { params }), o)
      },
      fetchRun(id, o) { return load('runs', id, () => api.get('GET /api/orchestration/runs/:id', { path: { id } }), o) },
      fetchTask(id, o) { return load('tasks', id, () => api.get('GET /api/orchestration/tasks/:id', { path: { id } }), o) },
      fetchUsageReport(scope, o) {
        const windowMs = o?.windowMs ?? null
        const middle = o?.middle && o.middle !== 'auto' ? o.middle : undefined
        const key = usageReportKey(scope, windowMs, middle)
        return load('usageReports', key, () => api.get('GET /api/usage', {
          params: {
            scope: scope.kind, id: scope.id ?? undefined, windowHours: windowMs != null ? windowMs / 3_600_000 : undefined,
            bucketMs: o?.bucketMs, middle,
          },
        }), { force: o?.force, dedupeKey: o?.bucketMs ? `:${o.bucketMs}` : undefined })
      },
      fetchUsageCalls(scope, o) {
        const key = usageCallsKey(scope)
        const params = { scope: scope.kind, id: scope.id ?? undefined, limit: 200 }
        if (o?.older) {
          const cur = get().usageCalls[key]?.data
          if (!cur?.hasMore || !cur.before) return Promise.resolve()
          return load('usageCalls', key, () => api.get('GET /api/usage/calls', { params: { ...params, before: cur.before! } }), {
            force: true, dedupeKey: ':older',
            merge: (prev, next) => {
              const seen = new Set(prev?.calls.map((c) => c.id))
              return { calls: [...next.calls.filter((c) => !seen.has(c.id)), ...(prev?.calls ?? [])], before: next.before, hasMore: next.hasMore }
            },
          })
        }
        return load('usageCalls', key, () => api.get('GET /api/usage/calls', { params }), o)
      },
    }
  }),
)

/** Test helper: reset data and ui to defaults (no localStorage read), optionally overriding `ui`. */
export function resetOccStore(ui: Partial<UiState> = {}): void {
  inflight.clear()
  stream?.close(); stream = null
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  stopUrlSync?.(); stopUrlSync = null
  resyncing = null
  resyncEpoch++
  cacheGen++
  resyncBuffer = null
  useOcc.setState({ ...emptyData(), ui: { ...defaultUi(), ...ui } })
}

/* ───────── persistence & theme side effects ───────── */

function applyTheme(t: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', t === 'dark')
}
applyTheme(useOcc.getState().ui.theme)
useOcc.subscribe((s) => s.ui.theme, (t) => { applyTheme(t); setStored('occ-theme', t) })
useOcc.subscribe((s) => s.ui.dockWidth, (v) => setStored('occ-dock-width', v))
useOcc.subscribe((s) => s.ui.liveOnly, (v) => setStored('occ-live-only', v))
useOcc.subscribe((s) => s.ui.harnessFilter, (v) => setStored('occ-harness-filter', v))
useOcc.subscribe((s) => s.ui.streamFilters, (v) => setStored('occ-stream-filters', { ...v, paused: false }))
useOcc.subscribe((s) => s.ui.dagDirection, (v) => setStored('occ-dag-direction', v))
useOcc.subscribe((s) => s.ui.collapsedWorkspaces, (v) => setStored('occ-collapsed-workspaces', v))
useOcc.subscribe((s) => s.ui.tokens, (v) => setStored('occ-tokens', v))
