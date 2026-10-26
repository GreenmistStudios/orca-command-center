import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  LIMITS,
  type ActivityEvent,
  type ActivityPage,
  type FileChange,
  type FileDiff,
  type PartDetail,
  type SessionCounters,
  type SourceHealth,
  type ToolStat,
  type TranscriptPage,
  type UsageEstimate,
  type UsageSample,
} from '../../../shared/contract.js'
import type { ActivityQueryOptions, HarnessSession, HarnessSource, HarnessUpdate, SourceDeps, Unsubscribe } from '../../types.js'
import { watchDirectory, type Watcher } from '../../lib/fs-watch.js'
import { createToolClassifier } from '../../lib/tool-classify.js'
import { SessionModel } from './model.js'
import { parseWorkspaceYaml } from './workspace.js'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const DEFAULT_POLL_MS = 2000

export interface CopilotSourceOptions {
  /** Stat-poll interval for appended events (default 2000 ms). Tests use a small value. */
  pollMs?: number
}

interface Entry {
  id: string
  dir: string
  /** events.jsonl mtime (or the directory mtime while no events file exists). */
  mtimeMs: number
  size: number
  model: SessionModel | null
  /** Last session snapshot kept after the parsed model is evicted. */
  snapshot?: HarnessSession
  snapshotMtimeMs?: number
  lastUsed?: number
  wsMtimeMs?: number
  dirMtimeMs?: number
  lockPids?: number[]
}

const MAX_IDLE_MODELS = 50

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const cursorOf = (e: ActivityEvent): string => `${e.ts}:${e.id}`
function afterCursor(e: ActivityEvent, cursor: string): boolean {
  // true when e sorts at or after the cursor (i.e. should be excluded from the "before" page)
  const i = cursor.indexOf(':')
  const ts = Number(cursor.slice(0, i))
  const id = cursor.slice(i + 1)
  return e.ts > ts || (e.ts === ts && e.id >= id)
}

