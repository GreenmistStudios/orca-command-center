import { existsSync } from 'node:fs'
import type {
  ActivityEvent,
  ActivityKind,
  ActivityPage,
  CurrentActivity,
  FileChange,
  FileDiff,
  ModelRef,
  PartDetail,
  SessionCounters,
  SourceHealth,
  SourceStatus,
  SpawnInfo,
  TodoItem,
  ToolStat,
  TranscriptMessage,
  TranscriptPage,
} from '../../../shared/contract.js'
import { LIMITS } from '../../../shared/contract.js'
import { OPENCODE_DENIED_TABLES, openReadOnly, type ReadOnlyDb } from '../../lib/sqlite.js'
import { clip, oneLine } from '../../lib/text.js'
import { createToolClassifier } from '../../lib/tool-classify.js'
import type {
  ActivityQueryOptions,
  HarnessSession,
  HarnessSource,
  HarnessUpdate,
  SourceDeps,
  Unsubscribe,
} from '../../types.js'
import { redactText } from '../../lib/redact.js'
import {
  capBytes,
  countLines,
  countUnifiedDiff,
  fileChangeKindOf,
  filesOfPart,
  isMutedPart,
  normalizePart,
  parseJson,
  parsePartRow,
  parsePatchText,
  partDetailOf,
  patchTextOf,
  relativeTo,
  safeText,
  toTokenUsage,
  type PartRow,
  type RawPartRow,
} from './normalize.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OpenCodeSourceOptions {
  /** Test hook: open the database yourself (e.g. to count queries). */
  openDb?: (path: string) => ReadOnlyDb
}

export type OpenCodeSource = HarnessSource & {
  /** Run one poll tick synchronously (the timer calls this; tests call it directly). */
  tick(): void
}

const SESSION_COLS = [
  'id',
  'parent_id',
  'directory',
  'title',
  'version',
  'summary_additions',
  'summary_deletions',
  'summary_files',
  'cost',
  'tokens_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write',
  'agent',
  'model',
  'time_created',
  'time_updated',
  'time_archived',
] as const

const PART_COLS = 'id, message_id, session_id, time_created, time_updated, data'
const FILE_TOOL_SQL = `('edit','multiedit','write','patch','apply_patch')`
const EVENT_BATCH = 2000
const MAX_BATCHES = 10
const MSG_CACHE = 5000
const DERIVED_CAP = 4000

interface SessionRow {
  id: string
  parent_id: string | null
  directory: string | null
  title: string
  version: string | null
  summary_additions: number | null
  summary_deletions: number | null
  summary_files: number | null
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  agent: string | null
  model: string | null
  time_created: number
  time_updated: number
  time_archived: number | null
}

interface MsgInfo {
  id: string
  sessionId: string
  role: string
  agent: string | null
  model: ModelRef | null
  created: number
  completed: number | null
  tokens: ReturnType<typeof toTokenUsage> | null
  cost: number | null
  finish: string | null
  error: string | null
}

interface OpenItem {
  rank: number
  current: CurrentActivity
}

interface Derived {
  lastActivityAt: number | null
  asst: { id: string; created: number; completed: boolean; error: boolean; model: ModelRef | null } | null
  open: Map<string, OpenItem>
  questions: Set<string>
  lastPrompt: string | null
  promptTs: number
  lastMessage: string | null
  messageTs: number
}

interface EventRow {
  rowid: number
  aggregate_id: string
  type: string
  data: string
}

interface Batch {
  msgs: Map<string, any>
  parts: Map<string, { part: any; time: number | null }>
  sessionEvents: Set<string>
  unknown: number
  malformed: number
}

const newBatch = (): Batch => ({ msgs: new Map(), parts: new Map(), sessionEvents: new Set(), unknown: 0, malformed: 0 })

