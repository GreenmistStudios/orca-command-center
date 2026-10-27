import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HarnessSource } from '../../types.js'
import { ENCRYPTED, SECRET, appendJsonl, codexFile, codexLines, makeSource, until, writeJsonl, type Made } from '../../../../test/fixtures/jsonl-harnesses.js'
import { createCodexSource } from './index.js'

let tmp: string
const made: HarnessSource[] = []
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'codex-'))
})
afterEach(async () => {
  for (const s of made.splice(0)) await s.stop()
  rmSync(tmp, { recursive: true, force: true })
})

const CWD = '/Users/me/src/api'
const ROOT = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const CHILD = '0199a1b2-c3d4-7e5f-8a9b-ffffffffffff'
const INTERNAL = '0199a1b2-c3d4-7e5f-8a9b-111111111111'

function make(): Made {
  const m = makeSource(createCodexSource, { codexDir: tmp })
  made.push(m.src)
  return m
}

const PATCH = ['*** Begin Patch', '*** Update File: src/server.ts', '@@', '-old', '+new', '+more', '*** Add File: src/util.ts', '+export {}', '*** End Patch'].join('\n')

function seedRoot(t0: number) {
  const L = codexLines(t0)
  const file = writeJsonl(codexFile(tmp, ROOT, t0), [
    L.meta(ROOT, CWD),
    L.turnContext(CWD),
    L.event('task_started', { model_context_window: 272000 }),
    L.item('message', { role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }),
    L.event('user_message', { message: 'Fix the flaky server test', images: [] }),
    L.item('reasoning', { summary: [{ type: 'summary_text', text: '**Inspecting tests**' }], encrypted_content: ENCRYPTED }),
    L.item('function_call', { name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', `GH_TOKEN=${SECRET} npm test`], workdir: CWD }), call_id: 'call_1' }),
    L.item('function_call_output', { call_id: 'call_1', output: JSON.stringify({ output: 'FAIL server.test.ts', metadata: { exit_code: 1, duration_seconds: 1.2 } }) }),
    L.item('custom_tool_call', { name: 'apply_patch', input: PATCH, call_id: 'call_2', status: 'completed' }),
    L.item('custom_tool_call_output', { call_id: 'call_2', output: JSON.stringify({ output: 'Success. Updated the following files:\nM src/server.ts', metadata: { exit_code: 0 } }) }),
    L.item('function_call', { name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Fix test', status: 'completed' }, { step: 'Run CI', status: 'in_progress' }] }), call_id: 'call_3' }),
    L.item('function_call_output', { call_id: 'call_3', output: 'Plan updated' }),
    L.item('function_call', { name: 'mcp__linear__get_issue', arguments: '{"id":"ENG-1"}', call_id: 'call_4' }),
    L.item('function_call_output', { call_id: 'call_4', output: '{"content":[{"type":"text","text":"ENG-1"}],"success":true}' }),
    L.item('function_call', { name: 'spawn_agent', arguments: JSON.stringify({ message: 'Review the patch for races', agent_type: 'reviewer' }), call_id: 'call_5' }),
    L.item('function_call_output', { call_id: 'call_5', output: JSON.stringify({ agent_id: CHILD }) }),
    L.item('message', { role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the race in src/server.ts.' }] }),
    L.event('agent_message', { message: 'Fixed the race in src/server.ts.' }),
    L.event('token_count', { info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 1300 } } }),
    L.event('task_complete', { last_agent_message: 'Fixed' }),
  ])
  return { L, file }
}

function seedChild(t0: number) {
  const L = codexLines(t0)
  return writeJsonl(codexFile(tmp, CHILD, t0), [
    L.meta(CHILD, CWD, { source: { subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 1, agent_nickname: 'Robin', agent_role: 'reviewer' } } } }),
    L.event('task_started', {}),
    L.event('user_message', { message: 'Review the patch for races' }),
    L.item('function_call', { name: 'exec_command', arguments: JSON.stringify({ cmd: 'git diff' }), call_id: 'c1' }),
  ])
}

describe('codex source', () => {
  it('derives a finished session from a rollout', async () => {
    seedRoot(Date.now() - 60_000)
    const { src } = make()
    await src.start()
    expect(src.health()).toMatchObject({ id: 'codex', status: 'ok', version: '0.46.0' })
    const s = src.getSession(ROOT)!
    expect(s).toMatchObject({
      harness: 'codex',
      parentId: null,
      title: 'Fix the flaky server test',
      agent: 'codex',
      model: { providerId: 'openai', modelId: 'gpt-5-codex' },
      directory: CWD,
      transcriptState: 'done',
      lastMessage: 'Fixed the race in src/server.ts.',
      tokens: { input: 600, output: 200, reasoning: 100, cacheRead: 400, cacheWrite: 0 },
    })
    expect(s.facts).toEqual(expect.arrayContaining([{ label: 'Branch', value: 'feat/x' }, { label: 'Reasoning effort', value: 'medium' }]))
    const events = src.getActivity([ROOT], { limit: 100 }).events
    // one prompt (injected environment context is not a prompt), one assistant text (no duplicate)
    expect(events.filter((e) => e.kind === 'prompt')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'text')).toHaveLength(1)
    expect(events.find((e) => e.tool?.name === 'shell')).toMatchObject({ status: 'error', tool: { input: expect.stringContaining('npm test') } })
    expect(events.find((e) => e.tool?.name === 'mcp__linear__get_issue')).toMatchObject({ kind: 'mcp', status: 'completed', tool: { mcpServer: 'linear' } })
    expect(events.find((e) => e.kind === 'thinking')?.summary).toBe('**Inspecting tests**')
    const blob = JSON.stringify([events, events.map((e) => src.getPart(e.id)), src.getTranscript(ROOT, { limit: 50 })])
    expect(blob).not.toContain(SECRET)
    expect(blob).not.toContain(ENCRYPTED)
    expect(blob).not.toContain('environment_context')

    const changes = src.getFileChanges([ROOT])
    expect(changes.map((c) => [c.relPath, c.kind])).toEqual([
      ['src/server.ts', 'patch'],
      ['src/util.ts', 'patch'],
    ])
    expect(src.getDiff(changes[0]!.id)).toMatchObject({ format: 'patch-text', text: PATCH })
    expect(src.getTodos(ROOT).map((t) => [t.content, t.status])).toEqual([
      ['Fix test', 'completed'],
      ['Run CI', 'in_progress'],
    ])
  })

  it('links subagent threads; spawn status follows the child', async () => {
    const t0 = Date.now() - 30_000
    seedRoot(t0)
    const childFile = seedChild(t0 + 20_000)
    const { src } = make()
    await src.start()
    const child = src.getSession(CHILD)!
    expect(child).toMatchObject({ parentId: ROOT, agent: 'reviewer', transcriptState: 'working', spawn: { parentSessionId: ROOT, callId: 'call_5', status: 'running', subagentType: 'reviewer' } })
    expect(src.getChildren(ROOT).map((s) => s.id)).toEqual([CHILD])
    expect(src.getActivity([ROOT], { limit: 100 }).events.find((e) => e.kind === 'subagent')?.childSessionId).toBe(CHILD)
    const L = codexLines(Date.now())
    appendJsonl(childFile, [L.event('task_complete', {})])
    await until(() => src.getSession(CHILD)?.spawn?.status === 'completed')
  })

  it('hides internal threads, uses session_index titles, waits on approvals', async () => {
    const t0 = Date.now() - 10_000
    seedRoot(t0)
    const I = codexLines(t0)
    writeJsonl(codexFile(tmp, INTERNAL, t0), [I.meta(INTERNAL, CWD, { source: { subagent: 'review' } }), I.event('user_message', { message: 'internal' })])
    writeFileSync(path.join(tmp, 'session_index.jsonl'), JSON.stringify({ id: ROOT, thread_name: 'Flaky test fix', updated_at: new Date().toISOString() }) + '\n')
    const { src } = make()
    await src.start()
    expect(src.listSessions(0).map((s) => s.id)).toEqual([ROOT])
    expect(src.getSession(INTERNAL)).toBeNull()
    expect(src.getSession(ROOT)?.title).toBe('Flaky test fix')

    const L = codexLines(Date.now())
    const file = codexFile(tmp, ROOT, t0)
    appendJsonl(file, [L.event('task_started', {}), L.event('user_message', { message: 'deploy' }), L.event('exec_approval_request', { call_id: 'call_9', command: ['git', 'push'] })])
    await until(() => src.getSession(ROOT)?.transcriptState === 'waiting')
    appendJsonl(file, [L.event('exec_command_begin', { call_id: 'call_9', command: ['git', 'push'] })])
    await until(() => src.getSession(ROOT)?.transcriptState === 'working')
    appendJsonl(file, [L.event('turn_aborted', { reason: 'interrupted' })])
    await until(() => src.getSession(ROOT)?.transcriptState === 'done')
    expect(src.getActivity([ROOT], { limit: 200 }).events.some((e) => e.kind === 'error' && e.title.startsWith('Turn aborted'))).toBe(true)
  })
})