export function createCopilotSource(deps: SourceDeps, options: CopilotSourceOptions = {}): HarnessSource {
  const { config, log, now } = deps
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const root = config.copilotDir ? path.join(config.copilotDir, 'session-state') : null
  const classifier = createToolClassifier({ knownServers: config.mcpServers })
  const entries = new Map<string, Entry>()
  const listeners = new Set<(u: HarnessUpdate) => void>()
  let watcher: Watcher | null = null
  let timer: NodeJS.Timeout | null = null
  let started = false
  let ticking = false
  let rerun = false
  let degradedDetail: string | null = null
  let status: SourceHealth['status'] = root ? 'starting' : 'disabled'
  let detail: string | null = root ? null : 'Copilot directory not configured'
  let lastReadAt: number | null = null
  let lastChangeAt: number | null = null
  let version: string | null = null

  const emit = (u: HarnessUpdate) => {
    for (const l of [...listeners]) {
      try {
        l(u)
      } catch (e) {
        log.warn('copilot: listener failed', e)
      }
    }
  }

  const eventsFile = (e: Entry) => path.join(e.dir, 'events.jsonl')

  function refreshAlive(e: Entry): boolean {
    try {
      // Re-list the directory only when its mtime changed (lock files appear/disappear there).
      const dm = statSync(e.dir).mtimeMs
      if (dm !== e.dirMtimeMs || e.lockPids === undefined) {
        e.dirMtimeMs = dm
        e.lockPids = []
        for (const name of readdirSync(e.dir)) {
          const m = /^inuse\.(\d+)\.lock$/.exec(name)
          if (m) e.lockPids.push(Number(m[1]))
        }
      }
    } catch {
      /* ignore */
    }
    return (e.lockPids ?? []).some(pidAlive)
  }

  function readWorkspace(e: Entry, model: SessionModel): void {
    try {
      const file = path.join(e.dir, 'workspace.yaml')
      const mt = statSync(file).mtimeMs
      if (mt === e.wsMtimeMs && model.ws) return
      model.ws = parseWorkspaceYaml(readFileSync(file, 'utf8'))
      e.wsMtimeMs = mt
    } catch {
      /* optional */
    }
  }

  /** Full (re)parse of one session from byte 0 (or the last 20 MB). */
  function load(e: Entry): SessionModel {
    const model = new SessionModel(e.id, classifier)
    readWorkspace(e, model)
    let size = 0
    let mtime = e.mtimeMs
    try {
      const st = statSync(eventsFile(e))
      size = st.size
      mtime = st.mtimeMs
    } catch {
      /* no events file yet */
    }
    model.fileMtimeMs = mtime
    if (size > 0) {
      const start = Math.max(0, size - MAX_FILE_BYTES)
      try {
        model.offset = start
        feed(model, readRange(eventsFile(e), start, size), start > 0)
        if (start > 0) {
          model.truncatedHead = true
          degradedDetail = `${e.id.slice(0, 8)}: only last 20 MB parsed`
        }
      } catch (err) {
        log.warn(`copilot: cannot read ${e.id}`, err)
      }
    }
    model.size = size
    model.alive = refreshAlive(e)
    e.size = size
    e.mtimeMs = mtime
    e.model = model
    model.drain()
    model.dropHistoricalUsage()
    if (model.copilotVersion) version = model.copilotVersion
    return model
  }

  /** Feed a byte chunk; only complete (newline-terminated) lines are consumed. */
  function feed(model: SessionModel, buf: Buffer, dropFirst: boolean): void {
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
    for (const line of text.split('\n')) model.ingest(line)
    model.offset += last + 1 - startIdx
  }

  function ensure(e: Entry): SessionModel {
    e.lastUsed = now()
    if (e.model) return e.model
    const m = load(e)
    evictExcess(e)
    return m
  }

  /** Keep at most MAX_IDLE_MODELS parsed models outside the window / not alive (LRU). */
  function evictExcess(keep?: Entry): void {
    const idle = [...entries.values()].filter((x) => x.model && x !== keep && !x.model.alive && !inWindow(x.mtimeMs))
    if (idle.length <= MAX_IDLE_MODELS) return
    idle.sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0))
    for (const x of idle.slice(0, idle.length - MAX_IDLE_MODELS)) {
      x.snapshot = x.model!.toSession()
      x.snapshotMtimeMs = x.mtimeMs
      x.model = null
    }
  }

  const inWindow = (mtimeMs: number) => mtimeMs >= now() - config.windowMs

  function statEntry(e: Entry): boolean {
    try {
      const st = statSync(eventsFile(e))
      e.mtimeMs = st.mtimeMs
      e.size = st.size
      return true
    } catch {
      return false
    }
  }

  function discover(): { added: Entry[]; removed: string[] } {
    const added: Entry[] = []
    const removed: string[] = []
    if (!root) return { added, removed }
    let names: string[] = []
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
    } catch {
      status = 'missing'
      detail = 'session-state directory not readable'
      return { added, removed }
    }
    const seen = new Set(names)
    for (const id of names) {
      if (entries.has(id)) continue
      const dir = path.join(root, id)
      const e: Entry = { id, dir, mtimeMs: 0, size: 0, model: null }
      if (!statEntry(e)) {
        try {
          e.mtimeMs = statSync(dir).mtimeMs
        } catch {
          continue
        }
      }
      entries.set(id, e)
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
    if (!root) return
    const loaded = [...entries.values()].filter((e) => e.model).length
    status = degradedDetail ? 'degraded' : 'ok'
    detail = degradedDetail ?? `${entries.size} sessions, ${loaded} parsed`
  }

  /** One scan: discover dirs, read appended bytes, emit coalesced updates. */
  function tick(initial: boolean): void {
    if (!root) return
    lastReadAt = now()
    const { added, removed } = discover()
    const changedSessions = new Map<string, HarnessSession>()
    const changedEvents = new Map<string, ActivityEvent>()
    let reset: string | null = removed.length ? 'session directory removed' : null
    const usageSamples: UsageSample[] = []
    const usageEstimates = new Map<string, UsageEstimate>()
    const collect = (m: SessionModel, all = false) => {
      const u = m.drainUsage()
      usageSamples.push(...u.samples)
      for (const est of u.estimates) usageEstimates.set(est.sessionId, est)
      changedSessions.set(m.id, m.toSession())
      for (const id of m.drain()) {
        const ev = m.events.get(id)
        if (ev) changedEvents.set(id, ev)
      }
      if (all) for (const ev of m.events.values()) changedEvents.set(ev.id, ev)
    }
    for (const e of entries.values()) {
      try {
        const isNew = added.includes(e)
        if (!e.model) {
          if (!isNew) statEntry(e)
          if (inWindow(e.mtimeMs)) collect(load(e), true)
          continue
        }
        const m = e.model
        let st
        try {
          st = statSync(eventsFile(e))
        } catch {
          st = null
        }
        let dirty = false
        if (st && st.size < m.size) {
          // shrink / rotation: cursor lost
          degradedDetail = null
          const fresh = load(e)
          reset = reset ?? `events.jsonl of ${e.id} was truncated`
          collect(fresh, true)
          continue
        }
        if (st && st.size > m.offset) {
          let pos = m.offset
          while (pos < st.size) {
            const end = Math.min(st.size, pos + MAX_FILE_BYTES)
            const buf = readRange(eventsFile(e), pos, end)
            const before = m.offset
            feed(m, buf, false)
            if (m.offset === before) break // only a partial line available
            pos = m.offset
          }
          m.size = st.size
          dirty = true
        }
        if (st && st.mtimeMs !== m.fileMtimeMs) {
          m.fileMtimeMs = st.mtimeMs
          e.mtimeMs = st.mtimeMs
          dirty = true
        }
        const prevDirMtime = e.dirMtimeMs
        const alive = refreshAlive(e)
        if (alive !== m.alive) {
          m.alive = alive
          dirty = true
        }
        const oldTitle = m.ws?.name
        // workspace.yaml is stat'ed only when the session had activity or its directory changed
        if (dirty || e.dirMtimeMs !== prevDirMtime) readWorkspace(e, m)
        if (m.ws?.name !== oldTitle) dirty = true
        e.snapshot = undefined
        if (dirty) {
          collect(m)
          if (m.copilotVersion) version = m.copilotVersion
        }
      } catch (err) {
        log.warn(`copilot: failed reading session ${e.id}`, err)
      }
    }
    evictExcess()
    setHealth()
    if (changedSessions.size || changedEvents.size) lastChangeAt = now()
    if (initial) return
    if (reset) emit({ type: 'reset', reason: reset })
    if (changedSessions.size) emit({ type: 'sessions', sessions: [...changedSessions.values()] })
    if (usageSamples.length || usageEstimates.size) emit({ type: 'usage', samples: usageSamples, estimates: [...usageEstimates.values()] })
    if (changedEvents.size) {
      const events = [...changedEvents.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
      emit({ type: 'activity', events })
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
          log.warn('copilot: tick failed', e)
        }
      } while (rerun)
    } finally {
      ticking = false
    }
  }

  function modelOf(id: string): SessionModel | null {
    const e = entries.get(id)
    return e ? ensure(e) : null
  }

  function sessionIdOfActivity(id: string): string | null {
    const m = /^copilot:([^:]+):/.exec(id)
    return m ? m[1]! : null
  }

  const source: HarnessSource = {
    id: 'copilot',
    harness: 'copilot',

    async start() {
      if (started) return
      started = true
      if (!root) return
      try {
        statSync(root)
      } catch {
        status = 'missing'
        detail = 'session-state directory not found'
        return
      }
      try {
        tick(true)
      } catch (e) {
        log.warn('copilot: initial scan failed', e)
        status = 'error'
        detail = e instanceof Error ? e.message : String(e)
      }
      watcher = watchDirectory(root, safeTick, { log })
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
      return {
        id: 'copilot',
        label: 'Copilot CLI',
        status,
        path: root,
        version,
        detail,
        lastReadAt,
        lastChangeAt,
      }
    },

    subscribe(listener): Unsubscribe {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    listSessions(sinceMs) {
      const out: HarnessSession[] = []
      for (const e of entries.values()) {
        if (!e.model && e.mtimeMs < sinceMs) continue
        const s = !e.model && e.snapshot && e.snapshotMtimeMs === e.mtimeMs ? e.snapshot : ensure(e).toSession()
        if (s.updatedAt >= sinceMs) out.push(s)
      }
      return out
    },

    getSession(id) {
      return modelOf(id)?.toSession() ?? null
    },

    getChildren() {
      return []
    },

    getCounters(id): SessionCounters {
      return (
        modelOf(id)?.counters() ?? { messages: 0, steps: 0, thinking: 0, tools: 0, toolErrors: 0, mcpCalls: 0, fileChanges: 0, filesTouched: 0, subagents: 0 }
      )
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

    getUsageSamples(sessionIds, opts) {
      const out: UsageSample[] = []
      for (const sid of sessionIds) {
        const m = modelOf(sid)
        if (!m) continue
        for (const u of m.samples.values()) if (opts?.sinceMs === undefined || u.ts >= opts.sinceMs) out.push(u)
      }
      return out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    },

    getTodos() {
      return []
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
      events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
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
        for (const ev of ensure(e).events.values()) if (ev.ts >= sinceMs) events.push(ev)
      }
      events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
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
  return source
}
