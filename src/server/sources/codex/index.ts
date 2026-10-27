/**
 * Codex CLI adapter: `<codexHome>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (see
 * docs/data-sources.md §2c). Thread names come from `<codexHome>/session_index.jsonl` when present.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ActivityStatus } from '../../../shared/contract.js'
import type { HarnessSource, SourceDeps } from '../../types.js'
import type { ToolClassifier } from '../../lib/tool-classify.js'
import { createJsonlSource, type JsonlLayout, type JsonlRef, type JsonlSourceOptions } from '../jsonl/source.js'
import { TranscriptModel, isObj, num, parseMaybeJson, safe, str, textOf, type Obj, type ToolRec } from '../jsonl/model.js'

const CODEX_OPTS = { harness: 'codex', agent: 'codex', providerId: 'openai', source: 'codex.rollout', untitled: 'Codex session' } as const
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
const HIDDEN_ORIGINS = new Set(['internal', 'guardian_review', 'memory_consolidation'])

/** Parse a tool output that may be a JSON envelope `{output, metadata: {exit_code}}`. */
function toolOutput(raw: unknown): { text: string; exitCode: number | null; obj: Obj | null } {
  const parsed = parseMaybeJson(raw)
  if (isObj(parsed)) {
    const meta = isObj(parsed.metadata) ? parsed.metadata : null
    const text = typeof parsed.output === 'string' ? parsed.output : typeof parsed.content === 'string' ? parsed.content : Array.isArray(parsed.content) ? textOf(parsed.content) : JSON.stringify(parsed)
    return { text, exitCode: meta ? num(meta.exit_code) : num(parsed.exit_code), obj: parsed }
  }
  if (Array.isArray(parsed)) return { text: textOf(parsed), exitCode: null, obj: null }
  const text = typeof parsed === 'string' ? parsed : ''
  const m = /^(?:Exit code:|Process exited with code)\s*(-?\d+)/m.exec(text)
  return { text, exitCode: m ? Number(m[1]) : null, obj: null }
}

export class CodexModel extends TranscriptModel {
  private sawMeta = false
  private turnNo = 0
  private readonly approvals = new Map<string, string>()

  constructor(id: string, classifier: ToolClassifier) {
    super(id, classifier, CODEX_OPTS)
  }

  protected apply(l: Obj): void {
    const type = str(l.type)
    const p = isObj(l.payload) ? l.payload : null
    if (!type || !p) return
    const ts = this.stamp(l.timestamp)
    switch (type) {
      case 'session_meta':
        return this.meta(p)
      case 'turn_context': {
        this.cwd = str(p.cwd) ?? this.cwd
        this.modelId = str(p.model) ?? this.modelId
        const effort = str(p.effort) ?? str(p.reasoning_effort)
        if (effort) this.facts.set('Reasoning effort', effort)
        const approval = str(p.approval_policy)
        if (approval) this.facts.set('Approval policy', approval)
        return
      }
      case 'event_msg':
        return this.event(p, ts)
      case 'response_item':
        return this.item(p, ts)
      case 'compacted':
        this.facts.set('Compacted', 'yes')
        return
    }
  }

  private meta(p: Obj): void {
    if (this.sawMeta) return
    this.sawMeta = true
    this.cwd = str(p.cwd) ?? this.cwd
    const v = str(p.cli_version)
    if (v) {
      this.version = v
      this.facts.set('Codex version', v)
    }
    const originator = str(p.originator)
    if (originator) this.facts.set('Originator', originator)
    const provider = str(p.model_provider)
    if (provider) this.providerId = provider
    const created = str(p.timestamp)
    if (created) this.createdAtHint = Date.parse(created) || null
    const title = str(p.title) ?? str(p.thread_name) ?? str(p.threadName)
    if (title) this.title = title
    const git = isObj(p.git) ? p.git : null
    const branch = git ? str(git.branch) : null
    if (branch) this.facts.set('Branch', branch)
    const threadSource = (str(p.thread_source) ?? str(p.threadSource))?.toLowerCase() ?? null
    const src = p.source
    let kind: string | null = null
    let content: unknown = undefined
    if (typeof src === 'string') kind = src
    else if (isObj(src)) {
      const keys = Object.keys(src)
      if (keys.length === 1) {
        kind = keys[0]!
        content = src[kind]
      }
    }
    if (kind && !['subagent', 'internal'].includes(kind)) this.facts.set('Source', kind)
    if (kind === 'subagent' || kind === 'internal' || (threadSource && threadSource !== 'user')) {
      // {subagent: {thread_spawn: {parent_thread_id, agent_role, agent_nickname, depth}}}
      let spawn: Obj | null = null
      let subKind: string | null = typeof content === 'string' ? content : null
      if (isObj(content)) {
        const k = Object.keys(content)
        if (k.length === 1) {
          subKind = k[0]!
          spawn = isObj(content[subKind]) ? (content[subKind] as Obj) : null
        }
      }
      const parent = (spawn && str(spawn.parent_thread_id)) ?? str(p.parent_thread_id)
      if (parent && parent !== this.id) {
        this.parentId = parent
        this.agent = (spawn && (str(spawn.agent_role) ?? str(spawn.agent_type) ?? str(spawn.agent_nickname))) ?? str(p.agent_role) ?? str(p.agent_nickname) ?? 'subagent'
        const nick = (spawn && str(spawn.agent_nickname)) ?? str(p.agent_nickname)
        if (nick) this.facts.set('Agent nickname', nick)
      } else if (kind === 'internal' || HIDDEN_ORIGINS.has(threadSource ?? '') || HIDDEN_ORIGINS.has(subKind ?? '') || kind === 'subagent') {
        // Review / compaction / memory threads without a parent are Codex internals.
        this.hidden = true
      }
    }
  }

