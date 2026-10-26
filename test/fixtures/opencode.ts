/**
 * Test fixture for the OpenCode adapter: a writable SQLite file with the real opencode.db DDL
 * (session/message/part/event/event_sequence/todo/project) plus the denied tables filled with
 * obviously fake secrets so tests can prove they are never read.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { join } from 'node:path'

export const FAKE_SECRETS = [
  'ghp_' + 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
  'sk-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
  'FAKE-ACCOUNT-ACCESS-TOKEN-12345',
  'FAKE-CREDENTIAL-SECRET-67890',
  'fake.person@example.invalid',
] as const

const DDL = `
CREATE TABLE \`project\` (
  \`id\` text PRIMARY KEY, \`worktree\` text NOT NULL, \`vcs\` text, \`name\` text, \`icon_url\` text,
  \`icon_url_override\` text, \`icon_color\` text, \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL, \`time_initialized\` integer, \`sandboxes\` text NOT NULL, \`commands\` text
);
CREATE TABLE \`session\` (
  \`id\` text PRIMARY KEY, \`project_id\` text NOT NULL, \`workspace_id\` text, \`parent_id\` text,
  \`slug\` text NOT NULL, \`directory\` text NOT NULL, \`path\` text, \`title\` text NOT NULL,
  \`version\` text NOT NULL, \`share_url\` text, \`summary_additions\` integer, \`summary_deletions\` integer,
  \`summary_files\` integer, \`summary_diffs\` text, \`metadata\` text, \`cost\` real DEFAULT 0 NOT NULL,
  \`tokens_input\` integer DEFAULT 0 NOT NULL, \`tokens_output\` integer DEFAULT 0 NOT NULL,
  \`tokens_reasoning\` integer DEFAULT 0 NOT NULL, \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
  \`tokens_cache_write\` integer DEFAULT 0 NOT NULL, \`revert\` text, \`permission\` text, \`agent\` text,
  \`model\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
  \`time_compacting\` integer, \`time_archived\` integer,
  CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);
CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);
CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);
CREATE TABLE \`message\` (
  \`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL, \`data\` text NOT NULL,
  CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE TABLE \`part\` (
  \`id\` text PRIMARY KEY, \`message_id\` text NOT NULL, \`session_id\` text NOT NULL,
  \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL,
  CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);
CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);
CREATE TABLE \`event_sequence\` (
  \`aggregate_id\` text PRIMARY KEY, \`seq\` integer NOT NULL, \`owner_id\` text
);
CREATE TABLE \`event\` (
  \`id\` text PRIMARY KEY, \`aggregate_id\` text NOT NULL, \`seq\` integer NOT NULL, \`type\` text NOT NULL,
  \`data\` text NOT NULL,
  CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);
CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);
CREATE TABLE \`todo\` (
  \`session_id\` text NOT NULL, \`content\` text NOT NULL, \`status\` text NOT NULL, \`priority\` text NOT NULL,
  \`position\` integer NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
  CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
  CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);
-- denied tables (simplified): must never be read by the adapter
CREATE TABLE \`account\` (id text PRIMARY KEY, email text, access_token text, refresh_token text);
CREATE TABLE \`account_state\` (id text PRIMARY KEY, active_account_id text, token text);
CREATE TABLE \`control_account\` (email text, url text, access_token text);
CREATE TABLE \`credential\` (id text PRIMARY KEY, secret text);
CREATE TABLE \`permission\` (project_id text PRIMARY KEY, data text);
INSERT INTO \`account\` VALUES ('acc_1', '${FAKE_SECRETS[4]}', '${FAKE_SECRETS[2]}', '${FAKE_SECRETS[0]}');
INSERT INTO \`account_state\` VALUES ('st_1', 'acc_1', '${FAKE_SECRETS[2]}');
INSERT INTO \`control_account\` VALUES ('${FAKE_SECRETS[4]}', 'https://x.invalid', '${FAKE_SECRETS[2]}');
INSERT INTO \`credential\` VALUES ('cred_1', '${FAKE_SECRETS[3]}');
INSERT INTO \`permission\` VALUES ('proj_1', '{"token":"${FAKE_SECRETS[1]}"}');
`

export interface SessionInput {
  id: string
  parentId?: string | null
  title?: string
  agent?: string | null
  model?: { id: string; providerID: string; variant?: string } | null
  directory?: string
  version?: string
  created?: number
  updated?: number
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
  summary?: { files?: number | null; additions?: number | null; deletions?: number | null }
  archived?: number | null
}

export interface MessageInput {
  id: string
  sessionId: string
  /** The message `data` JSON (role, time, …). */
  data: Record<string, unknown>
  created?: number
}

