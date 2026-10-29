/**
 * On-disk fixtures for the JSONL harnesses (Claude Code, Codex, Cursor), with realistic line
 * shapes (docs/data-sources.md §2b–2d). Every builder returns plain objects; `write*`/`append*`
 * serialize them as JSONL.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Config, HarnessSource, HarnessUpdate, SourceDeps } from '../../src/server/types.js'

export const SECRET = 'ghp_' + 'FAKEsecretInsideCommand0123456789ABCDEF'
export const OPAQUE = 'OPAQUE-SIGNATURE-SENTINEL'
export const ENCRYPTED = 'ENCRYPTED-REASONING-SENTINEL'

type Line = Record<string, unknown>

export function writeJsonl(file: string, lines: Line[]): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''))
  return file
}

export function appendJsonl(file: string, lines: Line[]): void {
  appendFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''))
}

const iso = (ms: number) => new Date(ms).toISOString()

/* ───────────────────────────── Claude Code ───────────────────────────── */

export function claudeLines(sessionId: string, cwd: string, t0: number) {
  let t = t0
  let n = 0
  const common = () => ({ sessionId, cwd, version: '2.0.30', gitBranch: 'main', userType: 'external', isSidechain: false, timestamp: iso((t += 1000)), uuid: `u${++n}` })
  return {
    now: () => t,
    user: (content: unknown, extra: Line = {}): Line => ({ ...common(), type: 'user', message: { role: 'user', content }, ...extra }),
    toolResult: (toolUseId: string, content: unknown, extra: Line = {}, isError = false): Line => ({
      ...common(),
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
      ...extra,
    }),
    assistant: (msgId: string, content: Line[], o: { stop?: string | null; usage?: Line; model?: string } = {}): Line => ({
      ...common(),
      type: 'assistant',
      requestId: `req_${msgId}`,
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: o.model ?? 'claude-sonnet-4-5-20250929',
        content,
        stop_reason: o.stop === undefined ? null : o.stop,
        usage: o.usage ?? { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
      },
    }),
    raw: (l: Line): Line => ({ ...common(), ...l }),
  }
}

/* ──────────────────────────────── Codex ──────────────────────────────── */

export function codexLines(t0: number) {
  let t = t0
  const at = () => iso((t += 1000))
  const line = (type: string, payload: Line): Line => ({ timestamp: at(), type, payload })
  return {
    now: () => t,
    meta: (id: string, cwd: string, extra: Line = {}): Line =>
      line('session_meta', { id, timestamp: iso(t0), cwd, originator: 'codex_cli_rs', cli_version: '0.46.0', instructions: null, source: 'cli', model_provider: 'openai', git: { branch: 'feat/x', commit_hash: 'abc' }, ...extra }),
    turnContext: (cwd: string, model = 'gpt-5-codex'): Line => line('turn_context', { cwd, approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model, effort: 'medium', summary: 'auto' }),
    event: (type: string, extra: Line = {}): Line => line('event_msg', { type, ...extra }),
    item: (type: string, extra: Line = {}): Line => line('response_item', { type, ...extra }),
  }
}

export function codexFile(home: string, id: string, t0: number): string {
  const d = new Date(t0)
  const y = String(d.getFullYear())
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const stamp = d.toISOString().slice(0, 19).replace(/:/g, '-')
  return path.join(home, 'sessions', y, m, day, `rollout-${stamp}-${id}.jsonl`)
}

/* ──────────────────────────────── Cursor ─────────────────────────────── */

export function cursorLines() {
  return {
    user: (text: string): Line => ({ role: 'user', message: { content: [{ type: 'text', text: `<user_info>OS: darwin</user_info>\n<user_query>\n${text}\n</user_query>` }] } }),
    assistant: (content: Line[]): Line => ({ role: 'assistant', message: { content } }),
    toolResult: (id: string, content: string, isError = false): Line => ({ role: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } }),
  }
}

/* ───────────────────────────── test harness ──────────────────────────── */


export interface Made {
  src: HarnessSource
  updates: HarnessUpdate[]
}

/** Build a source with a quiet logger, a 30-day window and a fast poll. Remember to stop it. */
export function makeSource(create: (deps: SourceDeps, o: { pollMs: number }) => HarnessSource, config: Partial<Config>): Made {
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  const deps: SourceDeps = { config: { windowMs: 30 * 86_400_000, mcpServers: [], ...config } as Config, log, now: () => Date.now() }
  const src = create(deps, { pollMs: 25 })
  const updates: HarnessUpdate[] = []
  src.subscribe((u) => updates.push(u))
  return { src, updates }
}

export async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const t = Date.now()
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 15))
  }
}
