import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BootstrapPayload, FileChange, SessionSummary, SessionTree } from '../../src/shared/contract.js'
import { SECRET, claudeLines, codexFile, codexLines, cursorLines, writeJsonl } from '../fixtures/jsonl-harnesses.js'
import { createEnv, hookEntry, type Env } from './env.js'

const CLAUDE = 'c1a0de00-0000-4000-8000-000000000001'
const CODEX = '0199c0de-0000-7000-8000-000000000002'
const CURSOR = 'c0050200-0000-4000-8000-000000000003'
const CWD = '/work/acme/feature-x'

const byId = (b: BootstrapPayload, id: string): SessionSummary => {
  const s = b.sessions.find((x) => x.id === id)
  if (!s) throw new Error(`session ${id} not in bootstrap`)
  return s
}

describe('claude code, codex and cursor through the store', () => {
  let env: Env
  let dir: string
  beforeAll(async () => {
    const now = Date.now()
    dir = mkdtempSync(path.join(tmpdir(), 'occ-jsonl-'))
    const claudeDir = path.join(dir, 'claude')
    const codexDir = path.join(dir, 'codex')
    const cursorDir = path.join(dir, 'cursor')

    const C = claudeLines(CLAUDE, CWD, now - 20_000)
    writeJsonl(path.join(claudeDir, 'projects', '-work-acme-feature-x', `${CLAUDE}.jsonl`), [
      C.user('Refactor the auth module'),
      C.assistant('m1', [{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'Map callers', prompt: 'List every caller of auth()', subagent_type: 'Explore' } }], { stop: 'tool_use' }),
      C.assistant('m2', [{ type: 'tool_use', id: 'edit1', name: 'Edit', input: { file_path: `${CWD}/src/auth.ts`, old_string: `const t = "${SECRET}"`, new_string: 'const t = env.TOKEN' } }], { stop: 'tool_use' }),
      C.toolResult('edit1', 'ok'),
    ])
    const S = claudeLines(CLAUDE, CWD, now - 15_000)
    writeJsonl(path.join(claudeDir, 'projects', '-work-acme-feature-x', CLAUDE, 'subagents', 'agent-x1.jsonl'), [
      { ...S.user('List every caller of auth()'), isSidechain: true },
      { ...S.assistant('s1', [{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'auth(' } }], { stop: 'tool_use' }), isSidechain: true },
    ])

    const X = codexLines(now - 10_000)
    writeJsonl(codexFile(codexDir, CODEX, now - 10_000), [
      X.meta(CODEX, '/repo/other'),
      X.turnContext('/repo/other'),
      X.event('task_started', {}),
      X.event('user_message', { message: 'Bump deps' }),
      X.item('message', { role: 'assistant', content: [{ type: 'output_text', text: 'Bumped.' }] }),
      X.event('task_complete', {}),
    ])

    const U = cursorLines()
    writeJsonl(path.join(cursorDir, 'projects', 'repo-cursor', 'agent-transcripts', `${CURSOR}.jsonl`), [U.user('Explain the build'), U.assistant([{ type: 'text', text: 'It uses Vite.' }])])
    mkdirSync(path.join(cursorDir, 'chats', 'h1', CURSOR), { recursive: true })
    writeFileSync(path.join(cursorDir, 'chats', 'h1', CURSOR, 'meta.json'), JSON.stringify({ title: 'Build questions', cwd: '/repo/cursor' }))

    env = await createEnv({
      now,
      opencode: false,
      copilot: false,
      hooks: [
        hookEntry({
          paneKey: 'tab-1:leaf-1',
          source: 'claude',
          agentPresence: { agent: 'claude' },
          providerSession: { key: 'session_id', id: CLAUDE },
          hookEventName: 'PermissionRequest',
          payload: { state: 'blocked', prompt: 'x', agentType: 'claude' },
          receivedAt: now + 1000,
          stateStartedAt: now + 1000,
        }),
      ],
      overrides: { claudeDir, codexDir, cursorDir },
    })
  })
  afterAll(async () => {
    await env?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists every harness with health, state and Orca joins', async () => {
    const b = await env.bootstrap()
    expect(b.meta.sources.filter((s) => ['claude', 'codex', 'cursor'].includes(s.id)).map((s) => [s.id, s.status])).toEqual([
      ['claude', 'ok'],
      ['codex', 'ok'],
      ['cursor', 'ok'],
    ])
    const claude = byId(b, CLAUDE)
    expect(claude).toMatchObject({ harness: 'claude', state: 'blocked', stateSource: 'orca-hook', orca: { paneKey: 'tab-1:leaf-1' } })
    expect(claude.workspace?.key).toBe('repo-1::/work/acme/feature-x')
    expect(claude.childIds).toEqual([`${CLAUDE}.agent-x1`])
    const child = byId(b, `${CLAUDE}.agent-x1`)
    expect(child).toMatchObject({ parentId: CLAUDE, rootId: CLAUDE, depth: 1, agent: 'Explore', stateSource: 'parent-tool' })
    expect(byId(b, CODEX)).toMatchObject({ harness: 'codex', state: 'done', title: 'Bump deps' })
    expect(byId(b, CURSOR)).toMatchObject({ harness: 'cursor', title: 'Build questions', directory: '/repo/cursor' })
    expect(b.stats.byHarness.map((h) => h.harness).sort()).toEqual(['claude', 'codex', 'cursor'])
    expect(JSON.stringify(b)).not.toContain(SECRET)
  })

  it('serves trees, harness filters, file changes and diffs', async () => {
    const tree = await env.get<SessionTree>(`/api/sessions/${CLAUDE}/tree`)
    expect(tree.nodes.map((n) => n.id).sort()).toEqual([CLAUDE, `${CLAUDE}.agent-x1`].sort())
    expect(tree.edges[0]).toMatchObject({ from: CLAUDE, to: `${CLAUDE}.agent-x1` })
    const list = await env.get<{ sessions: SessionSummary[] }>('/api/sessions?harness=cursor')
    expect(list.sessions.map((s) => s.id)).toEqual([CURSOR])
    const fc = await env.get<{ changes: FileChange[] }>(`/api/file-changes?sessionId=${CLAUDE}`)
    expect(fc.changes.map((c) => [c.relPath, c.kind])).toEqual([['src/auth.ts', 'edit']])
    const diff = await env.getText(`/api/file-changes/${encodeURIComponent(fc.changes[0]!.id)}/diff`)
    expect(diff).toContain('env.TOKEN')
    expect(diff).not.toContain(SECRET)
    const detail = await env.get<{ provenance: string[] }>(`/api/sessions/${CODEX}`)
    expect(detail.provenance[0]).toBe('codex sessions · rollout-*.jsonl')
  })
})