export interface PartInput {
  id: string
  messageId: string
  sessionId: string
  /** The part `data` JSON (type, …). */
  data: Record<string, unknown>
  created?: number
  updated?: number
}

export interface StepStartInput {
  id: string
  messageId: string
  sessionId: string
  created?: number
}

export interface StepFinishInput extends StepStartInput {
  tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number } | null
  cost?: number | null
  reason?: string
  /** Extra/override fields merged into the part `data` (e.g. to drop `cost`). */
  extra?: Record<string, unknown>
}

export interface OpenCodeFixture {
  path: string
  /** Writable connection — test-only. */
  db: DatabaseSync
  addSession(s: SessionInput): void
  updateSession(id: string, patch: { title?: string; updated?: number; cost?: number }): void
  addMessage(m: MessageInput): void
  addPart(p: PartInput): void
  /** Add a `step-start` part. */
  addStepStart(p: StepStartInput): void
  /** Add a `step-finish` part (tokens default 0; `cost: null` omits the field). */
  addStepFinish(p: StepFinishInput): void
  /** Replace the text of a text/reasoning part and append its `message.part.updated.1` event (streaming growth). Returns the event rowid. */
  appendTextGrowth(partId: string, text: string, time?: number): number
  /** Update the `data` of an existing part (and its time_updated). */
  updatePart(id: string, data: Record<string, unknown>, updated?: number): void
  /** Insert an event row; returns its rowid. */
  appendEvent(e: { aggregateId: string; type: string; data: unknown; id?: string }): number
  /** Convenience: append a `message.part.updated.1` event for a part (full data, includes ids). */
  appendPartEvent(partId: string, time?: number): number
  /** Convenience: append `message.updated.1` for a stored message. */
  appendMessageEvent(messageId: string, time?: number): number
  appendSessionEvent(sessionId: string, type?: 'session.updated.1' | 'session.created.1'): number
  setTodos(sessionId: string, todos: Array<{ content: string; status: string; priority?: string }>, time?: number): void
  maxEventRowid(): number
  close(): void
}

