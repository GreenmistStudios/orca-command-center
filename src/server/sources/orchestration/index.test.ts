import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, SourceDeps } from '../../types.js'
import type { OrchestrationUpdate } from '../../types.js'
import {
  COORDINATOR_HANDLE, FAKE_TOKEN, RICH_RUN_ID, appendMessage, createOrchestrationFixture, execSql,
  type OrchestrationVariant,
} from '../../../../test/fixtures/orchestration.js'
import { TESTED_SCHEMA_VERSION, createOrchestrationSource } from './index.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'occ-orch-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const log = { debug() {}, info() {}, warn() {}, error() {} }
function deps(orchestrationDb: string | null): SourceDeps {
  return { config: { orchestrationDb } as Config, log, now: () => 1_700_000_000_000 }
}
async function open(variant: OrchestrationVariant) {
  const path = createOrchestrationFixture(dir, variant)
  const src = createOrchestrationSource(deps(path))
  const updates: OrchestrationUpdate[] = []
  src.subscribe((u) => updates.push(u))
  await src.start()
  return { path, src, updates }
}

describe('availability', () => {
  it('disabled when path is null', async () => {
    const src = createOrchestrationSource(deps(null))
    await src.start()
    expect(src.health().status).toBe('disabled')
    expect(src.summary().available).toBe(false)
  })
  it('missing when file does not exist', async () => {
    const src = createOrchestrationSource(deps(join(dir, 'nope.db')))
    await src.start()
    expect(src.health().status).toBe('missing')
    expect(src.summary().available).toBe(false)
  })
  it('error when tasks table is missing', async () => {
    const path = join(dir, 'x.db')
    const { DatabaseSync } = await import('node:sqlite')
    const w = new DatabaseSync(path)
    w.exec('CREATE TABLE other (id TEXT)')
    w.close()
    const src = createOrchestrationSource(deps(path))
    await src.start()
    expect(src.health().status).toBe('error')
    expect(src.summary().available).toBe(false)
    await src.stop()
  })
})

describe('current-machine', () => {
  it('shows one run with 3 ready tasks, legacy hidden', async () => {
    const { src, updates } = await open('current-machine')
    const s = src.summary()
    expect(s.available).toBe(true)
    expect(s.schemaVersion).toBe(43)
    expect(s.testedSchemaVersion).toBe(TESTED_SCHEMA_VERSION)
    expect(s.degraded).toEqual([])
    expect(s.runs).toHaveLength(1)
    const run = s.runs[0]!
    expect(run.id).toBe('run_c0ffee000001')
    expect(run.objective).toBe('Demo task board')
    expect(run.coordinatorHandle).toBe(COORDINATOR_HANDLE)
    expect(run.coordinatorSessionId).toBeNull()
    expect(run.taskCount).toBe(3)
    expect(run.statusCounts).toEqual({ ready: 3 })
    expect(run.dispatchCount).toBe(0)
    expect(run.messageCount).toBe(0)
    expect(run.hasBlockingGate).toBe(false)
    expect(run.createdAt).toBe(Date.parse('2026-10-20T13:49:11Z'))
    expect(run.lastActivityAt).toBe(Date.parse('2026-10-20T13:49:14Z'))
    const detail = src.getRun(run.id)!
    expect(detail.tasks.every((t) => t.deps.length === 0)).toBe(true)
    expect(src.health()).toMatchObject({ id: 'orca-orchestration', status: 'ok', version: 'v43', detail: '1 run · 3 tasks' })
    expect(updates).toHaveLength(1)
    expect(updates[0]!.changedRunIds).toEqual(['run_c0ffee000001'])
    expect(updates[0]!.newMessages).toEqual([])
    await src.stop()
  })
})

