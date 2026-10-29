/**
 * Generic tailing runtime for harnesses that log one append-only JSONL file per session
 * (Claude Code, Codex, Cursor). A layout enumerates session files and builds a parser
 * (`TranscriptModel`) per file; this module owns discovery, incremental reads, LRU eviction,
 * subagent linking, health and the HarnessSource query surface. Read-only: files are only
 * stat'ed, listed and read.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import {
  LIMITS,
  type ActivityEvent,
  type ActivityPage,
  type FileChange,
  type FileDiff,
  type Harness,
  type PartDetail,
  type SessionCounters,
  type SourceHealth,
  type SourceId,
  type SpawnInfo,
  type ToolStat,
  type TranscriptPage,
} from '../../../shared/contract.js'
import type { ActivityQueryOptions, HarnessSession, HarnessSource, HarnessUpdate, SourceDeps, Unsubscribe } from '../../types.js'
import { watchDirectory, type Watcher } from '../../lib/fs-watch.js'
import { oneLine } from '../../lib/text.js'
import { createToolClassifier, type ToolClassifier } from '../../lib/tool-classify.js'
import type { TranscriptModel } from './model.js'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const DEFAULT_POLL_MS = 2000
const MAX_IDLE_MODELS = 50
/** Files outside the window are re-stat'ed only every N ticks. */
const STALE_STAT_EVERY = 5

export interface DirItem {
  name: string
  isDir: boolean
  isFile: boolean
}

/** Cached readdir: a directory is re-listed only when its mtime changed. null = unreadable. */
export type Lister = (dir: string) => DirItem[] | null

export interface JsonlRef {
  /** Session id (harness-native, colon-free). */
  id: string
  file: string
  /** Parent session id when the layout knows it from the path (e.g. Claude Code subagents). */
  parentId: string | null
}

export interface JsonlLayout {
  id: SourceId
  harness: Harness
  label: string
  /** Root directory: the health path, watched for changes. null = source disabled. */
  root: string | null
  disabledDetail: string
  missingDetail: string
  discover(ls: Lister): JsonlRef[]
  createModel(ref: JsonlRef, classifier: ToolClassifier): TranscriptModel
  /** Re-read optional sidecar metadata; return true when the session changed. */
  refresh?(ref: JsonlRef, model: TranscriptModel): boolean
}

export interface JsonlSourceOptions {
  /** Stat-poll interval (default 2000 ms). Tests use a small value. */
  pollMs?: number
}

interface Entry {
  ref: JsonlRef
  mtimeMs: number
  size: number
  model: TranscriptModel | null
  snapshot?: HarnessSession
  snapshotMtimeMs?: number
  snapshotParentId?: string | null
  lastUsed?: number
}

function readRange(file: string, start: number, end: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const len = Math.max(0, end - start)
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got)
      if (n <= 0) break
      got += n
    }
    return got === len ? buf : buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

const cursorOf = (e: ActivityEvent): string => `${e.ts}:${e.id}`
function afterCursor(e: ActivityEvent, cursor: string): boolean {
  const i = cursor.indexOf(':')
  const ts = Number(cursor.slice(0, i))
  const id = cursor.slice(i + 1)
  return e.ts > ts || (e.ts === ts && e.id >= id)
}
const byTime = (a: ActivityEvent, b: ActivityEvent) => a.ts - b.ts || (a.id < b.id ? -1 : 1)
const normPrompt = (s: string) => oneLine(s).slice(0, 2000)

const EMPTY_COUNTERS: SessionCounters = { messages: 0, steps: 0, thinking: 0, tools: 0, toolErrors: 0, mcpCalls: 0, fileChanges: 0, filesTouched: 0, subagents: 0 }

