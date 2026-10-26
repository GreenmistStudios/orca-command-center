import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type {
  EpochMs,
  OrchDispatch,
  OrchGate,
  OrchMessage,
  OrchRun,
  OrchRunDetail,
  OrchTask,
  OrchTaskDetail,
  OrchestrationSummary,
  SourceHealth,
  SourceStatus,
} from '../../../shared/contract.js'
import type { OrchestrationSource, OrchestrationUpdate, SourceDeps, Unsubscribe } from '../../types.js'
import { redactText } from '../../lib/redact.js'
import { openReadOnly, type ReadOnlyDb } from '../../lib/sqlite.js'
import { clip, truncate } from '../../lib/text.js'
import { parseTime } from '../../lib/time.js'

export const TESTED_SCHEMA_VERSION = 43

const ID = 'orca-orchestration' as const
const POLL_MS = 2000
const ROW_CAP = 20_000
const FULL_TEXT_MAX = 64 * 1024
const LEGACY_RUN_ID = 'run_legacy_local'

type Row = Record<string, unknown>

interface TaskRec {
  task: OrchTask
  spec: string
  result: string | null
}

interface Snapshot {
  runs: OrchRun[]
  details: Map<string, OrchRunDetail>
  tasks: Map<string, TaskRec>
  taskDetails: Map<string, OrchTaskDetail>
  maxSequence: number | null
  taskCount: number
  /** Every non-heartbeat message, ascending by sequence. */
  messages: OrchMessage[]
  degraded: string[]
  invalidDeps: number
  messageCount: number
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v) || 0)
const q = (name: string): string => `"${name.replace(/"/g, '""')}"`

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function maxOf(values: Array<number | null>): number | null {
  let m: number | null = null
  for (const v of values) if (v !== null && (m === null || v > m)) m = v
  return m
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) if (line.trim()) return line.trim()
  return ''
}