  private turnKey(): string {
    if (!this.currentGroup) this.currentGroup = `turn:${++this.turnNo}`
    return this.currentGroup
  }

  private event(p: Obj, ts: number): void {
    const t = str(p.type)
    switch (t) {
      case 'task_started':
      case 'turn_started':
        this.turnState = 'working'
        this.currentGroup = `turn:${str(p.turn_id) ?? ++this.turnNo}`
        return
      case 'task_complete':
      case 'turn_complete':
        this.settleTools(ts)
        this.approvals.clear()
        this.completeGroup(this.currentGroup, ts, 'stop')
        this.turnState = 'done'
        this.steps++
        this.currentGroup = null
        return
      case 'turn_aborted': {
        this.settleTools(ts, false)
        this.approvals.clear()
        const reason = str(p.reason) ?? 'interrupted'
        this.addError(null, ts, 'Turn aborted', reason, { group: this.currentGroup })
        this.completeGroup(this.currentGroup, ts, 'aborted')
        this.turnState = 'done'
        this.currentGroup = null
        return
      }
      case 'user_message': {
        const text = str(p.message) ?? ''
        if (!text.trim()) return
        this.addPrompt(null, ts, text)
        this.turnState = 'working'
        return
      }
      case 'error': {
        this.addError(null, ts, 'Error', str(p.message) ?? 'error', { group: this.currentGroup })
        this.turnState = 'error'
        return
      }
      case 'token_count': {
        const info = isObj(p.info) ? p.info : null
        const tot = info && isObj(info.total_token_usage) ? info.total_token_usage : null
        if (!tot) return
        const input = num(tot.input_tokens) ?? 0
        const cached = num(tot.cached_input_tokens) ?? 0
        const output = num(tot.output_tokens) ?? 0
        const reasoning = num(tot.reasoning_output_tokens) ?? 0
        this.tokens = { input: Math.max(0, input - cached), output: Math.max(0, output - reasoning), reasoning, cacheRead: cached, cacheWrite: 0 }
        return
      }
      case 'exec_approval_request':
      case 'apply_patch_approval_request': {
        const callId = str(p.call_id) ?? `approval${this.seq}`
        const cmd = Array.isArray(p.command) ? p.command.filter((x): x is string => typeof x === 'string').join(' ') : (str(p.reason) ?? 'patch')
        this.approvals.set(callId, cmd)
        return
      }
      case 'exec_command_begin':
      case 'patch_apply_begin': {
        const callId = str(p.call_id)
        if (callId) this.approvals.delete(callId)
        return
      }
    }
  }