export function createJsonlSource(deps: SourceDeps, layout: JsonlLayout, options: JsonlSourceOptions = {}): HarnessSource {
  const { config, log, now } = deps
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const root = layout.root
  const tag = layout.id
  const classifier = createToolClassifier({ knownServers: config.mcpServers })
  const entries = new Map<string, Entry>()
  const listeners = new Set<(u: HarnessUpdate) => void>()
  const dirCache = new Map<string, { mtimeMs: number; items: DirItem[] }>()
  let watcher: Watcher | null = null
  let timer: NodeJS.Timeout | null = null
  let started = false
  let ticking = false
  let rerun = false
  let tickNo = 0
  let degradedDetail: string | null = null
  let status: SourceHealth['status'] = root ? 'starting' : 'disabled'
  let detail: string | null = root ? null : layout.disabledDetail
  let lastReadAt: number | null = null
  let lastChangeAt: number | null = null
  let version: string | null = null

  const emit = (u: HarnessUpdate) => {
    for (const l of [...listeners]) {
      try {
        l(u)
      } catch (e) {
        log.warn(`${tag}: listener failed`, e)
      }
    }
  }

  const ls: Lister = (dir) => {
    let mtimeMs: number
    try {
      mtimeMs = statSync(dir).mtimeMs
    } catch {
      dirCache.delete(dir)
      return null
    }
    const hit = dirCache.get(dir)
    if (hit && hit.mtimeMs === mtimeMs) return hit.items
    try {
      const items = readdirSync(dir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile() }))
      dirCache.set(dir, { mtimeMs, items })
      return items
    } catch {
      return null
    }
  }

  const inWindow = (mtimeMs: number) => mtimeMs >= now() - config.windowMs

  function statEntry(e: Entry): boolean {
    try {
      const st = statSync(e.ref.file)
      e.mtimeMs = st.mtimeMs
      e.size = st.size
      return true
    } catch {
      return false
    }
  }

  /**
   * Feed a byte chunk; only complete (newline-terminated) lines are consumed. Lines without a
   * timestamp are stamped 1 ms apart ending at the file mtime, which keeps them in file order.
   */
  function feed(model: TranscriptModel, buf: Buffer, dropFirst: boolean, mtimeMs: number): void {
    let startIdx = 0
    if (dropFirst) {
      const nl = buf.indexOf(10)
      if (nl < 0) return
      startIdx = nl + 1
      model.offset += startIdx
    }
    const last = buf.lastIndexOf(10)
    if (last < startIdx) return
    const text = buf.subarray(startIdx, last + 1).toString('utf8')
    const lines = text.split('\n')
    model.fallbackTs = mtimeMs - lines.length
    for (const line of lines) model.ingest(line)
    model.offset += last + 1 - startIdx
  }

  function load(e: Entry): TranscriptModel {
    const model = layout.createModel(e.ref, classifier)
    if (e.ref.parentId) model.parentId = e.ref.parentId
    let size = 0
    let mtime = e.mtimeMs
    try {
      const st = statSync(e.ref.file)
      size = st.size
      mtime = st.mtimeMs
    } catch {
      /* gone */
    }
    model.fileMtimeMs = mtime
    model.fallbackTs = mtime
    try {
      // Sidecar metadata first, so relative tool paths resolve against a known cwd.
      layout.refresh?.(e.ref, model)
    } catch {
      /* optional sidecar */
    }
    if (size > 0) {
      const start = Math.max(0, size - MAX_FILE_BYTES)
      try {
        model.offset = start
        feed(model, readRange(e.ref.file, start, size), start > 0, mtime)
        if (start > 0) {
          model.truncatedHead = true
          degradedDetail = `${e.ref.id.slice(0, 8)}: only last 20 MB parsed`
        }
      } catch (err) {
        log.warn(`${tag}: cannot read ${e.ref.id}`, err)
      }
    }
    model.size = size
    e.size = size
    e.mtimeMs = mtime
    e.model = model
    e.snapshot = undefined
    model.drain()
    model.todosDirty = false
    if (model.version) version = model.version
    return model
  }

  function ensure(e: Entry): TranscriptModel {
    e.lastUsed = now()
    if (e.model) return e.model
    const m = load(e)
    linkSpawn(m)
    evictExcess(e)
    return m
  }

  function evictExcess(keep?: Entry): void {
    const idle = [...entries.values()].filter((x) => x.model && x !== keep && !inWindow(x.mtimeMs) && x.model.state() !== 'working')
    if (idle.length <= MAX_IDLE_MODELS) return
    idle.sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0))
    for (const x of idle.slice(0, idle.length - MAX_IDLE_MODELS)) {
      x.snapshot = x.model!.toSession()
      x.snapshotMtimeMs = x.mtimeMs
      x.snapshotParentId = x.model!.parentId
      x.model = null
    }
  }

  function parentOf(e: Entry): string | null {
    return e.ref.parentId ?? e.model?.parentId ?? e.snapshotParentId ?? null
  }

  function childEntries(parentId: string): Entry[] {
    return [...entries.values()].filter((x) => x.ref.id !== parentId && parentOf(x) === parentId)
  }

  /** Link a subagent session to its parent's spawning tool call. Returns ids whose session changed. */
  function linkSpawn(child: TranscriptModel): string[] {
    if (!child.parentId) return []
    const pe = entries.get(child.parentId)
    if (!pe) return []
    const parent = pe.model ?? (pe.lastUsed = now(), load(pe))
    const calls = parent.subagentCalls()
    const prompt = child.firstPromptRaw ? normPrompt(child.firstPromptRaw) : null
    const rec =
      calls.find((r) => r.childId === child.id || r.ev.childSessionId === child.id) ??
      (prompt ? calls.find((r) => !r.ev.childSessionId && !r.childId && r.childPrompt && normPrompt(r.childPrompt) === prompt) : undefined)
    if (!rec) return []
    const changed: string[] = []
    if (rec.ev.childSessionId !== child.id) {
      rec.ev.childSessionId = child.id
      rec.ev.rev = Math.max(rec.ev.rev + 1, now())
      parent.touch(rec.ev.id)
      changed.push(parent.id)
    }
    const spawn: SpawnInfo = {
      parentSessionId: parent.id,
      activityId: rec.ev.id,
      callId: rec.callId,
      description: rec.description ?? (rec.childPrompt ? oneLine(rec.childPrompt).slice(0, 140) : rec.ev.title),
      subagentType: rec.subagentType,
      status: parent.spawnStatus(rec, child),
    }
    if (rec.subagentType) child.agent = rec.subagentType
    if (!child.title && rec.description) child.title = rec.description
    if (JSON.stringify(spawn) !== JSON.stringify(child.spawn)) {
      child.spawn = spawn
      changed.push(child.id)
    }
    return changed
  }

  function discover(): { added: Entry[]; removed: string[] } {
    const added: Entry[] = []
    const removed: string[] = []
    if (!root) return { added, removed }
    if (ls(root) === null) {
      status = 'missing'
      detail = layout.missingDetail
      return { added, removed }
    }
    let refs: JsonlRef[]
    try {
      refs = layout.discover(ls)
    } catch (e) {
      log.warn(`${tag}: discovery failed`, e)
      return { added, removed }
    }
    const seen = new Set<string>()
    for (const ref of refs) {
      if (seen.has(ref.id)) continue
      seen.add(ref.id)
      const known = entries.get(ref.id)
      if (known) {
        if (known.ref.file !== ref.file) known.ref = ref
        continue
      }
      const e: Entry = { ref, mtimeMs: 0, size: 0, model: null }
      if (!statEntry(e)) continue
      entries.set(ref.id, e)
      added.push(e)
    }
    for (const id of [...entries.keys()]) {
      if (!seen.has(id)) {
        entries.delete(id)
        removed.push(id)
      }
    }
    return { added, removed }
  }

  function setHealth(): void {
    if (!root || status === 'missing') return
    const loaded = [...entries.values()].filter((e) => e.model).length
    status = degradedDetail ? 'degraded' : 'ok'
    detail = degradedDetail ?? `${entries.size} sessions, ${loaded} parsed`
  }

  function tick(initial: boolean): void {
    if (!root) return
    tickNo++
    lastReadAt = now()
    const prevStatus = status
    const { added, removed } = discover()
    if (status === 'missing') return
    if (prevStatus === 'missing') status = 'ok'
    const changed = new Map<string, TranscriptModel>()
    const changedEvents = new Map<string, ActivityEvent>()
    const todoSessions = new Set<string>()
    let reset: string | null = removed.length ? 'session file removed' : null
    const collect = (m: TranscriptModel, all = false) => {
      changed.set(m.id, m)
      for (const id of m.drain()) {
        const ev = m.events.get(id)
        if (ev) changedEvents.set(id, ev)
      }
      if (all) for (const ev of m.events.values()) changedEvents.set(ev.id, ev)
      if (m.todosDirty) {
        m.todosDirty = false
        todoSessions.add(m.id)
      }
    }
    for (const e of entries.values()) {
      try {
        const isNew = added.includes(e)
        if (!e.model) {
          if (!isNew && (inWindow(e.mtimeMs) || tickNo % STALE_STAT_EVERY === 0 || initial)) {
            const before = e.mtimeMs
            if (!statEntry(e)) continue
            if (e.snapshot && e.mtimeMs === before) continue
          }
          if (inWindow(e.mtimeMs)) collect(load(e), true)
          continue
        }
        const m = e.model
        let st
        try {
          st = statSync(e.ref.file)
        } catch {
          st = null
        }
        if (!st) continue
        let dirty = false
        if (st.size < m.size) {
          degradedDetail = null
          reset = reset ?? `${e.ref.id} was truncated`
          collect(load(e), true)
          continue
        }
        if (st.size > m.offset) {
          let pos = m.offset
          while (pos < st.size) {
            const end = Math.min(st.size, pos + MAX_FILE_BYTES)
            const before = m.offset
            feed(m, readRange(e.ref.file, pos, end), false, st.mtimeMs)
            if (m.offset === before) break // only a partial line available
            pos = m.offset
          }
          m.size = st.size
          dirty = true
        }
        if (st.mtimeMs !== m.fileMtimeMs) {
          m.fileMtimeMs = st.mtimeMs
          e.mtimeMs = st.mtimeMs
          e.size = st.size
          dirty = true
        }
        if (dirty) {
          try {
            layout.refresh?.(e.ref, m)
          } catch {
            /* optional */
          }
          collect(m)
          if (m.version) version = m.version
        }
      } catch (err) {
        log.warn(`${tag}: failed reading session ${e.ref.id}`, err)
      }
    }
    // Subagent linking: a changed child links to its parent; a changed parent refreshes its children.
    for (const m of [...changed.values()]) {
      const ids = linkSpawn(m)
      for (const ce of childEntries(m.id)) if (ce.model) ids.push(...linkSpawn(ce.model))
      for (const id of ids) {
        const x = entries.get(id)?.model
        if (x) collect(x)
      }
    }
    evictExcess()
    setHealth()
    if (changed.size || changedEvents.size) lastChangeAt = now()
    if (initial) return
    if (reset) emit({ type: 'reset', reason: reset })
    const sessions = [...changed.values()].filter((m) => !m.hidden).map((m) => m.toSession())
    if (sessions.length) emit({ type: 'sessions', sessions })
    const events = [...changedEvents.values()].filter((ev) => !entries.get(ev.sessionId ?? '')?.model?.hidden)
    if (events.length) emit({ type: 'activity', events: events.sort(byTime) })
    for (const sid of todoSessions) {
      const m = entries.get(sid)?.model
      if (m?.todos && !m.hidden) emit({ type: 'todos', sessionId: sid, todos: m.todos })
    }
  }

  function safeTick(): void {
    if (ticking) {
      rerun = true
      return
    }
    ticking = true
    try {
      do {
        rerun = false
        try {
          tick(false)
        } catch (e) {
          log.warn(`${tag}: tick failed`, e)
        }
      } while (rerun)
    } finally {
      ticking = false
    }
  }

  function modelOf(id: string): TranscriptModel | null {
    const e = entries.get(id)
    if (!e) return null
    const m = ensure(e)
    return m.hidden ? null : m
  }

  const prefix = `${layout.harness}:`
  function sessionIdOfActivity(id: string): string | null {
    if (!id.startsWith(prefix)) return null
    const rest = id.slice(prefix.length)
    const i = rest.indexOf(':')
    return i > 0 ? rest.slice(0, i) : null
  }

  return {
    id: layout.id,
    harness: layout.harness,

    async start() {
      if (started) return
      started = true
      if (!root) return
      try {
        statSync(root)
      } catch {
        status = 'missing'
        detail = layout.missingDetail
        // Keep polling: the directory may appear once the harness is first used.
      }
      try {
        tick(true)
      } catch (e) {
        log.warn(`${tag}: initial scan failed`, e)
        status = 'error'
        detail = e instanceof Error ? e.message : String(e)
      }
      try {
        watcher = watchDirectory(root, safeTick, { log })
      } catch {
        watcher = null
      }
      timer = setInterval(safeTick, pollMs)
      timer.unref?.()
    },

    async stop() {
      started = false
      if (timer) clearInterval(timer)
      timer = null
      watcher?.close()
      watcher = null
    },

    health(): SourceHealth {
      return { id: layout.id, label: layout.label, status, path: root, version, detail, lastReadAt, lastChangeAt }
    },

    subscribe(listener): Unsubscribe {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    listSessions(sinceMs) {
      const out: HarnessSession[] = []
      for (const e of entries.values()) {
        if (!e.model && e.mtimeMs < sinceMs) continue
        if (!e.model && e.snapshot && e.snapshotMtimeMs === e.mtimeMs) {
          if (e.snapshot.updatedAt >= sinceMs) out.push(e.snapshot)
          continue
        }
        const m = ensure(e)
        if (m.hidden) continue
        const s = m.toSession()
        if (s.updatedAt >= sinceMs) out.push(s)
      }
      return out
    },

    getSession(id) {
      return modelOf(id)?.toSession() ?? null
    },

    getChildren(id) {
      const out: HarnessSession[] = []
      for (const ce of childEntries(id)) {
        const m = ensure(ce)
        if (!m.hidden) out.push(m.toSession())
      }
      return out.sort((a, b) => a.createdAt - b.createdAt)
    },

    getCounters(id): SessionCounters {
      return modelOf(id)?.counters() ?? { ...EMPTY_COUNTERS }
    },

    getToolStats(sessionIds): ToolStat[] {
      const map = new Map<string, ToolStat>()
      for (const sid of sessionIds) {
        const m = modelOf(sid)
        if (!m) continue
        for (const ev of m.events.values()) {
          if (!ev.tool) continue
          const s = map.get(ev.tool.name) ?? { name: ev.tool.name, category: ev.tool.category, mcpServer: ev.tool.mcpServer, calls: 0, errors: 0 }
          s.calls++
          if (ev.status === 'error') s.errors++
          map.set(ev.tool.name, s)
        }
      }
      return [...map.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    },

    getTodos(id) {
      return modelOf(id)?.todos ?? []
    },

    getTranscript(id, opts): TranscriptPage {
      const m = modelOf(id)
      const limit = Math.min(Math.max(1, opts.limit || LIMITS.transcriptPageDefault), LIMITS.transcriptPageMax)
      if (!m) return { sessionId: id, messages: [], before: null, hasMore: false }
      const all = m.messages()
      const parsed = opts.before !== undefined ? Number(opts.before) : NaN
      const end = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 0), all.length) : all.length
      const start = Math.max(0, end - limit)
      return { sessionId: id, messages: all.slice(start, end), before: start > 0 ? String(start) : null, hasMore: start > 0 }
    },

    getActivity(sessionIds, opts: ActivityQueryOptions): ActivityPage {
      let events: ActivityEvent[] = []
      for (const sid of sessionIds) {
        const m = modelOf(sid)
        if (m) events.push(...m.events.values())
      }
      if (opts.kinds?.length) events = events.filter((e) => opts.kinds!.includes(e.kind))
      if (opts.sinceMs !== undefined) events = events.filter((e) => e.ts >= opts.sinceMs!)
      events.sort(byTime)
      if (opts.before) events = events.filter((e) => !afterCursor(e, opts.before!))
      const limit = Math.min(Math.max(1, opts.limit), LIMITS.activityPageMax)
      const page = events.slice(-limit)
      const hasMore = events.length > page.length
      return { events: page, before: hasMore && page[0] ? cursorOf(page[0]) : null, hasMore }
    },

    recentActivity({ sinceMs, limit }) {
      const events: ActivityEvent[] = []
      for (const e of entries.values()) {
        if (!e.model && e.mtimeMs < sinceMs) continue
        const m = ensure(e)
        if (m.hidden) continue
        for (const ev of m.events.values()) if (ev.ts >= sinceMs) events.push(ev)
      }
      events.sort(byTime)
      return events.slice(-limit)
    },

    getPart(id): PartDetail | null {
      const sid = sessionIdOfActivity(id)
      return sid ? (modelOf(sid)?.part(id) ?? null) : null
    },

    getDiff(activityId): FileDiff | null {
      const sid = sessionIdOfActivity(activityId)
      return sid ? (modelOf(sid)?.diff(activityId) ?? null) : null
    },

    getFileChanges(sessionIds, sinceMs): FileChange[] {
      const out: FileChange[] = []
      for (const sid of sessionIds) {
        const m = modelOf(sid)
        if (m) out.push(...m.fileChanges().filter((c) => sinceMs === undefined || c.ts >= sinceMs))
      }
      return out.sort((a, b) => a.ts - b.ts)
    },
  }
}