export function createOrchestrationSource(deps: SourceDeps): OrchestrationSource {
  const { config, log, now } = deps
  const path = config.orchestrationDb
  const listeners = new Set<(u: OrchestrationUpdate) => void>()

  let db: ReadOnlyDb | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let status: SourceStatus = 'starting'
  let detailNote: string | null = null
  let available = false
  let schemaVersion: number | null = null
  let lastRead: EpochMs | null = null
  let lastChange: EpochMs | null = null
  let lastDataVersion = -1
  let snap: Snapshot | null = null
  let digests = new Map<string, string>()
  let resetNote: string | null = null
  let readError: string | null = null

  function emptySummary(): OrchestrationSummary {
    return {
      available,
      schemaVersion,
      testedSchemaVersion: TESTED_SCHEMA_VERSION,
      degraded: snap?.degraded ?? [],
      runs: snap?.runs ?? [],
    }
  }

  /* ───────────────────────── reading ───────────────────────── */

  function readTable(name: string, cols: Set<string>, wanted: string[], order: string): { rows: Row[]; capped: boolean } {
    const present = wanted.filter((c) => cols.has(c))
    const select = present.map(q)
    select.push('rowid AS "_rowid"')
    if (name === 'messages' && !cols.has('sequence')) select.push('rowid AS "sequence"')
    const rows = db!.all<Row>(`SELECT ${select.join(', ')} FROM ${q(name)} ORDER BY ${order} DESC LIMIT ${ROW_CAP + 1}`)
    const capped = rows.length > ROW_CAP
    if (capped) rows.length = ROW_CAP
    rows.reverse()
    return { rows, capped }
  }

  function read(): Snapshot {
    const d = db!
    const tables = d.tables()
    const degraded: string[] = []
    const cols = (t: string) => (tables.has(t) ? d.columns(t) : new Set<string>())
    const tCols = cols('tasks')
    const rCols = cols('runs')
    const dCols = cols('dispatch_contexts')
    const wCols = cols('worker_dispatches')
    const mCols = cols('messages')
    const gCols = cols('decision_gates')
    if (!tCols.has('id') || !tCols.has('status')) throw new FatalSchema()

    const useRuns = rCols.has('id') && tCols.has('run_id')
    if (!useRuns) degraded.push('Runs table unavailable — runs grouped by coordinator terminal.')
    if (!tCols.has('deps')) degraded.push('Dependencies unavailable — the DAG shows tasks without edges.')
    const hasDispatch = dCols.has('id') && dCols.has('task_id')
    if (!hasDispatch) degraded.push('Dispatch attempts unavailable.')
    const hasMessages = mCols.has('id')
    if (!hasMessages) degraded.push('Messages unavailable — no conversation or message-based gates.')
    const hasGates = gCols.has('id') && gCols.has('task_id') && gCols.has('question')
    if (!hasGates && hasMessages && tables.has('decision_gates')) {
      degraded.push('Decision gates table has an unexpected shape — gates read from messages only.')
    }
    const capNote = (n: string) => degraded.push(`${n} capped at ${ROW_CAP.toLocaleString('en-US')} newest rows.`)

    /* tasks */
    const tr = readTable('tasks', tCols, ['id', 'run_id', 'parent_id', 'created_by_terminal_handle', 'task_title', 'display_name', 'spec', 'status', 'deps', 'result', 'created_at', 'completed_at'], '"_rowid"')
    if (tr.capped) capNote('Tasks')
    let invalidDeps = 0
    const taskRecs = new Map<string, TaskRec>()
    const groupFor = (handle: string | null) => `handle:${handle ?? 'unknown'}`
    for (const r of tr.rows) {
      const id = str(r.id)
      if (!id) continue
      const specRaw = str(r.spec) ?? ''
      const spec = redactText(specRaw)
      const result = str(r.result) === null ? null : redactText(str(r.result)!)
      const title = clip(
        redactText(str(r.task_title)?.trim() || str(r.display_name)?.trim() || firstLine(specRaw) || id),
        140,
      )
      let deps: string[] = []
      const rawDeps = r.deps
      if (rawDeps != null && String(rawDeps).trim() !== '') {
        const parsed = parseJson(rawDeps)
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) deps = parsed as string[]
        else invalidDeps++
      }
      const sp = truncate(spec, 240)
      const handle = str(r.created_by_terminal_handle)
      taskRecs.set(id, {
        spec,
        result,
        task: {
          id,
          runId: useRuns ? (str(r.run_id) ?? LEGACY_RUN_ID) : groupFor(handle),
          parentId: str(r.parent_id),
          title,
          specPreview: sp.text,
          specTruncated: sp.truncated,
          status: str(r.status) ?? 'unknown',
          deps,
          createdAt: parseTime(r.created_at),
          completedAt: parseTime(r.completed_at),
          resultPreview: result === null ? null : clip(result, 240),
          createdByHandle: handle,
          attemptCount: 0,
          latestDispatchId: null,
        },
      })
    }

    /* dispatches */
    const dispatches: OrchDispatch[] = []
    if (hasDispatch) {
      const dr = readTable('dispatch_contexts', dCols, ['id', 'run_id', 'task_id', 'assignee_handle', 'status', 'failure_count', 'last_failure', 'termination_reason', 'depth', 'dispatched_at', 'completed_at', 'last_heartbeat_at', 'created_at'], '"_rowid"')
      if (dr.capped) capNote('Dispatch attempts')
      const workerState = new Map<string, string>()
      if (wCols.has('dispatch_id') && wCols.has('state')) {
        const wr = readTable('worker_dispatches', wCols, ['dispatch_id', 'state'], '"_rowid"')
        for (const r of wr.rows) workerState.set(String(r.dispatch_id), String(r.state))
      }
      const latest = new Map<string, { key: string; rowid: number; id: string }>()
      for (const r of dr.rows) {
        const id = str(r.id)
        const taskId = str(r.task_id)
        if (!id || !taskId) continue
        const rec = taskRecs.get(taskId)
        dispatches.push({
          id,
          runId: rec?.task.runId ?? str(r.run_id) ?? LEGACY_RUN_ID,
          taskId,
          status: str(r.status) ?? 'unknown',
          assigneeHandle: str(r.assignee_handle),
          assigneeSessionId: null,
          dispatchedAt: parseTime(r.dispatched_at),
          completedAt: parseTime(r.completed_at),
          lastHeartbeatAt: parseTime(r.last_heartbeat_at),
          failureCount: num(r.failure_count),
          lastFailure: str(r.last_failure) === null ? null : clip(redactText(str(r.last_failure)!), 400),
          terminationReason: str(r.termination_reason),
          depth: r.depth == null ? null : num(r.depth),
          workerState: workerState.get(id) ?? null,
        })
        if (rec) {
          rec.task.attemptCount++
          const key = str(r.created_at) ?? ''
          const cur = latest.get(taskId)
          const rowid = num(r._rowid)
          if (!cur || key > cur.key || (key === cur.key && rowid > cur.rowid)) latest.set(taskId, { key, rowid, id })
        }
      }
      for (const [tid, l] of latest) taskRecs.get(tid)!.task.latestDispatchId = l.id
    }

    /* messages */
    const allMessages: OrchMessage[] = []
    let maxSequence: number | null = null
    const payloads = new Map<string, Row>()
    const hbTimes = new Map<string, EpochMs[]>()
    if (hasMessages) {
      const mr = readTable('messages', mCols, ['id', 'run_id', 'from_handle', 'to_handle', 'subject', 'body', 'type', 'priority', 'thread_id', 'payload', 'sequence', 'created_at'], '"sequence"')
      if (mr.capped) capNote('Messages')
      for (const r of mr.rows) {
        const id = str(r.id)
        if (!id) continue
        const payload = parseJson(r.payload) as Row | null
        const payloadTask = payload && typeof payload === 'object' ? str(payload.taskId) : null
        const rec = payloadTask ? taskRecs.get(payloadTask) : undefined
        const seq = num(r.sequence)
        if (maxSequence === null || seq > maxSequence) maxSequence = seq
        const body = redactText(str(r.body) ?? '')
        const runId = useRuns ? (str(r.run_id) ?? LEGACY_RUN_ID) : (rec?.task.runId ?? str(r.run_id) ?? LEGACY_RUN_ID)
        const msg: OrchMessage = {
          id,
          runId,
          sequence: seq,
          from: str(r.from_handle) ?? '',
          to: str(r.to_handle) ?? '',
          subject: clip(redactText(str(r.subject) ?? ''), 200),
          bodyPreview: clip(body, 400),
          type: str(r.type) ?? 'status',
          priority: str(r.priority) ?? 'normal',
          threadId: str(r.thread_id),
          taskId: rec ? payloadTask : null,
          createdAt: parseTime(r.created_at),
        }
        if (msg.type === 'heartbeat') {
          if (msg.createdAt !== null) {
            const arr = hbTimes.get(runId) ?? []
            arr.push(msg.createdAt)
            hbTimes.set(runId, arr)
          }
        } else {
          allMessages.push(msg)
          if (payload && typeof payload === 'object') payloads.set(id, payload)
        }
      }
    }

    /* gates */
    const gates: OrchGate[] = []
    const seenKeys = new Set<string>()
    const taskStatus = (id: string) => taskRecs.get(id)?.task.status
    const finishGate = (g: Omit<OrchGate, 'blocking'>): OrchGate => ({
      ...g,
      blocking: g.status === 'pending' || (g.status !== 'resolved' && taskStatus(g.taskId) === 'blocked'),
    })
    if (hasGates) {
      const gr = readTable('decision_gates', gCols, ['id', 'run_id', 'task_id', 'question', 'options', 'status', 'resolution', 'created_at', 'resolved_at'], '"_rowid"')
      if (gr.capped) capNote('Decision gates')
      for (const r of gr.rows) {
        const taskId = str(r.task_id) ?? ''
        const question = clip(redactText(str(r.question) ?? ''), 400)
        const opts = parseJson(r.options)
        seenKeys.add(`${taskId}\u0000${question}`)
        gates.push(
          finishGate({
            id: String(r.id),
            runId: taskRecs.get(taskId)?.task.runId ?? str(r.run_id) ?? LEGACY_RUN_ID,
            taskId,
            question,
            options: Array.isArray(opts) ? opts.map((o) => clip(redactText(String(o)), 200)) : [],
            status: str(r.status) ?? 'pending',
            resolution: str(r.resolution) === null ? null : clip(redactText(str(r.resolution)!), 400),
            createdAt: parseTime(r.created_at),
            resolvedAt: parseTime(r.resolved_at),
          }),
        )
      }
    }
    for (const m of allMessages) {
      if (m.type !== 'decision_gate') continue
      const p = payloads.get(m.id) ?? {}
      const taskId = m.taskId ?? ''
      const question = clip(redactText(str(p.question) ?? m.subject), 400)
      const key = `${taskId}\u0000${question}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      const reply = allMessages.find((x) => x.threadId === m.id && x.id !== m.id)
      gates.push(
        finishGate({
          id: m.id,
          runId: m.runId,
          taskId,
          question,
          options: Array.isArray(p.options) ? (p.options as unknown[]).map((o) => clip(redactText(String(o)), 200)) : [],
          status: reply ? 'resolved' : 'pending',
          resolution: reply ? reply.bodyPreview : null,
          createdAt: m.createdAt,
          resolvedAt: reply ? reply.createdAt : null,
        }),
      )
    }

    /* runs */
    const runRecs = new Map<string, OrchRun>()
    const blank = (id: string, objective: string, legacy: boolean): OrchRun => ({
      id, objective, coordinatorHandle: null, coordinatorSessionId: null, legacy,
      createdAt: null, updatedAt: null, lastActivityAt: null, taskCount: 0, statusCounts: {},
      dispatchCount: 0, messageCount: 0, hasBlockingGate: false,
    })
    if (useRuns) {
      const rr = readTable('runs', rCols, ['id', 'objective', 'coordinator_handle', 'legacy', 'created_at', 'updated_at'], '"_rowid"')
      if (rr.capped) capNote('Runs')
      for (const r of rr.rows) {
        const id = str(r.id)
        if (!id) continue
        const run = blank(id, clip(redactText(str(r.objective) ?? ''), 400), num(r.legacy) === 1 || id === LEGACY_RUN_ID)
        run.coordinatorHandle = str(r.coordinator_handle)
        run.createdAt = parseTime(r.created_at)
        run.updatedAt = parseTime(r.updated_at)
        runRecs.set(id, run)
      }
    }
    for (const { task } of taskRecs.values()) {
      if (runRecs.has(task.runId)) continue
      if (useRuns) runRecs.set(task.runId, blank(task.runId, task.runId, false))
      else {
        const run = blank(task.runId, task.createdByHandle ? `Coordinator ${task.createdByHandle}` : 'Unknown coordinator', false)
        run.coordinatorHandle = task.createdByHandle
        runRecs.set(task.runId, run)
      }
    }

    const details = new Map<string, OrchRunDetail>()
    for (const run of runRecs.values()) details.set(run.id, { run, tasks: [], dispatches: [], messages: [], gates: [] })
    const detailFor = (runId: string) => details.get(runId)
    for (const { task } of taskRecs.values()) detailFor(task.runId)?.tasks.push(task)
    for (const x of dispatches) detailFor(x.runId)?.dispatches.push(x)
    for (const x of allMessages) detailFor(x.runId)?.messages.push(x)
    for (const x of gates) detailFor(x.runId)?.gates.push(x)

    for (const det of details.values()) {
      const run = det.run
      run.taskCount = det.tasks.length
      for (const t of det.tasks) run.statusCounts[t.status] = (run.statusCounts[t.status] ?? 0) + 1
      run.dispatchCount = det.dispatches.length
      run.messageCount = det.messages.length
      run.hasBlockingGate = det.gates.some((g) => g.blocking)
      run.lastActivityAt = maxOf([
        ...det.tasks.flatMap((t) => [t.createdAt, t.completedAt]),
        ...det.dispatches.flatMap((x) => [x.dispatchedAt, x.completedAt, x.lastHeartbeatAt]),
        ...det.messages.map((m) => m.createdAt),
        ...(hbTimes.get(run.id) ?? []),
      ])
    }

    const visible = [...runRecs.values()].filter((r) => !(r.id === LEGACY_RUN_ID && r.taskCount === 0))
    visible.sort((a, b) => (b.lastActivityAt ?? b.createdAt ?? 0) - (a.lastActivityAt ?? a.createdAt ?? 0))
    const visibleIds = new Set(visible.map((r) => r.id))
    for (const id of [...details.keys()]) if (!visibleIds.has(id)) details.delete(id)

    const taskDetails = new Map<string, OrchTaskDetail>()
    for (const [id, rec] of taskRecs) {
      const det = details.get(rec.task.runId)
      if (!det) continue
      taskDetails.set(id, {
        task: rec.task,
        spec: truncate(rec.spec, FULL_TEXT_MAX).text,
        result: rec.result === null ? null : truncate(rec.result, FULL_TEXT_MAX).text,
        dispatches: det.dispatches.filter((x) => x.taskId === id),
        messages: det.messages.filter((m) => m.taskId === id),
        gates: det.gates.filter((g) => g.taskId === id),
      })
    }

    return {
      runs: visible, details, tasks: taskRecs, taskDetails, maxSequence, taskCount: taskRecs.size,
      messages: allMessages, degraded, invalidDeps, messageCount: allMessages.length,
    }
  }

  /* ───────────────────────── refresh / emit ───────────────────────── */

  function digestRuns(s: Snapshot): Map<string, string> {
    const out = new Map<string, string>()
    for (const [id, d] of s.details) out.set(id, createHash('sha256').update(JSON.stringify(d)).digest('hex'))
    return out
  }

  function updateStatus(): void {
    if (!snap) return
    const notes: string[] = []
    const visible = snap.runs.length
    notes.push(`${visible} run${visible === 1 ? '' : 's'} · ${snap.taskCount} task${snap.taskCount === 1 ? '' : 's'}`)
    const newer = schemaVersion !== null && schemaVersion > TESTED_SCHEMA_VERSION
    if (newer) notes.unshift(`schema v${schemaVersion} is newer than tested v${TESTED_SCHEMA_VERSION}`)
    if (snap.invalidDeps > 0) notes.push(`${snap.invalidDeps} task(s) with invalid deps JSON`)
    if (resetNote) notes.push(resetNote)
    if (readError) notes.push(readError)
    detailNote = notes.join(' · ')
    status = newer || snap.degraded.length > 0 || readError ? 'degraded' : 'ok'
  }

  function refresh(first: boolean): void {
    let next: Snapshot
    try {
      next = read()
      readError = null
    } catch (err) {
      if (err instanceof FatalSchema) {
        available = false
        status = 'error'
        detailNote = 'tasks table missing or lacks id/status columns'
        snap = null
        return
      }
      readError = `read failed: ${(err as Error).message}`
      log.warn(`orchestration read failed: ${(err as Error).message}`)
      if (snap) updateStatus()
      else {
        status = 'error'
        detailNote = readError
      }
      return
    }
    lastRead = now()
    available = true
    const prev = snap
    const nextDigests = digestRuns(next)
    let changed: string[]
    let newMessages: OrchMessage[] = []
    const reset =
      !first && prev !== null &&
      ((prev.maxSequence !== null && next.maxSequence !== null && next.maxSequence < prev.maxSequence) ||
        (prev.taskCount > 0 && next.taskCount === 0 && next.runs.length > 0))
    if (first || reset) {
      changed = [...new Set([...nextDigests.keys(), ...digests.keys()])]
      if (reset) {
        resetNote = 'orchestration state was reset'
        log.warn('orchestration state was reset')
      }
    } else {
      changed = []
      for (const [id, dg] of nextDigests) if (digests.get(id) !== dg) changed.push(id)
      for (const id of digests.keys()) if (!nextDigests.has(id)) changed.push(id)
      const last = prev?.maxSequence ?? -1
      newMessages = next.messages.filter((m) => m.sequence > last)
    }
    snap = next
    digests = nextDigests
    updateStatus()
    if (first || changed.length > 0 || newMessages.length > 0) {
      lastChange = now()
      const update: OrchestrationUpdate = { type: 'orchestration', summary: emptySummary(), changedRunIds: changed, newMessages }
      for (const l of [...listeners]) {
        try {
          l(update)
        } catch (err) {
          log.warn(`orchestration listener failed: ${(err as Error).message}`)
        }
      }
    }
  }

  function poll(): void {
    if (!db) return
    try {
      const v = db.dataVersion()
      if (v === lastDataVersion) return
      lastDataVersion = v
      refresh(false)
    } catch (err) {
      log.warn(`orchestration poll failed: ${(err as Error).message}`)
    }
  }

  /* ───────────────────────── lifecycle ───────────────────────── */

  return {
    id: ID,
    async start() {
      if (path === null) {
        status = 'disabled'
        detailNote = 'orchestration database not found or disabled'
        return
      }
      if (!existsSync(path)) {
        status = 'missing'
        detailNote = 'orchestration.db not found'
        return
      }
      try {
        db = openReadOnly(path, { deniedTables: [] })
        schemaVersion = db.userVersion()
        lastDataVersion = db.dataVersion()
        refresh(true)
      } catch (err) {
        status = 'error'
        available = false
        detailNote = `cannot open orchestration.db: ${(err as Error).message}`
        log.warn(detailNote)
        return
      }
      if (db) {
        timer = setInterval(poll, POLL_MS)
        timer.unref?.()
      }
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      listeners.clear()
      try {
        db?.close()
      } catch {
        /* already closed */
      }
      db = null
    },
    health(): SourceHealth {
      return {
        id: ID,
        label: 'Orchestration',
        status,
        path,
        version: schemaVersion === null ? null : `v${schemaVersion}`,
        detail: detailNote,
        lastReadAt: lastRead,
        lastChangeAt: lastChange,
      }
    },
    subscribe(listener): Unsubscribe {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    summary: emptySummary,
    getRun: (id) => snap?.details.get(id) ?? null,
    getTask: (id) => snap?.taskDetails.get(id) ?? null,
  }
}

class FatalSchema extends Error {}
