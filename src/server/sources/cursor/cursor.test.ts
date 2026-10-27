import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HarnessSource } from '../../types.js'
import { SECRET, appendJsonl, cursorLines, makeSource, until, writeJsonl, type Made } from '../../../../test/fixtures/jsonl-harnesses.js'
import { cleanCursorPrompt, createCursorSource, decodeCursorSlug } from './index.js'

let tmp: string
const made: HarnessSource[] = []
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cursor-'))
})
afterEach(async () => {
  for (const s of made.splice(0)) await s.stop()
  rmSync(tmp, { recursive: true, force: true })
})

const CHAT = 'a3c1e2f4-1111-4222-8333-444455556666'
const FLAT = 'b3c1e2f4-1111-4222-8333-444455556666'

function make(): Made {
  const m = makeSource(createCursorSource, { cursorDir: tmp })
  made.push(m.src)
  return m
}

describe('cursor helpers', () => {
  it('extracts the user query', () => {
    expect(cleanCursorPrompt('<user_info>x</user_info>\n<user_query>\nFix it\n</user_query>')).toBe('Fix it')
    expect(cleanCursorPrompt('<user_info>only context</user_info>')).toBeNull()
    expect(cleanCursorPrompt('plain')).toBe('plain')
  })

  it('decodes project slugs by probing the filesystem', () => {
    const dirs = new Set(['/Users', '/Users/me', '/Users/me/my-app', '/Users/me/my-app/web.client'])
    expect(decodeCursorSlug('Users-me-my-app-web-client', (p) => dirs.has(p))).toBe('/Users/me/my-app/web.client')
    expect(decodeCursorSlug('Nope-here', () => false)).toBeNull()
  })
})

describe('cursor source', () => {
  it('reads nested and flat transcripts, meta.json, tools and state', async () => {
    const C = cursorLines()
    const proj = path.join(tmp, 'projects', 'Users-me-app', 'agent-transcripts')
    const file = writeJsonl(path.join(proj, CHAT, `${CHAT}.jsonl`), [
      C.user('Rename the helper'),
      C.assistant([
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'tu1', name: 'Shell', input: { command: `TOKEN=${SECRET} rg helper` } },
      ]),
      C.toolResult('tu1', 'src/a.ts: helper()'),
      C.assistant([{ type: 'tool_use', name: 'StrReplace', input: { path: '/Users/me/app/src/a.ts', old_string: 'helper', new_string: 'util' } }]),
      C.assistant([{ type: 'text', text: 'Renamed.' }]),
    ])
    writeJsonl(path.join(proj, `${FLAT}.jsonl`), [C.user('Second chat')])
    const meta = path.join(tmp, 'chats', 'f00d', CHAT)
    mkdirSync(meta, { recursive: true })
    writeFileSync(path.join(meta, 'meta.json'), JSON.stringify({ title: 'Rename helper', cwd: '/Users/me/app', createdAtMs: 1_790_000_000_000 }))

    const { src } = make()
    await src.start()
    expect(src.health()).toMatchObject({ id: 'cursor', status: 'ok' })
    expect(src.listSessions(0).map((s) => s.id).sort()).toEqual([CHAT, FLAT].sort())
    const s = src.getSession(CHAT)!
    expect(s).toMatchObject({ harness: 'cursor', title: 'Rename helper', directory: '/Users/me/app', createdAt: 1_790_000_000_000, transcriptState: 'done', lastPrompt: 'Rename the helper', lastMessage: 'Renamed.' })
    expect(src.getSession(FLAT)).toMatchObject({ title: 'Second chat', transcriptState: 'working' })

    const events = src.getActivity([CHAT], { limit: 50 }).events
    expect(events.map((e) => e.kind)).toEqual(['prompt', 'text', 'tool', 'file-change', 'text'])
    // the StrReplace call had no result; the text-only reply settles it
    expect(events.find((e) => e.kind === 'file-change')).toMatchObject({ status: 'completed', tool: { category: 'edit' } })
    expect(JSON.stringify([events, events.map((e) => src.getPart(e.id))])).not.toContain(SECRET)
    const [change] = src.getFileChanges([CHAT])
    expect(change).toMatchObject({ relPath: 'src/a.ts', kind: 'edit', additions: 1, deletions: 1 })
    expect(src.getDiff(change!.id)?.text).toContain('+util')

    appendJsonl(file, [C.user('Now add tests'), C.assistant([{ type: 'tool_use', id: 'tu9', name: 'Write', input: { path: '/Users/me/app/src/a.test.ts', contents: 'test()' } }])])
    await until(() => src.getSession(CHAT)?.transcriptState === 'working')
    expect(src.getSession(CHAT)?.current).toMatchObject({ label: 'Write' })
  })
})