export function createOpenCodeFixture(dir: string, fileName = 'opencode.db'): OpenCodeFixture {
  const path = join(dir, fileName)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(DDL)
  db.prepare(
    `INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, '[]')`,
  ).run('proj_fixture', '/repo/app', 'app', 0, 0)
  const projectRows = new Set<string>(['proj_fixture'])
  void projectRows

  let eventCounter = 0
  const seqs = new Map<string, number>()
  const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p)
  const sessionRowInfo = (id: string): Record<string, unknown> | null => {
    const r = db.prepare('SELECT * FROM session WHERE id = ?').get(id) as Record<string, any> | undefined
    if (!r) return null
    return {
      id: r.id,
      slug: r.slug,
      projectID: r.project_id,
      directory: r.directory,
      parentID: r.parent_id ?? undefined,
      title: r.title,
      agent: r.agent ?? undefined,
      model: r.model ? JSON.parse(r.model) : undefined,
      version: r.version,
      cost: r.cost,
      tokens: {
        input: r.tokens_input,
        output: r.tokens_output,
        reasoning: r.tokens_reasoning,
        cache: { read: r.tokens_cache_read, write: r.tokens_cache_write },
      },
      time: { created: r.time_created, updated: r.time_updated },
    }
  }

  const fixture: OpenCodeFixture = {
    path,
    db,
    addSession(s) {
      const created = s.created ?? Date.now()
      run(
        `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, summary_additions,
           summary_deletions, summary_files, cost, tokens_input, tokens_output, tokens_reasoning,
           tokens_cache_read, tokens_cache_write, agent, model, time_created, time_updated, time_archived)
         VALUES (?, 'proj_fixture', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.id,
        s.parentId ?? null,
        s.id.slice(-8),
        s.directory ?? '/repo/app',
        s.title ?? `Session ${s.id}`,
        s.version ?? 'v1.19.3',
        s.summary?.additions ?? null,
        s.summary?.deletions ?? null,
        s.summary?.files ?? null,
        s.cost ?? 0,
        s.tokens?.input ?? 0,
        s.tokens?.output ?? 0,
        s.tokens?.reasoning ?? 0,
        s.tokens?.cacheRead ?? 0,
        s.tokens?.cacheWrite ?? 0,
        s.agent ?? null,
        s.model ? JSON.stringify(s.model) : null,
        created,
        s.updated ?? created,
        s.archived ?? null,
      )
    },
    updateSession(id, patch) {
      if (patch.title !== undefined) run('UPDATE session SET title = ? WHERE id = ?', patch.title, id)
      if (patch.cost !== undefined) run('UPDATE session SET cost = ? WHERE id = ?', patch.cost, id)
      if (patch.updated !== undefined) run('UPDATE session SET time_updated = ? WHERE id = ?', patch.updated, id)
    },
    addMessage(m) {
      const created = m.created ?? (m.data['time'] as { created?: number } | undefined)?.created ?? Date.now()
      run(
        'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
        m.id,
        m.sessionId,
        created,
        created,
        JSON.stringify(m.data),
      )
    },
    addPart(p) {
      const created = p.created ?? Date.now()
      run(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
        p.id,
        p.messageId,
        p.sessionId,
        created,
        p.updated ?? created,
        JSON.stringify({ ...p.data }),
      )
    },
    addStepStart(p) {
      fixture.addPart({ id: p.id, messageId: p.messageId, sessionId: p.sessionId, created: p.created, data: { type: 'step-start', snapshot: 'snap' } })
    },
    addStepFinish(p) {
      const t = p.tokens === null ? null : (p.tokens ?? {})
      const data: Record<string, unknown> = { type: 'step-finish', reason: p.reason ?? 'tool-calls' }
      if (t) {
        const [i, o, r, cr, cw] = [t.input ?? 0, t.output ?? 0, t.reasoning ?? 0, t.cacheRead ?? 0, t.cacheWrite ?? 0]
        data['tokens'] = { total: i + o + r + cr + cw, input: i, output: o, reasoning: r, cache: { read: cr, write: cw } }
      }
      if (p.cost !== null) data['cost'] = p.cost ?? 0
      fixture.addPart({ id: p.id, messageId: p.messageId, sessionId: p.sessionId, created: p.created, data: { ...data, ...(p.extra ?? {}) } })
    },
    appendTextGrowth(partId, text, time) {
      const row = db.prepare('SELECT * FROM part WHERE id = ?').get(partId) as Record<string, any>
      const data = { ...JSON.parse(row.data), text }
      const t = time ?? Date.now()
      run('UPDATE part SET data = ?, time_updated = ? WHERE id = ?', JSON.stringify(data), t, partId)
      return fixture.appendEvent({
        aggregateId: row.session_id,
        type: 'message.part.updated.1',
        data: { sessionID: row.session_id, part: { ...data, id: row.id, sessionID: row.session_id, messageID: row.message_id }, time: t },
      })
    },
    updatePart(id, data, updated) {
      run('UPDATE part SET data = ?, time_updated = ? WHERE id = ?', JSON.stringify(data), updated ?? Date.now(), id)
    },
    appendEvent(e) {
      const seq = (seqs.get(e.aggregateId) ?? 0) + 1
      seqs.set(e.aggregateId, seq)
      run(
        'INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?) ON CONFLICT(aggregate_id) DO UPDATE SET seq = excluded.seq',
        e.aggregateId,
        seq,
      )
      const r = run(
        'INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)',
        e.id ?? `evt_${String(++eventCounter).padStart(8, '0')}`,
        e.aggregateId,
        seq,
        e.type,
        JSON.stringify(e.data),
      )
      return Number(r.lastInsertRowid)
    },
    appendPartEvent(partId, time) {
      const row = db.prepare('SELECT * FROM part WHERE id = ?').get(partId) as Record<string, any>
      const data = JSON.parse(row.data)
      return fixture.appendEvent({
        aggregateId: row.session_id,
        type: 'message.part.updated.1',
        data: {
          sessionID: row.session_id,
          part: { ...data, id: row.id, sessionID: row.session_id, messageID: row.message_id },
          time: time ?? row.time_updated,
        },
      })
    },
    appendMessageEvent(messageId, time) {
      const row = db.prepare('SELECT * FROM message WHERE id = ?').get(messageId) as Record<string, any>
      const data = JSON.parse(row.data)
      void time
      return fixture.appendEvent({
        aggregateId: row.session_id,
        type: 'message.updated.1',
        data: { sessionID: row.session_id, info: { ...data, id: row.id, sessionID: row.session_id } },
      })
    },
    appendSessionEvent(sessionId, type = 'session.updated.1') {
      return fixture.appendEvent({
        aggregateId: sessionId,
        type,
        data: { sessionID: sessionId, info: sessionRowInfo(sessionId) },
      })
    },
    setTodos(sessionId, todos, time = Date.now()) {
      run('DELETE FROM todo WHERE session_id = ?', sessionId)
      todos.forEach((t, i) =>
        run(
          'INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
          sessionId,
          t.content,
          t.status,
          t.priority ?? 'medium',
          i,
          time,
          time,
        ),
      )
    },
    maxEventRowid() {
      const r = db.prepare('SELECT max(rowid) AS m FROM event').get() as { m: number | null }
      return Number(r.m ?? 0)
    },
    close() {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    },
  }
  return fixture
}

/* ─────────────────────────────── Realistic fleet ─────────────────────────────── */

export const FLEET = {
  root: 'ses_root_build',
  childDone: 'ses_child_done',
  childLive: 'ses_child_live',
  rootQuestion: 'ses_root_question',
  rootOld: 'ses_root_old',
  directory: '/repo/app',
  /** Fake secret embedded in a bash command (must be redacted). */
  commandSecret: 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  prUrl: 'https://github.com/acme/app/pull/42',
  parts: {
    userText: 'prt_a01_user_text',
    userFile: 'prt_a02_user_file',
    reasoning: 'prt_b01_reasoning',
    bashDone: 'prt_b02_bash_done',
    read: 'prt_b03_read',
    edit: 'prt_b04_edit',
    write: 'prt_b05_write',
    jira: 'prt_b06_jira',
    bitrise: 'prt_b07_bitrise',
    taskDone: 'prt_b08_task_done',
    taskLive: 'prt_b09_task_live',
    todowrite: 'prt_b10_todowrite',
    stepFinish: 'prt_b11_step_finish',
    patch: 'prt_b12_patch',
    prText: 'prt_b13_text_pr',
    bashRunning: 'prt_c01_bash_running',
    streamText: 'prt_c02_stream_text',
    childDoneText: 'prt_d02_text',
    childLiveReasoning: 'prt_e02_reasoning',
    questionTool: 'prt_f02_question',
  },
  messages: {
    user: 'msg_a01_user',
    asstDone: 'msg_b01_assistant',
    asstLive: 'msg_c01_assistant',
  },
} as const

/**
 * Seeds the realistic fleet. All times are relative to `now`.
 *  - `ses_root_build`     root, agent build, Opus, in /repo/app; assistant turn IN PROGRESS
 *                         (running bash + streaming text) → transcriptState working
 *  - `ses_child_done`     subagent (sonnet-coder), completed
 *  - `ses_child_live`     subagent (explore), in progress (unfinished reasoning)
 *  - `ses_root_question`  root with unfinished assistant message + pending `question` tool → waiting
 *  - `ses_root_old`       root outside a 1 h window (updated 3 days ago), completed turn
 * Event rows are appended for the live message of the root, both children and the question session
 * (streaming text part has 3 coalescable updates). Returns the fixture's max event rowid.
 */
export function seedRealisticFleet(fixture: OpenCodeFixture, now: number): { eventRowid: number } {
  const P = FLEET.parts
  const M = FLEET.messages
  const t = (secAgo: number) => now - secAgo * 1000
  const dir = FLEET.directory
  const opus = { id: 'claude-opus-5.5', providerID: 'github-copilot', variant: 'max' }

  fixture.addSession({
    id: FLEET.root,
    title: 'Implement the command center',
    agent: 'build',
    model: opus,
    directory: dir,
    created: t(900),
    updated: t(2),
    cost: 1.25,
    tokens: { input: 1200, output: 3400, reasoning: 800, cacheRead: 50_000, cacheWrite: 7000 },
    summary: { files: 3, additions: 40, deletions: 5 },
  })
  fixture.addSession({
    id: FLEET.childDone,
    parentId: FLEET.root,
    title: 'Validate the schema (@sonnet-coder subagent)',
    agent: 'sonnet-coder',
    model: { id: 'claude-sonnet-5.5', providerID: 'github-copilot' },
    directory: dir,
    created: t(500),
    updated: t(300),
    cost: 0.1,
    tokens: { input: 10, output: 200 },
  })
  fixture.addSession({
    id: FLEET.childLive,
    parentId: FLEET.root,
    title: 'Explore the repo (@explore subagent)',
    agent: 'explore',
    model: opus,
    directory: dir,
    created: t(60),
    updated: t(3),
    cost: 0.05,
    tokens: { input: 5, output: 50 },
  })
  fixture.addSession({
    id: FLEET.rootQuestion,
    title: 'Pick a database',
    agent: 'plan',
    model: opus,
    directory: '/repo/other',
    created: t(400),
    updated: t(20),
  })
  fixture.addSession({
    id: FLEET.rootOld,
    title: 'Old finished work',
    agent: 'build',
    model: opus,
    directory: '/repo/old',
    created: t(3 * 86400 + 600),
    updated: t(3 * 86400),
    cost: 0.2,
    tokens: { input: 1, output: 9 },
  })

  /* ---- root: user message ---- */
  fixture.addMessage({
    id: M.user,
    sessionId: FLEET.root,
    created: t(890),
    data: { role: 'user', time: { created: t(890) }, agent: 'build', model: { providerID: 'github-copilot', modelID: 'claude-opus-5.5' } },
  })
  fixture.addPart({
    id: P.userText,
    messageId: M.user,
    sessionId: FLEET.root,
    created: t(890),
    data: { type: 'text', text: 'Please build the command center and open a PR.' },
  })
  fixture.addPart({
    id: P.userFile,
    messageId: M.user,
    sessionId: FLEET.root,
    created: t(889),
    data: { type: 'file', mime: 'image/png', filename: 'mock.png', url: FLEET.dataUrl, source: { type: 'file', path: '/tmp/mock.png' } },
  })

  /* ---- root: completed assistant turn ---- */
  fixture.addMessage({
    id: M.asstDone,
    sessionId: FLEET.root,
    created: t(880),
    data: {
      role: 'assistant',
      parentID: M.user,
      mode: 'build',
      agent: 'build',
      path: { cwd: dir, root: dir },
      cost: 0.6,
      tokens: { total: 5000, input: 100, output: 400, reasoning: 200, cache: { read: 4000, write: 300 } },
      modelID: 'claude-opus-5.5',
      providerID: 'github-copilot',
      time: { created: t(880), completed: t(300) },
      finish: 'tool-calls',
    },
  })
  const asst = (id: string, data: Record<string, unknown>, secAgo: number, updatedSecAgo = secAgo) =>
    fixture.addPart({ id, messageId: M.asstDone, sessionId: FLEET.root, created: t(secAgo), updated: t(updatedSecAgo), data })
  asst(P.reasoning, {
    type: 'reasoning',
    text: 'I should check the schema first, then write the adapter.',
    time: { start: t(879), end: t(876) },
    metadata: { anthropic: { signature: 'SIGNATURE_BLOB_DO_NOT_LEAK' } },
  }, 879, 876)
  asst(P.bashDone, {
    type: 'tool',
    callID: 'call_bash1',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: `GH_TOKEN=${FLEET.commandSecret} gh pr list --repo acme/app`, description: 'List PRs' },
      output: '\u001b[32m#42\u001b[0m Add command center\n#41 Fix lint',
      title: 'List PRs',
      metadata: { exit: 0 },
      time: { start: t(870), end: t(868) },
    },
  }, 870, 868)
  asst(P.read, {
    type: 'tool',
    callID: 'call_read1',
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: `${dir}/src/app.ts` },
      output: '<file>\n00001| export const secretish = 1\n</file>',
      time: { start: t(860), end: t(859) },
    },
  }, 860, 859)
  asst(P.edit, {
    type: 'tool',
    callID: 'call_edit1',
    tool: 'edit',
    state: {
      status: 'completed',
      input: { filePath: `${dir}/src/app.ts`, oldString: 'a', newString: 'b' },
      output: 'Edit applied successfully.',
      metadata: {
        diff: `Index: ${dir}/src/app.ts\n===================================================================\n--- ${dir}/src/app.ts\n+++ ${dir}/src/app.ts\n@@ -1,3 +1,4 @@\n line one\n-old line\n+new line\n+another new line\n line three\n`,
        diagnostics: {},
      },
      time: { start: t(850), end: t(849) },
    },
  }, 850, 849)
  asst(P.write, {
    type: 'tool',
    callID: 'call_write1',
    tool: 'write',
    state: {
      status: 'completed',
      input: { filePath: `${dir}/Plan.md`, content: '# Plan\n\nStep one\nStep two\n' },
      output: 'Wrote file successfully.',
      metadata: { filepath: `${dir}/Plan.md`, exists: false },
      time: { start: t(840), end: t(839) },
    },
  }, 840, 839)
  asst(P.jira, {
    type: 'tool',
    callID: 'call_jira1',
    tool: 'atlassian_jira_get_issue',
    state: {
      status: 'completed',
      input: { issueKey: 'ACME-1234' },
      output: '{"key":"ACME-1234","summary":"Remote start"}',
      time: { start: t(830), end: t(828) },
    },
  }, 830, 828)
  asst(P.bitrise, {
    type: 'tool',
    callID: 'call_bitrise1',
    tool: 'bitrise_get_build_log',
    state: {
      status: 'error',
      input: { buildSlug: 'abc123' },
      error: 'Request failed: 404 build not found',
      time: { start: t(820), end: t(819) },
    },
  }, 820, 819)
  asst(P.taskDone, {
    type: 'tool',
    callID: 'call_task1',
    tool: 'task',
    state: {
      status: 'completed',
      input: { description: 'Validate the schema', prompt: 'Check the DDL', subagent_type: 'sonnet-coder' },
      output: 'Schema is fine.',
      metadata: { sessionId: FLEET.childDone, parentSessionId: FLEET.root, model: { modelID: 'claude-sonnet-5.5', providerID: 'github-copilot' } },
      time: { start: t(510), end: t(300) },
    },
  }, 510, 300)
  asst(P.taskLive, {
    type: 'tool',
    callID: 'call_task2',
    tool: 'task',
    state: {
      status: 'running',
      input: { description: 'Explore the repo', prompt: 'Look around', subagent_type: 'explore' },
      metadata: { sessionId: FLEET.childLive, parentSessionId: FLEET.root },
      time: { start: t(61) },
    },
  }, 61, 61)
  asst(P.todowrite, {
    type: 'tool',
    callID: 'call_todo1',
    tool: 'todowrite',
    state: {
      status: 'completed',
      input: { todos: [{ content: 'Write adapter', status: 'in_progress', priority: 'high' }, { content: 'Write tests', status: 'pending', priority: 'medium' }] },
      output: '[]',
      time: { start: t(700), end: t(699) },
    },
  }, 700, 699)
  asst(P.stepFinish, {
    type: 'step-finish',
    reason: 'tool-calls',
    tokens: { total: 5000, input: 100, output: 400, reasoning: 200, cache: { read: 4000, write: 300 } },
    cost: 0.6,
  }, 310)
  asst(P.patch, { type: 'patch', hash: 'abc1234', files: [`${dir}/src/app.ts`, `${dir}/src/other.ts`] }, 305)
  asst(P.prText, { type: 'text', text: `Opened the PR: ${FLEET.prUrl} — please review.`, time: { start: t(302), end: t(301) } }, 302, 301)
  fixture.addPart({
    id: 'prt_b00_step_start',
    messageId: M.asstDone,
    sessionId: FLEET.root,
    created: t(881),
    data: { type: 'step-start', snapshot: 'snap1' },
  })

  /* ---- root: in-progress assistant turn ---- */
  fixture.addMessage({
    id: M.asstLive,
    sessionId: FLEET.root,
    created: t(30),
    data: {
      role: 'assistant',
      parentID: M.user,
      mode: 'build',
      agent: 'build',
      path: { cwd: dir, root: dir },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: 'claude-opus-5.5',
      providerID: 'github-copilot',
      time: { created: t(30) },
    },
  })
  fixture.addPart({
    id: P.bashRunning,
    messageId: M.asstLive,
    sessionId: FLEET.root,
    created: t(10),
    updated: t(2),
    data: {
      type: 'tool',
      callID: 'call_bash2',
      tool: 'bash',
      state: {
        status: 'running',
        input: { command: 'npm test', description: 'Run tests' },
        metadata: { output: 'PASS src/a.test.ts\n', description: 'Run tests' },
        time: { start: t(10) },
      },
    },
  })
  fixture.addPart({
    id: P.streamText,
    messageId: M.asstLive,
    sessionId: FLEET.root,
    created: t(5),
    updated: t(2),
    data: { type: 'text', text: 'Running the tests now', time: { start: t(5) } },
  })

  /* ---- child (done) ---- */
  const cdUser = 'msg_d00_user'
  fixture.addMessage({ id: cdUser, sessionId: FLEET.childDone, created: t(500), data: { role: 'user', time: { created: t(500) }, agent: 'sonnet-coder' } })
  fixture.addPart({ id: 'prt_d01_prompt', messageId: cdUser, sessionId: FLEET.childDone, created: t(500), data: { type: 'text', text: 'Check the DDL' } })
  fixture.addMessage({
    id: 'msg_d01_assistant',
    sessionId: FLEET.childDone,
    created: t(499),
    data: {
      role: 'assistant', parentID: cdUser, mode: 'sonnet-coder', agent: 'sonnet-coder', cost: 0.1,
      tokens: { total: 210, input: 10, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: 'claude-sonnet-5.5', providerID: 'github-copilot', time: { created: t(499), completed: t(300) }, finish: 'stop',
    },
  })
  fixture.addPart({
    id: 'prt_d00_step_start',
    messageId: 'msg_d01_assistant',
    sessionId: FLEET.childDone,
    created: t(499),
    data: { type: 'step-start', snapshot: 'snapd' },
  })
  fixture.addStepFinish({
    id: 'prt_d03_step_finish',
    messageId: 'msg_d01_assistant',
    sessionId: FLEET.childDone,
    created: t(300),
    tokens: { input: 10, output: 200 },
    cost: 0.1,
    reason: 'stop',
  })
  fixture.addPart({
    id: P.childDoneText,
    messageId: 'msg_d01_assistant',
    sessionId: FLEET.childDone,
    created: t(301),
    data: { type: 'text', text: 'Schema is fine.', time: { start: t(301), end: t(300) } },
  })

  /* ---- child (live) ---- */
  const clUser = 'msg_e00_user'
  fixture.addMessage({ id: clUser, sessionId: FLEET.childLive, created: t(60), data: { role: 'user', time: { created: t(60) }, agent: 'explore' } })
  fixture.addPart({ id: 'prt_e01_prompt', messageId: clUser, sessionId: FLEET.childLive, created: t(60), data: { type: 'text', text: 'Look around' } })
  fixture.addMessage({
    id: 'msg_e01_assistant',
    sessionId: FLEET.childLive,
    created: t(59),
    data: {
      role: 'assistant', parentID: clUser, mode: 'explore', agent: 'explore', cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: 'claude-opus-5.5', providerID: 'github-copilot', time: { created: t(59) },
    },
  })
  fixture.addPart({
    id: P.childLiveReasoning,
    messageId: 'msg_e01_assistant',
    sessionId: FLEET.childLive,
    created: t(4),
    updated: t(3),
    data: { type: 'reasoning', text: 'Let me look at the layout', time: { start: t(4) } },
  })

  /* ---- second root: pending question ---- */
  const rqUser = 'msg_f00_user'
  fixture.addMessage({ id: rqUser, sessionId: FLEET.rootQuestion, created: t(400), data: { role: 'user', time: { created: t(400) }, agent: 'plan' } })
  fixture.addPart({ id: 'prt_f01_prompt', messageId: rqUser, sessionId: FLEET.rootQuestion, created: t(400), data: { type: 'text', text: 'Which database should we use?' } })
  fixture.addMessage({
    id: 'msg_f01_assistant',
    sessionId: FLEET.rootQuestion,
    created: t(399),
    data: {
      role: 'assistant', parentID: rqUser, mode: 'plan', agent: 'plan', cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: 'claude-opus-5.5', providerID: 'github-copilot', time: { created: t(399) },
    },
  })
  fixture.addPart({
    id: P.questionTool,
    messageId: 'msg_f01_assistant',
    sessionId: FLEET.rootQuestion,
    created: t(20),
    updated: t(20),
    data: {
      type: 'tool',
      callID: 'call_q1',
      tool: 'question',
      state: {
        status: 'running',
        input: { questions: [{ question: 'Postgres or SQLite?', header: 'DB', options: [{ label: 'Postgres', description: '' }] }] },
        time: { start: t(20) },
      },
    },
  })

  /* ---- old root (outside any short window) ---- */
  const roUser = 'msg_g00_user'
  fixture.addMessage({ id: roUser, sessionId: FLEET.rootOld, created: t(3 * 86400 + 600), data: { role: 'user', time: { created: t(3 * 86400 + 600) }, agent: 'build' } })
  fixture.addPart({ id: 'prt_g01_prompt', messageId: roUser, sessionId: FLEET.rootOld, created: t(3 * 86400 + 600), data: { type: 'text', text: 'Do old work' } })
  fixture.addMessage({
    id: 'msg_g01_assistant',
    sessionId: FLEET.rootOld,
    created: t(3 * 86400 + 590),
    data: {
      role: 'assistant', parentID: roUser, mode: 'build', agent: 'build', cost: 0.2,
      tokens: { total: 10, input: 1, output: 9, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: 'claude-opus-5.5', providerID: 'github-copilot', time: { created: t(3 * 86400 + 590), completed: t(3 * 86400) }, finish: 'stop',
    },
  })
  fixture.addStepStart({ id: 'prt_g00_step_start', messageId: 'msg_g01_assistant', sessionId: FLEET.rootOld, created: t(3 * 86400 + 590) })
  fixture.addStepFinish({ id: 'prt_g03_step_finish', messageId: 'msg_g01_assistant', sessionId: FLEET.rootOld, created: t(3 * 86400), tokens: { input: 1, output: 9 }, cost: 0.2, reason: 'stop' })
  fixture.addPart({
    id: 'prt_g02_text',
    messageId: 'msg_g01_assistant',
    sessionId: FLEET.rootOld,
    created: t(3 * 86400 + 1),
    data: { type: 'text', text: 'Old work done.', time: { start: t(3 * 86400 + 1), end: t(3 * 86400) } },
  })

  fixture.setTodos(FLEET.root, [
    { content: 'Write adapter', status: 'in_progress', priority: 'high' },
    { content: 'Write tests', status: 'pending', priority: 'medium' },
  ], t(699))

  /* ---- events (only recent activity, like the real log) ---- */
  fixture.appendSessionEvent(FLEET.childLive, 'session.created.1')
  fixture.appendMessageEvent(M.asstLive)
  // streaming text: three coalescable updates of one part
  fixture.appendEvent({
    aggregateId: FLEET.root,
    type: 'message.part.updated.1',
    data: { sessionID: FLEET.root, part: { id: P.streamText, sessionID: FLEET.root, messageID: M.asstLive, type: 'text', text: 'Running', time: { start: t(5) } }, time: t(4) },
  })
  fixture.appendEvent({
    aggregateId: FLEET.root,
    type: 'message.part.updated.1',
    data: { sessionID: FLEET.root, part: { id: P.streamText, sessionID: FLEET.root, messageID: M.asstLive, type: 'text', text: 'Running the', time: { start: t(5) } }, time: t(3) },
  })
  fixture.appendPartEvent(P.streamText, t(2))
  fixture.appendPartEvent(P.bashRunning, t(2))
  fixture.appendPartEvent(P.taskLive, t(61))
  fixture.appendPartEvent(P.childLiveReasoning, t(3))
  fixture.appendPartEvent(P.questionTool, t(20))
  fixture.appendSessionEvent(FLEET.root, 'session.updated.1')
  return { eventRowid: fixture.maxEventRowid() }
}