describe('rich', () => {
  it('derives runs, tasks, dispatches', async () => {
    const { src } = await open('rich')
    const d = src.getRun(RICH_RUN_ID)!
    expect(d.run.taskCount).toBe(6)
    expect(d.run.statusCounts).toEqual({ completed: 3, failed: 1, blocked: 1, pending: 1 })
    expect(d.run.dispatchCount).toBe(6)
    expect(d.run.messageCount).toBe(3) // heartbeats excluded
    expect(d.run.hasBlockingGate).toBe(true)
    expect(d.run.lastActivityAt).toBe(Date.parse('2026-10-21T09:27:00Z'))
    const byId = new Map(d.tasks.map((t) => [t.id, t]))
    expect(byId.get('task_r1')!.title).toBe('Design schema')
    expect(byId.get('task_r2')!.title).toBe('Research libs')
    expect(byId.get('task_r3')!.title).toBe('Spec for task_r3')
    expect(byId.get('task_r3')!.deps).toEqual(['task_r1', 'task_r2'])
    expect(byId.get('task_r6')!.deps).toEqual(['task_r3', 'task_r4', 'task_r5'])
    expect(byId.get('task_r5')!.specTruncated).toBe(true)
    expect(byId.get('task_r5')!.specPreview.length).toBeLessThanOrEqual(241)
    expect(byId.get('task_r4')!.attemptCount).toBe(2)
    expect(byId.get('task_r4')!.latestDispatchId).toBe('disp_4b')
    expect(byId.get('task_r1')!.resultPreview).toBe('Schema designed')
    const cb = d.dispatches.find((x) => x.id === 'disp_4b')!
    expect(cb).toMatchObject({ status: 'circuit_broken', failureCount: 3, workerState: 'failed', depth: 2, assigneeSessionId: null })
    expect(d.dispatches.find((x) => x.id === 'disp_5')!.workerState).toBe('ready')
    expect(d.dispatches.find((x) => x.id === 'disp_1')!.lastHeartbeatAt).toBe(Date.parse('2026-10-21T09:09:00Z'))
    expect(src.summary().runs.map((r) => r.id)).toEqual([RICH_RUN_ID])
    await src.stop()
  })

  it('messages: no heartbeats, taskId link, redaction', async () => {
    const { src } = await open('rich')
    const d = src.getRun(RICH_RUN_ID)!
    expect(d.messages.map((m) => m.id)).toEqual(['msg_done', 'msg_gate', 'msg_q'])
    const done = d.messages[0]!
    expect(done.taskId).toBe('task_r1')
    expect(done.type).toBe('worker_done')
    expect(done.bodyPreview).not.toContain(FAKE_TOKEN)
    expect(JSON.stringify(d)).not.toContain(FAKE_TOKEN)
    expect(src.getTask('task_r1')!.messages.map((m) => m.id)).toEqual(['msg_done'])
    await src.stop()
  })

  it('gates: union, blocking, task detail', async () => {
    const { src } = await open('rich')
    const gates = src.getRun(RICH_RUN_ID)!.gates
    expect(gates).toHaveLength(2)
    const g = gates.find((x) => x.id === 'msg_gate')!
    expect(g).toMatchObject({ taskId: 'task_r5', question: 'Which framework?', options: ['react', 'solid'], status: 'pending', blocking: true, resolution: null })
    const old = gates.find((x) => x.id === 'gate_old')!
    expect(old).toMatchObject({ status: 'resolved', resolution: 'yes', blocking: false })
    const td = src.getTask('task_r5')!
    expect(td.gates.map((x) => x.id)).toEqual(['msg_gate'])
    expect(td.spec.length).toBe(500)
    expect(src.getTask('task_r1')!.result).toBe('Schema designed')
    expect(src.getTask('nope')).toBeNull()
    expect(src.getRun('nope')).toBeNull()
    await src.stop()
  })

  it('redacts key-based payload secrets and token= in spec/result', async () => {
    const { path, src } = await open('rich')
    await src.stop()
    appendMessage(path, { id: 'msg_sec', subject: 'secret', type: 'decision_gate', payload: '{"taskId":"task_r5","question":"Pick? token=abcd1234secretvalue","options":["a"],"apiKey":"SUPERSECRETKEY123"}' })
    execSql(path, "UPDATE tasks SET spec='deploy with token=abcd1234secretvalue', result='password=hunter2hunter2' WHERE id='task_r5'")
    const s2 = createOrchestrationSource(deps(path))
    await s2.start()
    const out = JSON.stringify([s2.getRun(RICH_RUN_ID), s2.getTask('task_r5')])
    expect(out).not.toContain('SUPERSECRETKEY123')
    expect(out).not.toContain('abcd1234secretvalue')
    expect(out).not.toContain('hunter2hunter2')
    await s2.stop()
  })

  it('reply on thread resolves a message gate', async () => {
    const { path, src } = await open('rich')
    expect(src.getRun(RICH_RUN_ID)!.run.hasBlockingGate).toBe(true)
    appendMessage(path, { id: 'msg_reply', thread_id: 'msg_gate', body: 'use solid', created_at: '2026-10-21 09:40:00' })
    // force a poll
    vi.useFakeTimers()
    await src.stop()
    const src2 = createOrchestrationSource(deps(path))
    await src2.start()
    const g = src2.getRun(RICH_RUN_ID)!.gates.find((x) => x.id === 'msg_gate')!
    expect(g).toMatchObject({ status: 'resolved', resolution: 'use solid', blocking: false })
    expect(src2.getRun(RICH_RUN_ID)!.run.hasBlockingGate).toBe(false)
    await src2.stop()
  })

  it('unresolved non-pending gate on a blocked task is blocking', async () => {
    const { path, src } = await open('rich')
    await src.stop()
    execSql(path, "INSERT INTO decision_gates (id, run_id, task_id, question, status) VALUES ('g2','" + RICH_RUN_ID + "','task_r5','Timeout?','timeout')")
    const s2 = createOrchestrationSource(deps(path))
    await s2.start()
    expect(s2.getRun(RICH_RUN_ID)!.gates.find((g) => g.id === 'g2')!.blocking).toBe(true)
    execSql(path, "UPDATE tasks SET status='ready' WHERE id='task_r5'; DELETE FROM messages WHERE id='msg_gate'")
    await s2.stop()
    const s3 = createOrchestrationSource(deps(path))
    await s3.start()
    expect(s3.getRun(RICH_RUN_ID)!.gates.find((g) => g.id === 'g2')!.blocking).toBe(false)
    expect(s3.getRun(RICH_RUN_ID)!.run.hasBlockingGate).toBe(false)
    await s3.stop()
  })
})