export function createOpenCodeSource(deps: SourceDeps, options: OpenCodeSourceOptions = {}): OpenCodeSource {
  const { config, log, now } = deps
  const classifier = createToolClassifier({ knownServers: config.mcpServers })
  const listeners = new Set<(u: HarnessUpdate) => void>()

  let db: ReadOnlyDb | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let status: SourceStatus = 'starting'
  let detail: string | null = null
  let degradedDetail: string | null = null
  let mode: 'event-log' | 'polling' = 'event-log'
  let lastReadAt: number | null = null
  let lastChangeAt: number | null = null
  let failures = 0
  let busy = false
  const loggedErrors = new Set<string>()

  let cursor = 0
  let pollCursor = 0
  let lastDv = -1
  let windowCount = 0
  let unknownEvents = 0
  let malformedEvents = 0

  const cols: Record<string, Set<string>> = {}
  let hasTable = new Set<string>()
  let sessionSelect = ''

  const parentMap = new Map<string, string | null>()
  const rows = new Map<string, SessionRow>()
  const derived = new Map<string, Derived>()
  const spawns = new Map<string, SpawnInfo>()
  const spawnChecked = new Set<string>()
  const msgCache = new Map<string, MsgInfo>()

  /* ──────────────────────────── helpers ──────────────────────────── */

  const q = (): ReadOnlyDb => {
    if (!db) throw new Error('opencode source not started')
    return db
  }

  function emit(update: HarnessUpdate): void {
    for (const l of listeners) {
      try {
        l(update)
      } catch (e) {
        log.warn('opencode listener failed: %s', e instanceof Error ? e.message : String(e))
      }
    }
  }

  function health(): SourceHealth {
    return {
      id: 'opencode',
      label: 'OpenCode',
      status,
      path: config.opencodeDb,
      version: db ? mode : null,
      detail:
        detail ??
        (db
          ? `${windowCount} sessions in window · cursor ${mode === 'event-log' ? cursor : pollCursor}` +
            (degradedDetail ? ` · ${degradedDetail}` : '') +
            (unknownEvents ? ` · ${unknownEvents} unknown events` : '') +
            (malformedEvents ? ` · ${malformedEvents} malformed events` : '')
          : null),
      lastReadAt,
      lastChangeAt,
    }
  }

  function fail(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e)
    if (!loggedErrors.has(msg)) {
      loggedErrors.add(msg)
      log.error('opencode source error: %s', msg)
    }
    failures++
    if (failures >= 3) {
      status = 'error'
      detail = `error: ${msg}`
    }
  }

  function rootOf(id: string): string {
    let cur = id
    const seen = new Set<string>()
    while (!seen.has(cur)) {
      seen.add(cur)
      let p = parentMap.get(cur)
      if (p === undefined) {
        const r = db?.get<{ parent_id: string | null }>('SELECT parent_id FROM session WHERE id = ?', cur)
        p = r ? r.parent_id : null
        parentMap.set(cur, p)
      }
      if (!p) return cur
      cur = p
    }
    return cur
  }

  function fetchRow(id: string): SessionRow | null {
    const r = q().get<SessionRow>(`SELECT ${sessionSelect} FROM session WHERE id = ?`, id)
    if (!r) return null
    rows.set(id, r)
    parentMap.set(id, r.parent_id ?? null)
    return r
  }

  function rowOf(id: string): SessionRow | null {
    return rows.get(id) ?? fetchRow(id)
  }

  function dirOf(id: string): string | null {
    return rowOf(id)?.directory ?? null
  }

  function parseMsg(id: string, sessionId: string, data: any, created?: number): MsgInfo | null {
    if (!data || typeof data !== 'object') return null
    const role = typeof data.role === 'string' ? data.role : 'unknown'
    const modelId = data.modelID ?? data.model?.modelID ?? data.model?.id
    const provider = data.providerID ?? data.model?.providerID
    const err = data.error
    let error: string | null = null
    if (err) {
      const m = typeof err === 'string' ? err : (err.data?.message ?? err.message ?? err.name ?? 'error')
      error = safeText(String(m), LIMITS.toolInputChars).text
    }
    return {
      id,
      sessionId,
      role,
      agent: typeof data.agent === 'string' ? data.agent : typeof data.mode === 'string' ? data.mode : null,
      model: typeof modelId === 'string' ? { providerId: typeof provider === 'string' ? provider : null, modelId } : null,
      created: typeof data.time?.created === 'number' ? data.time.created : (created ?? 0),
      completed: typeof data.time?.completed === 'number' ? data.time.completed : null,
      tokens: data.tokens ? toTokenUsage(data.tokens) : null,
      cost: typeof data.cost === 'number' ? data.cost : null,
      finish: typeof data.finish === 'string' ? data.finish : null,
      error,
    }
  }

  function cacheMsg(m: MsgInfo): void {
    msgCache.delete(m.id)
    msgCache.set(m.id, m)
    if (msgCache.size > MSG_CACHE) {
      const first = msgCache.keys().next().value
      if (first !== undefined) msgCache.delete(first)
    }
  }

  function msgOf(id: string, local?: Map<string, any>): MsgInfo | null {
    const l = local?.get(id)
    if (l) {
      const m = parseMsg(id, l.sessionID ?? '', l)
      if (m) return m
    }
    const hit = msgCache.get(id)
    if (hit) return hit
    const r = q().get<{ id: string; session_id: string; time_created: number; data: string }>(
      'SELECT id, session_id, time_created, data FROM message WHERE id = ?',
      id,
    )
    if (!r) return null
    const m = parseMsg(r.id, r.session_id, parseJson(r.data), r.time_created)
    if (m) cacheMsg(m)
    return m
  }

  /* ─────────────────────────── derived state ─────────────────────────── */

  const newDerived = (): Derived => ({
    lastActivityAt: null,
    asst: null,
    open: new Map(),
    questions: new Set(),
    lastPrompt: null,
    promptTs: 0,
    lastMessage: null,
    messageTs: 0,
  })

  function bump(d: Derived, t: number | null | undefined): void {
    if (typeof t === 'number' && (d.lastActivityAt === null || t > d.lastActivityAt)) d.lastActivityAt = t
  }

  function applyMessage(d: Derived, m: MsgInfo): void {
    bump(d, m.created)
    bump(d, m.completed)
    if (m.role !== 'assistant') return
    if (!d.asst || m.created >= d.asst.created) {
      d.asst = { id: m.id, created: m.created, completed: m.completed != null, error: m.error != null, model: m.model }
    }
  }

  function applyEvent(d: Derived, ev: ActivityEvent, role: string | null, muted: boolean): void {
    bump(d, ev.ts)
    bump(d, ev.endTs)
    bump(d, ev.rev)
    const id = ev.id
    const open = ev.status === 'running' || ev.status === 'pending'
    if (ev.kind === 'thinking') {
      if (open) d.open.set(id, { rank: 1, current: { kind: 'thinking', label: 'Thinking', detail: null, since: ev.ts, activityId: id } })
      else d.open.delete(id)
    } else if (ev.tool) {
      const prefix = `${ev.tool.displayName} · `
      const det = ev.tool.mcpServer ?? (ev.title.startsWith(prefix) ? ev.title.slice(prefix.length) : null)
      if (open) {
        d.open.set(id, { rank: 0, current: { kind: ev.kind, label: ev.tool.displayName, detail: det, since: ev.ts, activityId: id } })
      } else d.open.delete(id)
      if (ev.tool.category === 'question') {
        if (open) d.questions.add(id)
        else d.questions.delete(id)
      }
    } else if (ev.kind === 'text') {
      if (open) d.open.set(id, { rank: 2, current: { kind: 'text', label: 'Writing response', detail: null, since: ev.ts, activityId: id } })
      else d.open.delete(id)
      if (!muted && ev.summary && ev.title) {
        const t = ev.endTs ?? ev.ts
        if (t >= d.messageTs) {
          d.messageTs = t
          d.lastMessage = clip(oneLine(ev.summary), LIMITS.promptChars)
        }
      }
    } else if (ev.kind === 'prompt' && role === 'user' && !muted && ev.summary !== null) {
      if (ev.ts >= d.promptTs) {
        d.promptTs = ev.ts
        d.lastPrompt = clip(oneLine(ev.summary), LIMITS.promptChars)
      }
    }
  }

  function loadDerived(sid: string): Derived {
    const d = newDerived()
    const msgRows = q().all<{ id: string; time_created: number; data: string }>(
      'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 6',
      sid,
    )
    msgRows.reverse()
    const infos = new Map<string, MsgInfo>()
    for (const r of msgRows) {
      const m = parseMsg(r.id, sid, parseJson(r.data), r.time_created)
      if (m) {
        infos.set(r.id, m)
        cacheMsg(m)
      }
    }
    // parts of the latest 3 messages plus any user messages among the latest 6
    const wanted = new Set<string>()
    msgRows.slice(-3).forEach((r) => wanted.add(r.id))
    for (const [id, m] of infos) if (m.role === 'user') wanted.add(id)
    const dir = dirOf(sid)
    const rootId = rootOf(sid)
    for (const r of msgRows) {
      const m = infos.get(r.id)
      if (m) applyMessage(d, m)
      if (!wanted.has(r.id)) continue
      const partRows = q().all<RawPartRow>(
        `SELECT ${PART_COLS} FROM part WHERE message_id = ? ORDER BY id DESC LIMIT 60`,
        r.id,
      )
      partRows.reverse()
      for (const raw of partRows) {
        const p = parsePartRow(raw)
        if (!p) continue
        const n = normalizePart(p, { classifier, role: m?.role ?? null, directory: dir, rootId, source: 'opencode.part' })
        if (n) applyEvent(d, n.event, m?.role ?? null, n.muted)
      }
    }
    return d
  }

  function derivedOf(sid: string): Derived {
    let d = derived.get(sid)
    if (!d) {
      d = loadDerived(sid)
      derived.set(sid, d)
      if (derived.size > DERIVED_CAP) {
        const first = derived.keys().next().value
        if (first !== undefined && first !== sid) derived.delete(first)
      }
    }
    return d
  }

  /* ────────────────────────────── sessions ────────────────────────────── */

  function parseModel(text: string | null): ModelRef | null {
    if (!text) return null
    const j = parseJson(text)
    if (!j || typeof j.id !== 'string') return null
    return { providerId: typeof j.providerID === 'string' ? j.providerID : null, modelId: j.id }
  }

  function transcriptStateOf(d: Derived): HarnessSession['transcriptState'] {
    if (d.questions.size > 0 && !d.asst?.error) return 'waiting'
    if (!d.asst) return 'unknown'
    if (d.asst.error) return 'error'
    return d.asst.completed ? 'done' : 'working'
  }

  function currentOf(d: Derived, state: HarnessSession['transcriptState']): CurrentActivity | null {
    if (state !== 'working' && state !== 'waiting') return null
    let best: OpenItem | null = null
    for (const o of d.open.values()) {
      if (!best || o.rank < best.rank || (o.rank === best.rank && o.current.since >= best.current.since)) best = o
    }
    return best?.current ?? null
  }

  function findSpawn(child: SessionRow): SpawnInfo | null {
    const hit = spawns.get(child.id)
    if (hit) return hit
    if (!child.parent_id || spawnChecked.has(child.id)) return null
    spawnChecked.add(child.id)
    const cands = q().all<{ id: string; data: string }>(
      `SELECT id, data FROM part WHERE session_id = ? AND time_created >= ? AND time_created <= ?
         AND json_extract(data, '$.tool') = 'task'`,
      child.parent_id,
      child.time_created - 30 * 60_000,
      child.time_created + 60_000,
    )
    for (const c of cands) {
      const j = parseJson(c.data)
      if (j?.state?.metadata?.sessionId === child.id) return recordSpawn(c.id, child.parent_id, j)
    }
    return null
  }

  /** Full (unbounded) lookup used for explicit getSession calls when the bounded one found nothing. */
  function findSpawnFull(child: SessionRow): SpawnInfo | null {
    const hit = spawns.get(child.id)
    if (hit || !child.parent_id) return hit ?? null
    const cands = q().all<{ id: string; data: string }>(
      `SELECT id, data FROM part WHERE session_id = ? AND json_extract(data, '$.tool') = 'task' LIMIT 2000`,
      child.parent_id,
    )
    for (const c of cands) {
      const j = parseJson(c.data)
      if (j?.state?.metadata?.sessionId === child.id) return recordSpawn(c.id, child.parent_id, j)
    }
    return null
  }

  function recordSpawn(partId: string, parentId: string, part: any): SpawnInfo | null {
    const childId = part?.state?.metadata?.sessionId
    if (typeof childId !== 'string') return null
    const input = part.state.input ?? {}
    const st = part.state.status
    const info: SpawnInfo = {
      parentSessionId: parentId,
      activityId: `opencode:${partId}`,
      callId: typeof part.callID === 'string' ? part.callID : null,
      description: safeText(String(input.description ?? ''), LIMITS.titleChars).text,
      subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : null,
      status: st === 'running' || st === 'completed' || st === 'error' || st === 'pending' ? st : 'pending',
    }
    spawns.set(childId, info)
    return info
  }

  function buildSession(row: SessionRow, full = false): HarnessSession {
    const d = derivedOf(row.id)
    const state = transcriptStateOf(d)
    const spawn = row.parent_id ? (findSpawn(row) ?? (full ? findSpawnFull(row) : null)) : null
    const model = parseModel(row.model) ?? d.asst?.model ?? null
    const facts: Array<{ label: string; value: string }> = []
    if (row.version) facts.push({ label: 'Version', value: row.version })
    if (row.summary_files != null) facts.push({ label: 'Files changed', value: String(row.summary_files) })
    if (row.summary_additions != null || row.summary_deletions != null) {
      facts.push({ label: '+/−', value: `+${row.summary_additions ?? 0} / −${row.summary_deletions ?? 0}` })
    }
    return {
      id: row.id,
      harness: 'opencode',
      parentId: row.parent_id ?? null,
      title: row.title.replace(/\s*\(@[\w.-]+ subagent\)\s*$/, ''),
      agent: row.agent ?? null,
      model,
      directory: row.directory ?? null,
      createdAt: row.time_created,
      updatedAt: row.time_updated,
      lastActivityAt: d.lastActivityAt ?? row.time_updated,
      archivedAt: row.time_archived ?? null,
      tokens: {
        input: row.tokens_input ?? 0,
        output: row.tokens_output ?? 0,
        reasoning: row.tokens_reasoning ?? 0,
        cacheRead: row.tokens_cache_read ?? 0,
        cacheWrite: row.tokens_cache_write ?? 0,
      },
      cost: row.cost ?? 0,
      spawn,
      transcriptState: state,
      current: currentOf(d, state),
      lastPrompt: d.lastPrompt,
      lastMessage: d.lastMessage,
      processAlive: null,
      facts,
    }
  }

  function loadAncestors(list: SessionRow[]): SessionRow[] {
    const have = new Set(list.map((r) => r.id))
    const out = [...list]
    for (const r of list) {
      let p = r.parent_id
      let guard = 0
      while (p && !have.has(p) && guard++ < 50) {
        const pr = rowOf(p)
        if (!pr) break
        have.add(p)
        out.push(pr)
        p = pr.parent_id
      }
    }
    return out
  }

  /* ───────────────────────────── seeding ───────────────────────────── */

  function maxRowid(): number {
    const r = q().get<{ m: number | null }>('SELECT max(rowid) AS m FROM event')
    return Number(r?.m ?? 0)
  }

  function seed(): void {
    rows.clear()
    derived.clear()
    spawns.clear()
    spawnChecked.clear()
    msgCache.clear()
    parentMap.clear()
    lastDv = q().dataVersion()
    if (hasTable.has('event')) cursor = maxRowid()
    for (const r of q().all<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM session')) {
      parentMap.set(r.id, r.parent_id ?? null)
    }
    const since = now() - config.windowMs
    const win = q().all<SessionRow>(
      `SELECT ${sessionSelect} FROM session WHERE time_updated >= ? ORDER BY time_updated DESC LIMIT 1000`,
      since,
    )
    for (const r of win) rows.set(r.id, r)
    windowCount = win.length
    pollCursor = Number(q().get<{ m: number | null }>('SELECT max(time_updated) AS m FROM session')?.m ?? 0)
    if (hasTable.has('event')) {
      const top = cursor
      for (const r of q().all<{ t: string | null }>(
        `SELECT DISTINCT json_extract(data, '$.part.tool') AS t FROM event WHERE rowid > ?`,
        Math.max(0, top - 1000),
      )) {
        if (r.t) classifier.observe(r.t)
      }
    }
    for (const r of loadAncestors(win)) {
      rows.set(r.id, r)
    }
    for (const r of win) {
      derivedOf(r.id)
      if (r.parent_id) findSpawn(r)
    }
  }

  /* ───────────────────────────── event feed ───────────────────────────── */

  function absorb(batch: Batch, r: EventRow): void {
    const data = parseJson(r.data)
    if (!data || typeof data !== 'object') {
      batch.malformed++
      return
    }
    switch (r.type) {
      case 'message.part.updated.1': {
        const part = data.part
        if (!part || typeof part.id !== 'string') {
          batch.malformed++
          return
        }
        batch.parts.delete(part.id)
        batch.parts.set(part.id, { part, time: typeof data.time === 'number' ? data.time : null })
        break
      }
      case 'message.updated.1': {
        const info = data.info
        if (!info || typeof info.id !== 'string') {
          batch.malformed++
          return
        }
        batch.msgs.set(info.id, { ...info, sessionID: info.sessionID ?? data.sessionID ?? r.aggregate_id })
        break
      }
      case 'session.created.1':
      case 'session.updated.1':
        batch.sessionEvents.add(typeof data.sessionID === 'string' ? data.sessionID : r.aggregate_id)
        break
      default:
        batch.unknown++
    }
  }

  interface Processed {
    touched: Set<string>
    events: ActivityEvent[]
    todoSessions: Set<string>
  }

  function processBatch(batch: Batch, source: 'opencode.event' | 'opencode.part'): Processed {
    const touched = new Set<string>()
    const todoSessions = new Set<string>()
    const events: ActivityEvent[] = []
    for (const [id, info] of batch.msgs) {
      const sid = String(info.sessionID ?? '')
      if (!sid) continue
      const m = parseMsg(id, sid, info)
      if (!m) continue
      cacheMsg(m)
      applyMessage(derivedOf(sid), m)
      touched.add(sid)
    }
    for (const sid of batch.sessionEvents) {
      fetchRow(sid)
      touched.add(sid)
    }
    for (const [pid, { part, time }] of batch.parts) {
      const sid = String(part.sessionID ?? '')
      const mid = String(part.messageID ?? '')
      if (!sid || !mid) continue
      const rev = time ?? now()
      const row: PartRow = { id: pid, messageId: mid, sessionId: sid, timeCreated: time ?? now(), timeUpdated: rev, data: part }
      const role = msgOf(mid, batch.msgs)?.role ?? null
      const n = normalizePart(row, { classifier, role, directory: dirOf(sid), rootId: rootOf(sid), rev, source })
      if (!n) continue
      const d = derivedOf(sid)
      applyEvent(d, n.event, role, n.muted)
      touched.add(sid)
      if (part.type === 'tool' && part.tool === 'task') {
        const info = recordSpawn(pid, sid, part)
        const child = part.state?.metadata?.sessionId
        if (info && typeof child === 'string') touched.add(child)
      }
      if (part.type === 'tool' && part.tool === 'todowrite' && part.state?.status === 'completed') todoSessions.add(sid)
      if (!n.muted) events.push(n.event)
    }
    events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    return { touched, events, todoSessions }
  }

  function publish(p: Processed): void {
    const sessions: HarnessSession[] = []
    for (const sid of p.touched) {
      const row = fetchRow(sid)
      if (row) sessions.push(buildSession(row))
    }
    if (sessions.length) emit({ type: 'sessions', sessions })
    if (p.events.length) emit({ type: 'activity', events: p.events })
    for (const sid of p.todoSessions) emit({ type: 'todos', sessionId: sid, todos: getTodos(sid) })
  }

  function tickEvents(): void {
    const max = maxRowid()
    if (max < cursor) {
      emit({ type: 'reset', reason: 'event log rewound' })
      seed()
      return
    }
    if (max === cursor) return
    const batch = newBatch()
    let next = cursor
    for (let i = 0; i < MAX_BATCHES; i++) {
      const rs = q().all<EventRow>(
        'SELECT rowid, aggregate_id, type, data FROM event WHERE rowid > ? ORDER BY rowid LIMIT ?',
        next,
        EVENT_BATCH,
      )
      for (const r of rs) {
        absorb(batch, r)
        next = r.rowid
      }
      if (rs.length < EVENT_BATCH) break
    }
    try {
      unknownEvents += batch.unknown
      malformedEvents += batch.malformed
      lastChangeAt = now()
      publish(processBatch(batch, 'opencode.event'))
    } catch (e) {
      // keep the cursor so rows are retried; skip a poison batch after 3 consecutive failures
      if (failCursor === cursor) failCount++
      else {
        failCursor = cursor
        failCount = 1
      }
      if (failCount < 3) throw e
      console.warn(`opencode: skipping event batch after ${failCount} failures at rowid ${cursor}`)
      skippedBatches++
      failCount = 0
    }
    cursor = next
  }

  let failCursor = -1
  let failCount = 0
  let skippedBatches = 0

  function tickPolling(): void {
    const changed = q().all<SessionRow>(
      `SELECT ${sessionSelect} FROM session WHERE time_updated > ? ORDER BY time_updated LIMIT 500`,
      pollCursor,
    )
    if (!changed.length) return
    const batch = newBatch()
    const since = pollCursor
    for (const r of changed) {
      rows.set(r.id, r)
      batch.sessionEvents.add(r.id)
      pollCursor = Math.max(pollCursor, r.time_updated)
      for (const m of q().all<{ id: string; data: string }>(
        'SELECT id, data FROM message WHERE session_id = ? AND time_updated > ?',
        r.id,
        since,
      )) {
        const j = parseJson(m.data)
        if (j) batch.msgs.set(m.id, { ...j, id: m.id, sessionID: r.id })
      }
      for (const raw of q().all<RawPartRow>(
        `SELECT ${PART_COLS} FROM part WHERE session_id = ? AND time_updated > ? LIMIT 500`,
        r.id,
        since,
      )) {
        const p = parsePartRow(raw)
        if (p) batch.parts.set(p.id, { part: { ...p.data, id: p.id, sessionID: p.sessionId, messageID: p.messageId }, time: p.timeUpdated })
      }
    }
    lastChangeAt = now()
    publish(processBatch(batch, 'opencode.part'))
  }

  function tick(): void {
    if (busy || !db) return
    busy = true
    try {
      const dv = db.dataVersion()
      lastReadAt = now()
      if (dv !== lastDv) {
        if (mode === 'event-log') tickEvents()
        else tickPolling()
        lastDv = dv
      }
      failures = 0
      if (status === 'error') {
        status = mode === 'polling' ? 'degraded' : 'ok'
        detail = null
      }
    } catch (e) {
      fail(e)
    } finally {
      busy = false
    }
  }

  /* ───────────────────────────── queries ───────────────────────────── */

  function listSessions(sinceMs: number): HarnessSession[] {
    const list = q().all<SessionRow>(
      `SELECT ${sessionSelect} FROM session WHERE time_updated >= ? ORDER BY time_updated DESC LIMIT 2000`,
      sinceMs,
    )
    for (const r of list) rows.set(r.id, r)
    return loadAncestors(list).map((r) => buildSession(r))
  }

  function getSession(id: string): HarnessSession | null {
    const row = fetchRow(id)
    return row ? buildSession(row, true) : null
  }

  function getChildren(id: string): HarnessSession[] {
    const list = q().all<SessionRow>(
      `SELECT ${sessionSelect} FROM session WHERE parent_id = ? ORDER BY time_created`,
      id,
    )
    return list.map((r) => {
      rows.set(r.id, r)
      return buildSession(r)
    })
  }

  function getTodos(id: string): TodoItem[] {
    if (!hasTable.has('todo')) return []
    return q()
      .all<{ content: string; status: string; priority: string; position: number }>(
        'SELECT content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position',
        id,
      )
      .map((t) => ({
        id: `${id}:${t.position}`,
        content: safeText(t.content, 400).text,
        status: t.status,
        priority: t.priority,
        position: t.position,
      }))
  }

  function getCounters(id: string): SessionCounters {
    const c: SessionCounters = { messages: 0, steps: 0, thinking: 0, tools: 0, toolErrors: 0, mcpCalls: 0, fileChanges: 0, filesTouched: 0, subagents: 0 }
    c.messages = Number(q().get<{ n: number }>('SELECT count(*) AS n FROM message WHERE session_id = ?', id)?.n ?? 0)
    c.subagents = Number(q().get<{ n: number }>('SELECT count(*) AS n FROM session WHERE parent_id = ?', id)?.n ?? 0)
    const groups = q().all<{ t: string | null; tool: string | null; st: string | null; n: number }>(
      `SELECT json_extract(data, '$.type') AS t, json_extract(data, '$.tool') AS tool,
              json_extract(data, '$.state.status') AS st, count(*) AS n
         FROM part WHERE session_id = ? GROUP BY 1, 2, 3`,
      id,
    )
    let anyFileParts = false
    for (const g of groups) {
      const n = Number(g.n)
      if (g.t === 'step-finish') c.steps += n
      else if (g.t === 'reasoning') c.thinking += n
      else if (g.t === 'patch') anyFileParts = true
      else if (g.t === 'tool' && g.tool) {
        classifier.observe(g.tool)
      }
    }
    for (const g of groups) {
      if (g.t !== 'tool' || !g.tool) continue
      const n = Number(g.n)
      const cls = classifier.classify('opencode', g.tool)
      c.tools += n
      if (g.st === 'error') c.toolErrors += n
      if (cls.category === 'mcp') c.mcpCalls += n
      if (cls.category === 'edit' || cls.category === 'write' || cls.category === 'patch') {
        c.fileChanges += n
        anyFileParts = true
      }
    }
    if (anyFileParts) {
      const dir = dirOf(id)
      const files = new Set<string>()
      // Narrow projection: edit/write parts carry old/new bodies we never need.
      type FileRow = {
        type: string | null
        tool: string | null
        files: string | null
        fp: string | null
        p: string | null
        pt: string | null
        pa: string | null
        df: string | null
        inp: string | null
      }
      const patchy = `json_extract(data, '$.tool') IN ('apply_patch','patch')`
      for (const r of q().all<FileRow>(
        `SELECT json_extract(data, '$.type') AS type, json_extract(data, '$.tool') AS tool,
                json_extract(data, '$.files') AS files,
                json_extract(data, '$.state.input.filePath') AS fp, json_extract(data, '$.state.input.path') AS p,
                CASE WHEN ${patchy} THEN json_extract(data, '$.state.input.patchText') END AS pt,
                CASE WHEN ${patchy} THEN json_extract(data, '$.state.input.patch') END AS pa,
                CASE WHEN ${patchy} THEN json_extract(data, '$.state.input.diff') END AS df,
                CASE WHEN ${patchy} THEN json_extract(data, '$.state.input.input') END AS inp
           FROM part WHERE session_id = ? AND (json_extract(data, '$.tool') IN ${FILE_TOOL_SQL}
            OR json_extract(data, '$.type') = 'patch') LIMIT 20000`,
        id,
      )) {
        const j = {
          type: r.type,
          tool: r.tool,
          files: r.files ? (parseJson(r.files) ?? []) : [],
          state: { input: { filePath: r.fp, path: r.p, patchText: r.pt, patch: r.pa, diff: r.df, input: r.inp } },
        }
        for (const f of filesOfPart(j, dir)) files.add(f)
      }
      c.filesTouched = files.size
    }
    return c
  }

  function getToolStats(ids: string[]): ToolStat[] {
    const agg = new Map<string, { calls: number; errors: number }>()
    const rowsAll: Array<{ tool: string; st: string | null; n: number }> = []
    for (const id of ids) {
      for (const r of q().all<{ tool: string | null; st: string | null; n: number }>(
        `SELECT json_extract(data, '$.tool') AS tool, json_extract(data, '$.state.status') AS st, count(*) AS n
           FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' GROUP BY 1, 2`,
        id,
      )) {
        if (!r.tool) continue
        classifier.observe(r.tool)
        rowsAll.push({ tool: r.tool, st: r.st, n: Number(r.n) })
      }
    }
    for (const r of rowsAll) {
      const a = agg.get(r.tool) ?? { calls: 0, errors: 0 }
      a.calls += r.n
      if (r.st === 'error') a.errors += r.n
      agg.set(r.tool, a)
    }
    return [...agg.entries()]
      .map(([name, a]) => {
        const cls = classifier.classify('opencode', name)
        return { name, category: cls.category, mcpServer: cls.mcpServer, calls: a.calls, errors: a.errors }
      })
      .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1))
  }

  function normalizeRaw(raw: RawPartRow, source: 'opencode.part' = 'opencode.part') {
    const p = parsePartRow(raw)
    if (!p) return null
    const role = p.data.type === 'text' ? (msgOf(p.messageId)?.role ?? null) : null
    const n = normalizePart(p, { classifier, role, directory: dirOf(p.sessionId), rootId: rootOf(p.sessionId), source })
    return n ? { row: p, ...n } : null
  }

  function toMessage(m: MsgInfo, items: ActivityEvent[]): TranscriptMessage {
    return {
      id: m.id,
      sessionId: m.sessionId,
      role: m.role === 'user' || m.role === 'assistant' ? m.role : 'system',
      agent: m.agent,
      model: m.model,
      createdAt: m.created,
      completedAt: m.completed,
      tokens: m.tokens,
      cost: m.cost,
      finish: m.finish,
      error: m.error,
      items,
    }
  }

  function parseBefore(before: string | undefined): { ct: number; cid: string } {
    if (before) {
      const i = before.indexOf(':')
      const t = Number(before.slice(0, i))
      if (i > 0 && Number.isFinite(t)) return { ct: t, cid: before.slice(i + 1) }
    }
    return { ct: Number.MAX_SAFE_INTEGER, cid: '\uffff' }
  }

  function getTranscript(id: string, opts: { before?: string; limit: number }): TranscriptPage {
    const limit = Math.max(1, Math.min(opts.limit || LIMITS.transcriptPageDefault, LIMITS.transcriptPageMax))
    const { ct, cid } = parseBefore(opts.before)
    const msgRows = q().all<{ id: string; time_created: number; data: string }>(
      `SELECT id, time_created, data FROM message WHERE session_id = ?
         AND (time_created < ? OR (time_created = ? AND id < ?))
         ORDER BY time_created DESC, id DESC LIMIT ?`,
      id,
      ct,
      ct,
      cid,
      limit + 1,
    )
    const hasMore = msgRows.length > limit
    const page = msgRows.slice(0, limit)
    const messages: TranscriptMessage[] = []
    for (const r of page) {
      const m = parseMsg(r.id, id, parseJson(r.data), r.time_created)
      if (!m) continue
      cacheMsg(m)
      const items: ActivityEvent[] = []
      for (const raw of q().all<RawPartRow>(`SELECT ${PART_COLS} FROM part WHERE message_id = ? ORDER BY id`, r.id)) {
        const p = parsePartRow(raw)
        if (!p) continue
        const n = normalizePart(p, { classifier, role: m.role, directory: dirOf(id), rootId: rootOf(id), source: 'opencode.part' })
        if (n) items.push(n.event)
      }
      messages.push(toMessage(m, items))
    }
    messages.reverse()
    const last = page[page.length - 1]
    return { sessionId: id, messages, before: hasMore && last ? `${last.time_created}:${last.id}` : null, hasMore }
  }

  function getActivity(ids: string[], opts: ActivityQueryOptions): ActivityPage {
    const limit = Math.max(1, Math.min(opts.limit || 100, LIMITS.activityPageMax))
    const { ct, cid } = parseBefore(opts.before)
    const kinds = opts.kinds?.length ? new Set<ActivityKind>(opts.kinds) : null
    const fetchCap = Math.min(limit * 3 + 100, 5000)
    const cands: Array<{ id: string; tc: number; raw: RawPartRow }> = []
    let saturated = false
    for (const sid of ids) {
      const rs = q().all<RawPartRow & { tc: number }>(
        `SELECT ${PART_COLS}, time_created AS tc FROM part WHERE session_id = ? AND time_updated >= ?
           AND (time_created < ? OR (time_created = ? AND id < ?))
           ORDER BY time_created DESC, id DESC LIMIT ?`,
        sid,
        opts.sinceMs ?? 0,
        ct,
        ct,
        cid,
        fetchCap,
      )
      if (rs.length >= fetchCap) saturated = true
      for (const r of rs) cands.push({ id: r.id, tc: r.tc, raw: r })
    }
    cands.sort((a, b) => b.tc - a.tc || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    const got: Array<{ ev: ActivityEvent; tc: number; id: string }> = []
    let idx = 0
    while (idx < cands.length && got.length <= limit) {
      const c = cands[idx++]!
      const n = normalizeRaw(c.raw)
      if (!n || n.muted) continue
      if (kinds && !kinds.has(n.event.kind)) continue
      got.push({ ev: n.event, tc: c.tc, id: c.id })
    }
    const more = got.length > limit
    const pageItems = got.slice(0, limit)
    const hasMore = more || idx < cands.length || saturated
    const lastItem = pageItems[pageItems.length - 1]
    const consumed = more ? lastItem : cands[idx - 1] ? { tc: cands[idx - 1]!.tc, id: cands[idx - 1]!.id } : null
    const events = pageItems.map((g) => g.ev).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    return { events, before: hasMore && consumed ? `${consumed.tc}:${consumed.id}` : null, hasMore }
  }

  function recentActivity(opts: { sinceMs: number; limit: number }): ActivityEvent[] {
    if (!hasTable.has('event')) {
      const ids = listSessions(opts.sinceMs).slice(0, 200).map((s) => s.id)
      return getActivity(ids, { limit: opts.limit, sinceMs: opts.sinceMs }).events.filter((e) => e.kind !== 'step')
    }
    const max = maxRowid()
    const batch = newBatch()
    for (const r of q().all<EventRow>(
      'SELECT rowid, aggregate_id, type, data FROM event WHERE rowid > ? ORDER BY rowid LIMIT 3000',
      Math.max(0, max - 3000),
    )) {
      absorb(batch, r)
    }
    const out: ActivityEvent[] = []
    for (const [pid, { part, time }] of batch.parts) {
      const sid = String(part.sessionID ?? '')
      const mid = String(part.messageID ?? '')
      if (!sid || !mid) continue
      const rev = time ?? now()
      const role = msgOf(mid, batch.msgs)?.role ?? null
      const n = normalizePart(
        { id: pid, messageId: mid, sessionId: sid, timeCreated: rev, timeUpdated: rev, data: part },
        { classifier, role, directory: dirOf(sid), rootId: rootOf(sid), rev, source: 'opencode.event' },
      )
      if (!n || n.muted || n.event.kind === 'step' || n.event.ts < opts.sinceMs) continue
      out.push(n.event)
    }
    out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    return out.length > opts.limit ? out.slice(out.length - opts.limit) : out
  }

  function partIdOf(activityId: string): string {
    return activityId.replace(/^opencode:/, '').replace(/#\d+$/, '')
  }

  function getPart(id: string): PartDetail | null {
    const raw = q().get<RawPartRow>(`SELECT ${PART_COLS} FROM part WHERE id = ?`, partIdOf(id))
    if (!raw) return null
    const n = normalizeRaw(raw)
    if (!n) return null
    const det = partDetailOf(n.row.data)
    return {
      id: n.row.id,
      sessionId: n.row.sessionId,
      kind: n.event.kind,
      title: n.event.title,
      text: det.text,
      input: det.input,
      output: det.output,
      error: det.error,
      metadata: det.metadata,
      truncated: det.truncated,
    }
  }

  function getDiff(activityId: string): FileDiff | null {
    const raw = q().get<RawPartRow>(`SELECT ${PART_COLS} FROM part WHERE id = ?`, partIdOf(activityId))
    if (!raw) return null
    const p = parsePartRow(raw)
    if (!p) return null
    const d = p.data
    const dir = dirOf(p.sessionId)
    const files = filesOfPart(d, dir)
    const path = files[0] ?? ''
    const id = activityId
    const finish = (format: FileDiff['format'], text: string | null, note: string | null): FileDiff => {
      if (text == null) return { id, path, format, text: null, note, truncated: false }
      const c = capBytes(redactText(text), LIMITS.diffBytes)
      return { id, path, format, text: c.text, note, truncated: c.truncated }
    }
    if (d.type === 'patch') {
      return finish('none', null, `Snapshot ${typeof d.hash === 'string' ? d.hash : ''} — diff not recorded in the transcript`.replace('  ', ' '))
    }
    if (d.type !== 'tool') return null
    const tool = String(d.tool ?? '').toLowerCase()
    const st = d.state ?? {}
    if (tool === 'edit' || tool === 'multiedit') {
      const diff = st.metadata?.diff
      return typeof diff === 'string' ? finish('unified', diff, null) : finish('none', null, 'No diff recorded for this edit')
    }
    if (tool === 'write') {
      const c = st.input?.content
      return typeof c === 'string' ? finish('new-file', c, null) : finish('none', null, 'No content recorded')
    }
    if (tool === 'apply_patch' || tool === 'patch') {
      const t = patchTextOf(st.input)
      return t ? finish('patch-text', t, null) : finish('none', null, 'No patch text recorded')
    }
    return null
  }

  function getFileChanges(ids: string[], sinceMs?: number): FileChange[] {
    const out: FileChange[] = []
    for (const sid of ids) {
      const dir = dirOf(sid)
      const rootId = rootOf(sid)
      const rs = q().all<RawPartRow>(
        `SELECT ${PART_COLS} FROM part WHERE session_id = ? AND time_updated >= ?
           AND (json_extract(data, '$.tool') IN ${FILE_TOOL_SQL} OR json_extract(data, '$.type') = 'patch') LIMIT 5000`,
        sid,
        sinceMs ?? 0,
      )
      const parts = rs.map(parsePartRow).filter((p): p is PartRow => p != null)
      const covered = new Set<string>()
      for (const p of parts) {
        if (p.data.type === 'tool') for (const f of filesOfPart(p.data, dir)) covered.add(`${p.messageId}\0${f}`)
      }
      const rel = (path: string) => {
        const r = relativeTo(path, dir)
        return { workspaceRoot: dir, relPath: dir && r !== path ? r : null }
      }
      for (const p of parts) {
        const d = p.data
        const n = normalizePart(p, { classifier, role: null, directory: dir, rootId, source: 'opencode.part' })
        if (!n) continue
        const ev = n.event
        if (sinceMs && ev.ts < sinceMs && (ev.endTs ?? 0) < sinceMs) continue
        const base = { sessionId: sid, rootId, harness: 'opencode' as const, ts: ev.ts }
        if (d.type === 'patch') {
          const fs = ev.files.filter((f) => !covered.has(`${p.messageId}\0${f}`))
          fs.forEach((f, i) =>
            out.push({
              ...base,
              id: fs.length > 1 ? `${ev.id}#${i}` : ev.id,
              path: f,
              ...rel(f),
              kind: 'patch',
              tool: null,
              status: 'completed',
              additions: null,
              deletions: null,
            }),
          )
          continue
        }
        const tool = String(d.tool ?? '').toLowerCase()
        const status = ev.status ?? 'completed'
        const input = d.state?.input ?? {}
        if (tool === 'apply_patch' || tool === 'patch') {
          const text = patchTextOf(input)
          const pf = text ? parsePatchText(text) : []
          const abs = (f: string) => (f.startsWith('/') || !dir ? f : `${dir.replace(/\/+$/, '')}/${f}`)
          const list = pf.length ? pf : ev.files.map((f) => ({ path: f, op: 'update' as const, additions: 0, deletions: 0 }))
          list.forEach((f, i) =>
            out.push({
              ...base,
              id: list.length > 1 ? `${ev.id}#${i}` : ev.id,
              path: abs(f.path),
              ...rel(abs(f.path)),
              kind: f.op === 'add' ? 'create' : f.op === 'delete' ? 'delete' : 'patch',
              tool: String(d.tool),
              status,
              additions: pf.length ? f.additions : null,
              deletions: pf.length ? f.deletions : null,
            }),
          )
          continue
        }
        const path = ev.files[0]
        if (!path) continue
        let additions: number | null = null
        let deletions: number | null = null
        if (tool === 'write') {
          if (typeof input.content === 'string') additions = countLines(input.content)
          deletions = d.state?.metadata?.exists === false ? 0 : null
        } else if (typeof d.state?.metadata?.diff === 'string') {
          const c = countUnifiedDiff(d.state.metadata.diff)
          additions = c.additions
          deletions = c.deletions
        }
        out.push({
          ...base,
          id: ev.id,
          path,
          ...rel(path),
          kind: fileChangeKindOf(d),
          tool: String(d.tool),
          status,
          additions,
          deletions,
        })
      }
    }
    return out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  async function start(): Promise<void> {
    const path = config.opencodeDb
    if (!path) {
      status = 'disabled'
      detail = 'no opencode.db path configured'
      return
    }
    if (!existsSync(path)) {
      status = 'missing'
      detail = `opencode.db not found at ${path}`
      return
    }
    try {
      db = (options.openDb ?? ((p) => openReadOnly(p, { deniedTables: OPENCODE_DENIED_TABLES })))(path)
      hasTable = db.tables()
      for (const t of ['session', 'message', 'part', 'event', 'todo']) if (hasTable.has(t)) cols[t] = db.columns(t)
      if (!hasTable.has('session') || !hasTable.has('part')) {
        status = 'error'
        detail = `opencode.db is missing required table(s): ${['session', 'part'].filter((t) => !hasTable.has(t)).join(', ')}`
        db.close()
        db = null
        return
      }
      const have = cols['session'] ?? new Set<string>()
      sessionSelect = SESSION_COLS.map((c) => (have.has(c) ? `"${c}"` : `NULL AS "${c}"`)).join(', ')
      mode = hasTable.has('event') ? 'event-log' : 'polling'
      degradedDetail = mode === 'polling' ? 'no event log; polling sessions' : null
      seed()
      status = mode === 'polling' ? 'degraded' : 'ok'
      detail = null
      lastReadAt = now()
      lastChangeAt = now()
      if (!timer) {
        timer = setInterval(tick, config.pollMs)
        timer.unref?.()
      }
    } catch (e) {
      status = 'error'
      detail = `failed to open opencode.db: ${e instanceof Error ? e.message : String(e)}`
      log.error('opencode source: %s', detail)
      try {
        db?.close()
      } catch {
        /* ignore */
      }
      db = null
    }
  }

  async function stop(): Promise<void> {
    if (timer) clearInterval(timer)
    timer = null
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    db = null
  }

  const guard =
    <A extends unknown[], R>(fallback: R, fn: (...a: A) => R) =>
    (...a: A): R => {
      if (!db) return fallback
      return fn(...a)
    }

  const source: OpenCodeSource = {
    id: 'opencode',
    harness: 'opencode',
    start,
    stop,
    health,
    tick,
    subscribe(listener): Unsubscribe {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    listSessions: guard([], listSessions),
    getSession: guard(null, getSession),
    getChildren: guard([], getChildren),
    getCounters: guard(
      { messages: 0, steps: 0, thinking: 0, tools: 0, toolErrors: 0, mcpCalls: 0, fileChanges: 0, filesTouched: 0, subagents: 0 },
      getCounters,
    ),
    getToolStats: guard([], getToolStats),
    getTodos: guard([], getTodos),
    getTranscript: (id, o) => (db ? getTranscript(id, o) : { sessionId: id, messages: [], before: null, hasMore: false }),
    getActivity: (ids, o) => (db ? getActivity(ids, o) : { events: [], before: null, hasMore: false }),
    recentActivity: guard([], recentActivity),
    getPart: guard(null, getPart),
    getDiff: guard(null, getDiff),
    getFileChanges: guard([], getFileChanges),
  }
  return source
}