  private item(p: Obj, ts: number): void {
    const t = str(p.type)
    switch (t) {
      case 'message': {
        if (str(p.role) !== 'assistant') return // user/developer items duplicate event_msg or are injected context
        this.addText(str(p.id), ts, textOf(p.content), { group: this.turnKey(), model: this.modelId })
        return
      }
      case 'reasoning': {
        // Only the readable summary; `encrypted_content` is opaque and never read.
        const text = Array.isArray(p.summary) ? textOf(p.summary) : ''
        this.addThinking(str(p.id), ts, text, { group: this.turnKey(), model: this.modelId })
        return
      }
      case 'function_call':
      case 'custom_tool_call': {
        const callId = str(p.call_id) ?? str(p.id) ?? `call${this.seq}`
        const name = str(p.name) ?? 'tool'
        const args = t === 'function_call' ? parseMaybeJson(p.arguments) : p.input
        this.startTool({ callId, name, args, ts, group: this.turnKey(), model: this.modelId })
        this.approvals.delete(callId)
        return
      }
      case 'local_shell_call': {
        const callId = str(p.call_id) ?? str(p.id) ?? `call${this.seq}`
        this.startTool({ callId, name: 'local_shell', args: isObj(p.action) ? p.action : {}, ts, group: this.turnKey(), model: this.modelId })
        return
      }
      case 'web_search_call': {
        const callId = str(p.id) ?? `ws${this.seq}`
        const action = isObj(p.action) ? p.action : {}
        this.startTool({ callId, name: 'web_search', args: action, ts, group: this.turnKey(), model: this.modelId })
        if (str(p.status) !== 'in_progress') this.endTool({ callId, ts, ok: str(p.status) !== 'failed', output: str(action.query) ?? '' })
        return
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = str(p.call_id)
        if (!callId) return
        const out = toolOutput(p.output)
        const rec = this.tools.get(callId)
        const failed = (out.exitCode !== null && out.exitCode !== 0) || (out.obj !== null && out.obj.success === false)
        this.endTool({ callId, ts, ok: !failed, output: out.text, error: failed ? safe(out.text || `exit code ${out.exitCode}`, 400) : null })
        if (rec && rec.ev.kind === 'subagent') {
          const agentId = (out.obj && (str(out.obj.agent_id) ?? str(out.obj.thread_id) ?? str(out.obj.id))) ?? UUID_RE.exec(out.text)?.[1] ?? null
          if (agentId) rec.childId = agentId
        }
        return
      }
    }
  }

  override state() {
    if (this.approvals.size) return 'waiting' as const
    return super.state()
  }

  /** `spawn_agent` returns at once; the child's own transcript says whether it is still running. */
  override spawnStatus(_rec: ToolRec, child: TranscriptModel): ActivityStatus {
    const s = child.state()
    return s === 'working' || s === 'waiting' ? 'running' : s === 'error' ? 'error' : 'completed'
  }
}

export interface CodexSourceOptions extends JsonlSourceOptions {}

export function codexLayout(codexDir: string | null): JsonlLayout {
  const root = codexDir ? path.join(codexDir, 'sessions') : null
  const indexFile = codexDir ? path.join(codexDir, 'session_index.jsonl') : null
  let indexSig = ''
  let titles = new Map<string, string>()
  const readIndex = () => {
    if (!indexFile) return
    try {
      const st = statSync(indexFile)
      const sig = `${st.size}:${st.mtimeMs}`
      if (sig === indexSig || st.size > 8 * 1024 * 1024) return
      indexSig = sig
      const next = new Map<string, string>()
      for (const line of readFileSync(indexFile, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const o: unknown = JSON.parse(line)
          if (isObj(o) && str(o.id) && str(o.thread_name)) next.set(str(o.id)!, str(o.thread_name)!)
        } catch {
          /* skip */
        }
      }
      titles = next
    } catch {
      /* optional */
    }
  }
  return {
    id: 'codex',
    harness: 'codex',
    label: 'Codex',
    root,
    disabledDetail: 'Codex home not configured',
    missingDetail: 'sessions directory not found',
    discover(ls) {
      const out: JsonlRef[] = []
      if (!root) return out
      readIndex()
      for (const y of ls(root) ?? []) {
        if (!y.isDir || !/^\d{4}$/.test(y.name)) continue
        for (const m of ls(path.join(root, y.name)) ?? []) {
          if (!m.isDir) continue
          for (const d of ls(path.join(root, y.name, m.name)) ?? []) {
            if (!d.isDir) continue
            const dir = path.join(root, y.name, m.name, d.name)
            for (const f of ls(dir) ?? []) {
              if (!f.isFile || !/^rollout-.*\.jsonl$/.test(f.name)) continue
              const id = UUID_RE.exec(f.name)?.[1] ?? f.name.slice(0, -'.jsonl'.length)
              out.push({ id, file: path.join(dir, f.name), parentId: null })
            }
          }
        }
      }
      return out
    },
    createModel(ref, classifier) {
      return new CodexModel(ref.id, classifier)
    },
    refresh(ref, model) {
      const t = titles.get(ref.id)
      if (t && t !== model.title) {
        model.title = t
        return true
      }
      return false
    },
  }
}

export function createCodexSource(deps: SourceDeps, options: CodexSourceOptions = {}): HarnessSource {
  return createJsonlSource(deps, codexLayout(deps.config.codexDir ?? null), options)
}