describe('schema degradation', () => {
  it('old-schema: groups by coordinator terminal, no deps', async () => {
    const { src } = await open('old-schema')
    const s = src.summary()
    expect(s.schemaVersion).toBe(5)
    expect(s.degraded).toEqual(
      expect.arrayContaining([
        'Runs table unavailable — runs grouped by coordinator terminal.',
        'Dependencies unavailable — the DAG shows tasks without edges.',
        'Dispatch attempts unavailable.',
        'Messages unavailable — no conversation or message-based gates.',
      ]),
    )
    expect(s.runs).toHaveLength(1)
    expect(s.runs[0]).toMatchObject({ coordinatorHandle: 'term_old', taskCount: 2 })
    expect(src.getRun(s.runs[0]!.id)!.tasks.map((t) => t.title)).toEqual(['Old task one', 'Old task two'])
    expect(src.health().status).toBe('degraded')
    await src.stop()
  })
  it('newer-schema: degraded banner detail', async () => {
    const { src } = await open('newer-schema')
    expect(src.health().status).toBe('degraded')
    expect(src.health().detail).toContain('schema v44 is newer than tested v43')
    expect(src.summary().schemaVersion).toBe(44)
    expect(src.summary().runs).toHaveLength(1)
    await src.stop()
  })
  it('invalid deps JSON becomes [] and is counted', async () => {
    const path = createOrchestrationFixture(dir, 'current-machine')
    execSql(path, "UPDATE tasks SET deps='not json' WHERE id='task_cm1'")
    const src = createOrchestrationSource(deps(path))
    await src.start()
    expect(src.getTask('task_cm1')!.task.deps).toEqual([])
    expect(src.health().detail).toContain('1 task(s) with invalid deps JSON')
    await src.stop()
  })
})

describe('change detection', () => {
  it('emits once with newMessages and changed run; silent when unchanged', async () => {
    vi.useFakeTimers()
    const { path, src, updates } = await open('rich')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.newMessages).toEqual([])
    await vi.advanceTimersByTimeAsync(6000)
    expect(updates).toHaveLength(1)

    appendMessage(path, { id: 'msg_new', body: 'hello', type: 'status', created_at: '2026-10-21 10:00:00' })
    appendMessage(path, { id: 'msg_hb3', type: 'heartbeat', created_at: '2026-10-21 10:00:01' })
    await vi.advanceTimersByTimeAsync(2100)
    expect(updates).toHaveLength(2)
    expect(updates[1]!.changedRunIds).toEqual([RICH_RUN_ID])
    expect(updates[1]!.newMessages.map((m) => m.id)).toEqual(['msg_new'])
    expect(updates[1]!.summary.runs[0]!.messageCount).toBe(4)
    await vi.advanceTimersByTimeAsync(6000)
    expect(updates).toHaveLength(2)
    await src.stop()
  })

  it('detects a reset', async () => {
    vi.useFakeTimers()
    const { path, src, updates } = await open('rich')
    execSql(path, 'DELETE FROM messages; DELETE FROM tasks; DELETE FROM dispatch_contexts; DELETE FROM decision_gates')
    await vi.advanceTimersByTimeAsync(2100)
    expect(updates).toHaveLength(2)
    expect(updates[1]!.changedRunIds).toContain(RICH_RUN_ID)
    expect(updates[1]!.newMessages).toEqual([])
    expect(src.health().detail).toContain('orchestration state was reset')
    await src.stop()
  })

  it('unsubscribe stops delivery', async () => {
    vi.useFakeTimers()
    const { path, src } = await open('rich')
    const got: OrchestrationUpdate[] = []
    const off = src.subscribe((u) => got.push(u))
    off()
    appendMessage(path, { id: 'm_x', created_at: '2026-10-21 11:00:00' })
    await vi.advanceTimersByTimeAsync(2100)
    expect(got).toHaveLength(0)
    await src.stop()
  })
})
