/**
 * Builds real SQLite files shaped like Orca's orchestration.db (schema v43, trimmed to the tables
 * and columns Orca Command Center reads plus a few unread ones). Test-only; uses a writable
 * connection, which production code never does.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type OrchestrationVariant = 'current-machine' | 'rich' | 'old-schema' | 'newer-schema'

export const COORDINATOR_HANDLE = 'term_c0ffee01-fe93-45cc-b918-f0bf12a15e2a'
export const RICH_RUN_ID = 'run_rich0000001'
/** Fake credential planted in a rich-variant message body; must never reach API output. */
export const FAKE_TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'

const DDL_V43 = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, objective TEXT NOT NULL, home_database TEXT NOT NULL DEFAULT 'this_database',
  coordinator_handle TEXT, coordinator_pane_key TEXT, coordinator_orca_session_id TEXT,
  consumer_generation INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE messages (
  id TEXT NOT NULL, run_id TEXT NOT NULL DEFAULT 'run_legacy_local',
  from_handle TEXT NOT NULL, to_handle TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'status', priority TEXT NOT NULL DEFAULT 'normal',
  thread_id TEXT, payload TEXT, read INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT
);
CREATE UNIQUE INDEX idx_messages_id ON messages(id);
CREATE TABLE worker_dispatches (
  dispatch_id TEXT PRIMARY KEY, runtime_epoch TEXT,
  state TEXT NOT NULL DEFAULT 'starting', stage TEXT NOT NULL DEFAULT 'accepted',
  worktree_id TEXT, agent_terminal_handle TEXT, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL DEFAULT 'run_legacy_local', parent_id TEXT,
  created_by_terminal_handle TEXT, task_title TEXT, display_name TEXT, spec TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', deps TEXT NOT NULL DEFAULT '[]', result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
);
CREATE TABLE dispatch_contexts (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL DEFAULT 'run_legacy_local', task_id TEXT NOT NULL,
  assignee_handle TEXT, status TEXT NOT NULL DEFAULT 'pending',
  failure_count INTEGER NOT NULL DEFAULT 0, last_failure TEXT, termination_reason TEXT,
  depth INTEGER NOT NULL DEFAULT 1, dispatched_at TEXT, completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), last_heartbeat_at TEXT
);
CREATE TABLE decision_gates (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL DEFAULT 'run_legacy_local', task_id TEXT NOT NULL,
  question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
  resolution TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
);
`

function insert(db: DatabaseSync, table: string, row: Record<string, SQLInputValue>): void {
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
  ).run(...keys.map((k) => row[k] as SQLInputValue))
}

export function openWritable(path: string): DatabaseSync {
  return new DatabaseSync(path)
}

/** Creates `<dir>/orchestration.db` for the variant and returns its path. */
export function createOrchestrationFixture(dir: string, variant: OrchestrationVariant): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'orchestration.db')
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    if (variant === 'old-schema') {
      db.exec(`
        CREATE TABLE tasks (id TEXT PRIMARY KEY, created_by_terminal_handle TEXT, spec TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', result TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
        PRAGMA user_version = 5;
      `)
      insert(db, 'tasks', { id: 'task_old1', created_by_terminal_handle: 'term_old', spec: 'Old task one\nmore', status: 'ready', created_at: '2026-01-02 03:04:05' })
      insert(db, 'tasks', { id: 'task_old2', created_by_terminal_handle: 'term_old', spec: 'Old task two', status: 'completed', result: 'done', created_at: '2026-01-02 03:05:05', completed_at: '2026-01-02 04:00:00' })
      return path
    }
    db.exec(DDL_V43)
    if (variant === 'newer-schema') {
      db.exec('ALTER TABLE tasks ADD COLUMN future_column TEXT')
      db.exec('PRAGMA user_version = 44')
    } else {
      db.exec('PRAGMA user_version = 43')
    }
    if (variant === 'current-machine' || variant === 'newer-schema') {
      insert(db, 'runs', { id: 'run_legacy_local', objective: 'Legacy orchestration state (inspect only)', legacy: 1, created_at: '2026-10-05 08:27:20', updated_at: '2026-10-05 08:27:20' })
      insert(db, 'runs', { id: 'run_c0ffee000001', objective: 'Demo task board', coordinator_handle: COORDINATOR_HANDLE, created_at: '2026-10-20 13:49:11', updated_at: '2026-10-20 13:49:11' })
      const specs = ['Build the board layout', 'Add drag and drop', 'Write persistence layer']
      specs.forEach((spec, i) =>
        insert(db, 'tasks', {
          id: `task_cm${i + 1}`, run_id: 'run_c0ffee000001', created_by_terminal_handle: COORDINATOR_HANDLE,
          spec, status: 'ready', created_at: `2026-10-20 13:49:1${3 + Math.min(i, 1)}`,
        }),
      )
    }
    if (variant === 'rich') seedRich(db)
  } finally {
    db.close()
  }
  return path
}

function seedRich(db: DatabaseSync): void {
  const run = RICH_RUN_ID
  insert(db, 'runs', { id: 'run_legacy_local', objective: 'Legacy orchestration state (inspect only)', legacy: 1, created_at: '2026-10-05 08:27:20', updated_at: '2026-10-05 08:27:20' })
  insert(db, 'runs', { id: run, objective: 'Ship the widget', coordinator_handle: COORDINATOR_HANDLE, created_at: '2026-10-21 09:00:00', updated_at: '2026-10-21 09:30:00' })
  const t = (id: string, o: Record<string, SQLInputValue>) =>
    insert(db, 'tasks', { id, run_id: run, created_by_terminal_handle: COORDINATOR_HANDLE, spec: `Spec for ${id}\nsecond line`, created_at: '2026-10-21 09:01:00', ...o })
  t('task_r1', { task_title: 'Design schema', status: 'completed', result: 'Schema designed', completed_at: '2026-10-21 09:10:00' })
  t('task_r2', { display_name: 'Research libs', status: 'completed', result: 'Libs chosen', completed_at: '2026-10-21 09:11:00' })
  t('task_r3', { status: 'completed', deps: '["task_r1","task_r2"]', completed_at: '2026-10-21 09:15:00', result: 'ok' })
  t('task_r4', { task_title: 'Implement API', status: 'failed', deps: '["task_r1","task_r2"]', result: 'gave up' })
  t('task_r5', { task_title: 'Implement UI', status: 'blocked', deps: '["task_r1","task_r2"]', spec: 'x'.repeat(500) })
  t('task_r6', { task_title: 'Integrate', status: 'pending', deps: '["task_r3","task_r4","task_r5"]' })
  const d = (id: string, task: string, o: Record<string, SQLInputValue>) =>
    insert(db, 'dispatch_contexts', { id, run_id: run, task_id: task, assignee_handle: 'term_worker1', created_at: '2026-10-21 09:02:00', ...o })
  d('disp_1', 'task_r1', { status: 'completed', dispatched_at: '2026-10-21 09:02:00', completed_at: '2026-10-21 09:10:00', last_heartbeat_at: '2026-10-21 09:09:00' })
  d('disp_2', 'task_r2', { status: 'completed', dispatched_at: '2026-10-21 09:02:00', completed_at: '2026-10-21 09:11:00', last_heartbeat_at: '2026-10-21 09:10:00' })
  d('disp_3', 'task_r3', { status: 'completed', dispatched_at: '2026-10-21 09:12:00', completed_at: '2026-10-21 09:15:00', created_at: '2026-10-21 09:12:00' })
  d('disp_4a', 'task_r4', { status: 'failed', failure_count: 1, last_failure: 'timeout', dispatched_at: '2026-10-21 09:12:00', created_at: '2026-10-21 09:12:00' })
  d('disp_4b', 'task_r4', { status: 'circuit_broken', failure_count: 3, last_failure: 'repeated crash', termination_reason: 'crashed', depth: 2, dispatched_at: '2026-10-21 09:20:00', created_at: '2026-10-21 09:20:00', last_heartbeat_at: '2026-10-21 09:21:00' })
  d('disp_5', 'task_r5', { status: 'dispatched', dispatched_at: '2026-10-21 09:13:00', created_at: '2026-10-21 09:13:00', last_heartbeat_at: '2026-10-21 09:25:00' })
  for (const [id, state] of [['disp_4b', 'failed'], ['disp_5', 'ready']] as const) insert(db, 'worker_dispatches', { dispatch_id: id, state })
  const m = (id: string, type: string, o: Record<string, SQLInputValue>) =>
    insert(db, 'messages', { id, run_id: run, from_handle: 'term_worker1', to_handle: COORDINATOR_HANDLE, subject: type, type, created_at: '2026-10-21 09:10:00', ...o })
  m('msg_hb1', 'heartbeat', { created_at: '2026-10-21 09:09:00' })
  m('msg_done', 'worker_done', { subject: 'Schema done', body: `Finished. token ${FAKE_TOKEN}`, payload: '{"taskId":"task_r1"}' })
  m('msg_hb2', 'heartbeat', { created_at: '2026-10-21 09:11:00' })
  m('msg_gate', 'decision_gate', { from_handle: 'term_worker2', subject: 'Pick a framework', body: 'Need a decision', payload: '{"taskId":"task_r5","question":"Which framework?","options":["react","solid"]}', created_at: '2026-10-21 09:26:00', priority: 'high' })
  m('msg_q', 'question', { subject: 'Which branch?', body: 'Main or dev?', created_at: '2026-10-21 09:27:00' })
  insert(db, 'decision_gates', { id: 'gate_old', run_id: run, task_id: 'task_r3', question: 'Use TypeScript?', options: '["yes","no"]', status: 'resolved', resolution: 'yes', created_at: '2026-10-21 09:05:00', resolved_at: '2026-10-21 09:06:00' })
}

/** Test helper: append a message after the source started. Returns its sequence. */
export function appendMessage(path: string, row: Record<string, SQLInputValue>): number {
  const db = openWritable(path)
  try {
    insert(db, 'messages', {
      id: `msg_${Math.random().toString(36).slice(2, 10)}`, run_id: RICH_RUN_ID,
      from_handle: 'term_worker1', to_handle: COORDINATOR_HANDLE, subject: 'appended', type: 'status', ...row,
    })
    return Number((db.prepare('SELECT max(sequence) AS s FROM messages').get() as { s: number }).s)
  } finally {
    db.close()
  }
}

/** Test helper: run arbitrary write SQL (UPDATE/DELETE/INSERT) against the fixture. */
export function execSql(path: string, sql: string): void {
  const db = openWritable(path)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}
