/**
 * Harness-agnostic transcript model for append-only JSONL session logs (Claude Code, Codex,
 * Cursor). Subclasses parse their own line format in `apply()` and call the protected emitters;
 * this class owns normalization into contract types (activity, transcript, file changes, diffs,
 * counters, todos) and every redaction / truncation rule.
 */
import path from 'node:path'
import {
  LIMITS,
  type ActivityEvent,
  type ActivityKind,
  type ActivityStatus,
  type CurrentActivity,
  type FileChange,
  type FileChangeKind,
  type FileDiff,
  type Harness,
  type PartDetail,
  type SessionCounters,
  type SpawnInfo,
  type TodoItem,
  type TokenUsage,
  type ToolCallInfo,
  type ToolCategory,
  type TranscriptMessage,
} from '../../../shared/contract.js'
import type { HarnessSession } from '../../types.js'
import { redactText, redactValue } from '../../lib/redact.js'
import { clip, compactJson, extractLinks, oneLine, stripAnsi, truncate } from '../../lib/text.js'
import { parseTime } from '../../lib/time.js'
import type { ToolClassifier } from '../../lib/tool-classify.js'

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Redacted, ANSI-stripped, single-line, clipped. */
export const safe = (s: string, max: number): string => clip(oneLine(redactText(stripAnsi(s))), max)

/** Parse a JSON-encoded string argument (Codex function_call arguments); otherwise return as-is. */
export function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return v
  try {
    return JSON.parse(t)
  } catch {
    return v
  }
}

/** Plain text of a string or an Anthropic/OpenAI-style content block array (text blocks only). */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const b of content) {
    if (typeof b === 'string') out.push(b)
    else if (isObj(b)) {
      const t = str(b.type)
      if (t && !['text', 'input_text', 'output_text', 'summary_text'].includes(t)) continue
      const s = str(b.text)
      if (s) out.push(s)
    }
  }
  return out.join('\n')
}

export function patchFiles(patch: string): string[] {
  const out: string[] = []
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) out.push(m[1]!.trim())
  for (const m of patch.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) out.push(m[1]!.trim())
  if (out.length === 0) for (const m of patch.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) if (m[1] !== '/dev/null') out.push(m[1]!)
  return [...new Set(out)]
}

export function countPatch(patch: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const l of patch.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++
    else if (l.startsWith('-') && !l.startsWith('---')) del++
  }
  return { add, del }
}

const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'notebook_path', 'target_notebook', 'filename', 'relative_workspace_path']

function pathArg(args: unknown): string | null {
  if (!isObj(args)) return null
  for (const k of PATH_KEYS) {
    const v = str(args[k])
    if (v) return v
  }
  return null
}

/** Patch text carried by a tool argument (string, or `input` / `patch` / `patchText`). */
function patchArg(args: unknown): string | null {
  if (typeof args === 'string') return args.includes('*** Begin Patch') || /^(?:---|\+\+\+|@@) /m.test(args) ? args : null
  if (isObj(args)) {
    for (const k of ['input', 'patch', 'patchText', 'patch_text', 'diff']) {
      const v = str(args[k])
      if (v) return v
    }
    // Codex shell call: ["apply_patch", "*** Begin Patch …"]
    const cmd = args.command
    if (Array.isArray(cmd) && cmd.length >= 2 && cmd[0] === 'apply_patch' && typeof cmd[1] === 'string') return cmd[1]
  }
  return null
}

function shellCommand(args: unknown): string | null {
  if (typeof args === 'string') return args
  if (!isObj(args)) return null
  const c = args.command ?? args.cmd
  if (typeof c === 'string') return c
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    const parts = c as string[]
    // ["bash", "-lc", "<script>"] → the script
    if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]!) && /^-l?c$/.test(parts[1]!)) return parts[2]!
    return parts.join(' ')
  }
  return null
}

export interface ToolRec {
  callId: string
  name: string
  category: ToolCategory
  ev: ActivityEvent
  args: unknown
  linesAdded: number | null
  linesRemoved: number | null
  /** Diff captured from the tool result (e.g. Claude Code structuredPatch). */
  resultDiff: { format: FileDiff['format']; text: string } | null
  fileKind: FileChangeKind | null
  /** Subagent linkage hints: the child prompt and/or the child id the tool reported. */
  childPrompt: string | null
  childId: string | null
  subagentType: string | null
  description: string | null
}

interface Group {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: number
  completedAt: number | null
  model: string | null
  error: string | null
  finish: string | null
  tokens: TokenUsage | null
  items: string[]
}

export interface ModelOptions {
  harness: Harness
  /** Default agent name (e.g. "claude"); subagents override `agent`. */
  agent: string
  providerId: string | null
  /** Provenance tag on activity events, e.g. "claude.jsonl". */
  source: string
  /** Fallback session title. */
  untitled: string
}

export type TurnState = Extract<HarnessSession['transcriptState'], 'working' | 'done' | 'error' | 'unknown'>

const zeroTokens = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

export abstract class TranscriptModel {
  readonly events = new Map<string, ActivityEvent>()
  readonly details = new Map<string, PartDetail>()
  readonly tools = new Map<string, ToolRec>()
  readonly groups = new Map<string, Group>()
  /** Latest todo list (null = the session never wrote one). */
  todos: TodoItem[] | null = null
  todosDirty = false

  /* Tailing state (owned by the runtime). */
  fileMtimeMs = 0
  offset = 0
  size = 0
  truncatedHead = false
  /** Floor for lines without a timestamp (the runtime sets it from the file mtime before feeding). */
  fallbackTs = 0
  alive: boolean | null = null

  /* Session facts (set by subclasses). */
  cwd: string | null = null
  title: string | null = null
  firstPrompt: string | null = null
  /** Untruncated (but trimmed) first prompt, used to match subagent sessions to their spawning call. */
  firstPromptRaw: string | null = null
  lastPrompt: string | null = null
  lastMessage: string | null = null
  modelId: string | null = null
  providerId: string | null
  agent: string
  parentId: string | null = null
  spawn: SpawnInfo | null = null
  /** Internal sessions (e.g. Codex memory consolidation) are parsed but never listed. */
  hidden = false
  version: string | null = null
  tokens: TokenUsage = zeroTokens()
  cost = 0
  readonly facts = new Map<string, string>()
  turnState: TurnState = 'unknown'
  steps = 0
  createdAtHint: number | null = null

  protected seq = 0
  protected firstTs = 0
  protected lastTs = 0
  protected currentGroup: string | null = null
  private touched = new Set<string>()
  private readonly running = new Set<string>()

  constructor(
    readonly id: string,
    protected readonly classifier: ToolClassifier,
    readonly opts: ModelOptions,
  ) {
    this.agent = opts.agent
    this.providerId = opts.providerId
  }

  get harness(): Harness {
    return this.opts.harness
  }

  get lastActivity(): number {
    return this.lastTs
  }

  drain(): string[] {
    const out = [...this.touched]
    this.touched = new Set()
    return out
  }

  /** Feed one JSONL line. Malformed lines and unknown shapes are ignored. */
  ingest(line: string): void {
    if (!line.trim()) return
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      return
    }
    if (!isObj(e)) return
    this.seq++
    try {
      this.apply(e)
    } catch {
      /* a malformed line never breaks the session */
    }
  }

  protected abstract apply(line: Obj): void

  /** Resolve a line timestamp (falls back to the file mtime) and track first/last activity. */
  protected stamp(raw: unknown): number {
    let t = parseTime(raw)
    if (t === null) t = Math.max(this.fallbackTs, this.lastTs + 1)
    if (!this.firstTs || (t && t < this.firstTs)) this.firstTs = t
    if (t > this.lastTs) this.lastTs = t
    return t
  }

  /** Activity id: `<harness>:<sessionId>:<native>`; native defaults to the zero-padded line number. */
  protected eid(native?: string | null): string {
    return `${this.harness}:${this.id}:${native ?? `l${String(this.seq).padStart(7, '0')}`}`
  }

  protected rootId(): string {
    return this.parentId ?? this.id
  }

  /* ───────────────────────── emitters ───────────────────────── */

  protected beginGroup(key: string, role: Group['role'], ts: number, model: string | null = null): Group {
    let g = this.groups.get(key)
    if (!g) {
      g = { id: `${this.harness}:${this.id}:${key}`, role, createdAt: ts, completedAt: null, model, error: null, finish: null, tokens: null, items: [] }
      this.groups.set(key, g)
    }
    if (model) g.model = model
    return g
  }

  protected completeGroup(key: string | null, ts: number, finish: string | null, error?: string | null): void {
    const g = key ? this.groups.get(key) : undefined
    if (!g) return
    g.completedAt = ts
    if (error) g.error = safe(error, LIMITS.summaryChars)
    g.finish = g.error ? 'error' : finish
  }

  protected groupTokens(key: string, tokens: TokenUsage): void {
    const g = this.groups.get(key)
    if (g) g.tokens = tokens
  }

  private groupKey(key: string | null | undefined, fallbackId: string): { key: string; role: Group['role'] } {
    if (key) return { key, role: key.startsWith('user:') ? 'user' : key.startsWith('sys:') ? 'system' : 'assistant' }
    if (this.currentGroup) return { key: this.currentGroup, role: 'assistant' }
    return { key: `sys:${fallbackId}`, role: 'system' }
  }

  protected addPrompt(native: string | null, ts: number, text: string, opts: { group?: string; track?: boolean } = {}): string | null {
    if (!text.trim()) return null
    const clean = redactText(text)
    if (opts.track !== false) {
      if (!this.firstPrompt) {
        this.firstPrompt = safe(text, 80)
        this.firstPromptRaw = text.trim()
      }
      this.lastPrompt = safe(text, LIMITS.promptChars)
    }
    const id = this.eid(native)
    const key = opts.group ?? `user:${native ?? this.seq}`
    this.addEvent(
      this.base(id, ts, 'prompt', null, safe(text, LIMITS.titleChars) || 'Prompt', {
        summary: clip(clean, LIMITS.summaryChars),
        links: extractLinks(clean, LIMITS.linksPerEvent),
        messageId: key,
      }),
      { kind: 'prompt', title: 'Prompt', text: truncate(clean, LIMITS.partDetailBytes).text },
      { key, role: 'user', model: null },
    )
    return id
  }

  protected addText(native: string | null, ts: number, text: string, opts: { group?: string | null; model?: string | null } = {}): void {
    if (!text.trim()) return
    const clean = redactText(text)
    this.lastMessage = safe(text, LIMITS.summaryChars)
    const id = this.eid(native)
    const g = this.groupKey(opts.group, id)
    this.addEvent(
      this.base(id, ts, 'text', null, safe(text, LIMITS.titleChars), {
        summary: clip(clean, LIMITS.summaryChars),
        links: extractLinks(clean, LIMITS.linksPerEvent),
        messageId: g.key,
      }),
      { kind: 'text', title: 'Assistant', text: truncate(clean, LIMITS.partDetailBytes).text },
      { ...g, model: opts.model ?? null },
    )
  }

  protected addThinking(native: string | null, ts: number, text: string, opts: { group?: string | null; model?: string | null } = {}): void {
    if (!text.trim()) return
    const clean = redactText(text)
    const id = this.eid(native)
    const g = this.groupKey(opts.group, id)
    this.addEvent(
      this.base(id, ts, 'thinking', null, 'Thinking', { summary: clip(oneLine(clean), LIMITS.summaryChars), messageId: g.key }),
      { kind: 'thinking', title: 'Thinking', text: truncate(clean, LIMITS.partDetailBytes).text },
      { ...g, model: opts.model ?? null },
    )
  }

  protected addError(native: string | null, ts: number, title: string, message: string, opts: { group?: string | null } = {}): void {
    const id = this.eid(native)
    const g = this.groupKey(opts.group, id)
    const grp = this.groups.get(g.key)
    if (grp && g.role === 'assistant') grp.error = safe(message, LIMITS.summaryChars)
    this.addEvent(
      this.base(id, ts, 'error', 'error', safe(`${title}: ${message}`, LIMITS.titleChars), { summary: safe(message, LIMITS.summaryChars), messageId: g.key }),
      { kind: 'error', title, text: truncate(redactText(message), LIMITS.partDetailBytes).text, error: safe(message, LIMITS.summaryChars) },
      { ...g, model: null },
    )
  }

  /** Start (or re-announce) a tool call. `args` should already be JSON-decoded when possible. */
  protected startTool(o: { callId: string; name: string; args: unknown; ts: number; group?: string | null; model?: string | null }): ToolRec {
    const existing = this.tools.get(o.callId)
    if (existing) return existing
    this.classifier.observe(o.name)
    const cls = this.classifier.classify(this.harness, o.name)
    const files = this.argFiles(cls.category, o.args)
    const preview = this.inputPreview(cls.category, o.args)
    const kind: ActivityKind =
      cls.category === 'mcp'
        ? 'mcp'
        : cls.category === 'subagent'
          ? 'subagent'
          : cls.category === 'todo'
            ? 'todo'
            : ['edit', 'write', 'patch'].includes(cls.category)
              ? 'file-change'
              : 'tool'
    const tool: ToolCallInfo = {
      name: o.name,
      displayName: cls.displayName,
      category: cls.category,
      mcpServer: cls.mcpServer,
      callId: o.callId,
      input: preview.text,
      output: null,
      error: null,
      durationMs: null,
      truncated: preview.truncated,
    }
    const id = this.eid(`tool:${o.callId}`)
    const g = this.groupKey(o.group, id)
    const a = isObj(o.args) ? o.args : {}
    const subagentType = kind === 'subagent' ? (str(a.subagent_type) ?? str(a.agent_type) ?? str(a.agentType) ?? null) : null
    const description = kind === 'subagent' ? (str(a.description) ?? str(a.task) ?? null) : null
    const childPrompt = kind === 'subagent' ? (str(a.prompt) ?? str(a.message) ?? str(a.instructions) ?? null) : null
    const title =
      kind === 'subagent'
        ? clip(`${subagentType ?? cls.displayName} · ${oneLine(redactText(description ?? childPrompt ?? ''))}`.replace(/ · $/, ''), LIMITS.titleChars)
        : this.toolTitle(kind, cls.category, cls.displayName, o.name, tool.input, files)
    const ev = this.base(id, o.ts, kind, 'running', title, {
      tool,
      files,
      messageId: g.key,
      links: extractLinks(redactText(typeof o.args === 'string' ? o.args : compactJson(o.args, 4000)), LIMITS.linksPerEvent),
    })
    const rec: ToolRec = {
      callId: o.callId,
      name: o.name,
      category: cls.category,
      ev,
      args: o.args,
      linesAdded: null,
      linesRemoved: null,
      resultDiff: null,
      fileKind: /^delete/i.test(o.name) ? 'delete' : null,
      childPrompt: childPrompt ? childPrompt.trim() : null,
      childId: null,
      subagentType,
      description,
    }
    this.tools.set(o.callId, rec)
    this.running.add(o.callId)
    this.addEvent(
      ev,
      { kind, title: ev.title, text: null, input: this.boundedInput(o.args), metadata: { toolCallId: o.callId, toolName: o.name, model: o.model ?? null } },
      { ...g, model: o.model ?? null },
    )
    if (kind === 'todo') this.todosFromArgs(o.args)
    return rec
  }

  /** Finish a tool call. Unknown call ids are ignored. */
  protected endTool(o: { callId: string; ts: number; ok: boolean; output?: unknown; error?: string | null; inferred?: boolean }): ToolRec | null {
    const rec = this.tools.get(o.callId)
    if (!rec) return null
    this.running.delete(o.callId)
    const ev = rec.ev
    let full = ''
    const out = o.output
    if (typeof out === 'string') full = out
    else if (Array.isArray(out)) full = textOf(out) || compactJson(out, LIMITS.partDetailBytes)
    else if (out !== undefined && out !== null) full = compactJson(redactValue(out), LIMITS.partDetailBytes)
    const clean = redactText(stripAnsi(full))
    const preview = truncate(oneLine(clean), LIMITS.toolOutputChars)
    const error = o.ok ? null : safe(o.error ?? full ?? 'failed', LIMITS.summaryChars) || 'failed'
    ev.status = o.ok ? 'completed' : 'error'
    ev.endTs = o.ts
    ev.rev = Math.max(o.ts, ev.rev + 1)
    if (!o.inferred) {
      // A file read's content stays out of the stream (detail only).
      ev.summary = rec.category === 'read' ? null : preview.text || null
      ev.links = extractLinks(clean, LIMITS.linksPerEvent)
        .concat(ev.links)
        .filter((u, i, a) => a.indexOf(u) === i)
        .slice(0, LIMITS.linksPerEvent)
    }
    if (ev.tool) {
      if (!o.inferred) ev.tool.output = preview.text || null
      ev.tool.error = error
      ev.tool.durationMs = Math.max(0, o.ts - ev.ts)
      ev.tool.truncated = ev.tool.truncated || preview.truncated
    }
    const det = this.details.get(ev.id)
    if (det && !o.inferred) {
      const t = truncate(clean, LIMITS.partDetailBytes)
      det.output = t.text
      det.error = error
      det.truncated = t.truncated
      det.metadata = { ...(isObj(det.metadata) ? det.metadata : {}), success: o.ok, durationMs: ev.tool?.durationMs ?? null }
    } else if (det) det.error = error
    this.touched.add(ev.id)
    return rec
  }

  /** Close every running tool (turn ended without explicit results). */
  protected settleTools(ts: number, ok = true): void {
    for (const cid of [...this.running]) this.endTool({ callId: cid, ts, ok, error: ok ? null : 'interrupted', inferred: true })
  }

  protected hasRunningTools(): boolean {
    return this.running.size > 0
  }

  /** Mark an activity id as changed (the runtime uses this when it links a subagent). */
  touch(id: string): void {
    this.touched.add(id)
  }

  private todosFromArgs(args: unknown): void {
    const a = isObj(args) ? args : {}
    const list = Array.isArray(a.todos) ? a.todos : Array.isArray(a.plan) ? a.plan : Array.isArray(a.items) ? a.items : null
    if (!list) return
    const todos: TodoItem[] = []
    list.forEach((t, i) => {
      if (!isObj(t)) return
      const content = str(t.content) ?? str(t.step) ?? str(t.title) ?? str(t.text)
      if (!content) return
      todos.push({
        id: str(t.id) ?? String(i),
        content: safe(content, LIMITS.summaryChars),
        status: (str(t.status) ?? 'pending').toLowerCase().replace(/^todo_status_/, ''),
        priority: str(t.priority) ?? 'medium',
        position: i,
      })
    })
    this.todos = todos
    this.todosDirty = true
  }

  private toolTitle(kind: ActivityKind, category: ToolCategory, display: string, raw: string, input: string | null, files: string[]): string {
    if (kind === 'file-change' && files[0]) {
      const verb = /^delete/i.test(raw) ? 'Deleted' : category === 'write' ? 'Wrote' : category === 'patch' ? 'Patched' : 'Edited'
      return clip(`${verb} ${files[0]}${files.length > 1 ? ` (+${files.length - 1})` : ''}`, LIMITS.titleChars)
    }
    if (kind === 'todo') {
      return clip(input ? `${display} · ${oneLine(input)}` : display, LIMITS.titleChars)
    }
    return clip(input ? `${display} · ${oneLine(input)}` : display, LIMITS.titleChars)
  }

  private inputPreview(category: ToolCategory, args: unknown): { text: string | null; truncated: boolean } {
    let raw: string | null = null
    if (category === 'shell') raw = shellCommand(args)
    else if (category === 'todo' && isObj(args)) {
      const list = Array.isArray(args.todos) ? args.todos : Array.isArray(args.plan) ? args.plan : null
      raw = list ? `${list.length} todos` : null
    } else if (typeof args === 'string') raw = category === 'patch' ? `${patchFiles(args).length} files` : args
    else if (isObj(args)) {
      raw = str(args.pattern) ?? str(args.query) ?? pathArg(args) ?? str(args.url) ?? str(args.description) ?? str(args.skill) ?? str(args.command) ?? null
      if (raw === null && Object.keys(args).length) raw = compactJson(redactValue(args), 4000)
    }
    if (raw === null) return { text: null, truncated: false }
    return truncate(oneLine(redactText(stripAnsi(raw))), LIMITS.toolInputChars)
  }

  private boundedInput(args: unknown): unknown {
    const red = redactValue(args)
    if (typeof red === 'string') return truncate(red, LIMITS.partDetailBytes).text
    const s = JSON.stringify(red) ?? ''
    return s.length > LIMITS.partDetailBytes ? truncate(s, LIMITS.partDetailBytes).text : red
  }

  private abs(p: string): string {
    return path.isAbsolute(p) || !this.cwd ? p : path.resolve(this.cwd, p)
  }

  private argFiles(category: ToolCategory, args: unknown): string[] {
    if (category === 'patch' || category === 'shell') {
      const patch = patchArg(args)
      if (patch && (category === 'patch' || patch.includes('*** Begin Patch'))) return patchFiles(patch).map((p) => this.abs(p))
      if (category === 'shell') return []
    }
    const p = pathArg(args)
    return p ? [this.abs(p)] : []
  }

  /* ───────────────────────── plumbing ───────────────────────── */

  protected base(id: string, ts: number, kind: ActivityKind, status: ActivityStatus | null, title: string, extra: Partial<ActivityEvent> & { messageId?: string } = {}): ActivityEvent {
    return {
      id,
      rev: ts,
      harness: this.harness,
      sessionId: this.id,
      rootId: this.rootId(),
      messageId: extra.messageId ?? null,
      ts,
      endTs: null,
      kind,
      status,
      title,
      summary: extra.summary ?? null,
      tool: extra.tool ?? null,
      files: extra.files ?? [],
      childSessionId: null,
      usage: null,
      links: extra.links ?? [],
      source: this.opts.source,
      detailRef: id,
    }
  }

  private addEvent(
    ev: ActivityEvent,
    detail: { kind: ActivityKind; title: string; text?: string | null; input?: unknown; output?: string | null; error?: string | null; metadata?: unknown },
    grp: { key: string; role: Group['role']; model: string | null },
  ): void {
    const isNew = !this.events.has(ev.id)
    this.events.set(ev.id, ev)
    this.details.set(ev.id, {
      id: ev.id,
      sessionId: this.id,
      kind: detail.kind,
      title: detail.title,
      text: detail.text ?? null,
      input: detail.input ?? null,
      output: detail.output ?? null,
      error: detail.error ?? null,
      metadata: detail.metadata ?? null,
      truncated: false,
    })
    if (isNew) this.beginGroup(grp.key, grp.role, ev.ts, grp.model).items.push(ev.id)
    this.touched.add(ev.id)
  }

  /* ───────────────────────── queries ───────────────────────── */

  state(): HarnessSession['transcriptState'] {
    for (const cid of this.running) if (this.tools.get(cid)?.category === 'question') return 'waiting'
    return this.turnState
  }

  current(): CurrentActivity | null {
    const st = this.state()
    if (st !== 'working' && st !== 'waiting') return null
    let latest: ToolRec | null = null
    for (const cid of this.running) {
      const rec = this.tools.get(cid)
      if (rec && (!latest || rec.ev.ts >= latest.ev.ts)) latest = rec
    }
    if (latest) {
      return { kind: latest.ev.kind, label: latest.ev.tool?.displayName ?? latest.name, detail: latest.ev.tool?.input ?? null, since: latest.ev.ts, activityId: latest.ev.id }
    }
    if (st === 'working') return { kind: 'thinking', label: 'Thinking', detail: null, since: this.lastTs, activityId: null }
    return null
  }

  toSession(): HarnessSession {
    const createdAt = this.createdAtHint || this.firstTs || this.fileMtimeMs
    const updatedAt = Math.max(this.lastTs, this.fileMtimeMs)
    const facts: Array<{ label: string; value: string }> = []
    for (const [label, value] of this.facts) facts.push({ label, value })
    return {
      id: this.id,
      harness: this.harness,
      parentId: this.parentId,
      title: (this.title && safe(this.title, LIMITS.titleChars)) || this.firstPrompt || this.opts.untitled,
      agent: this.agent,
      model: this.modelId ? { providerId: this.providerId, modelId: this.modelId } : null,
      directory: this.cwd,
      createdAt,
      updatedAt,
      lastActivityAt: this.lastTs || null,
      archivedAt: null,
      tokens: { ...this.tokens },
      cost: this.cost,
      spawn: this.spawn,
      transcriptState: this.state(),
      current: this.current(),
      lastPrompt: this.lastPrompt,
      lastMessage: this.lastMessage,
      processAlive: this.alive,
      facts,
    }
  }

  sortedEvents(): ActivityEvent[] {
    return [...this.events.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  }

  counters(): SessionCounters {
    const files = new Set<string>()
    const c: SessionCounters = { messages: 0, steps: this.steps, thinking: 0, tools: 0, toolErrors: 0, mcpCalls: 0, fileChanges: 0, filesTouched: 0, subagents: 0 }
    for (const g of this.groups.values()) if (g.items.length) c.messages++
    for (const ev of this.events.values()) {
      if (ev.kind === 'thinking') c.thinking++
      if (ev.kind === 'subagent') c.subagents++
      if (ev.kind === 'file-change') c.fileChanges++
      for (const f of ev.files) files.add(f)
      if (ev.tool) {
        c.tools++
        if (ev.status === 'error') c.toolErrors++
        if (ev.kind === 'mcp') c.mcpCalls++
      }
    }
    c.filesTouched = files.size
    return c
  }

  messages(): TranscriptMessage[] {
    const out: TranscriptMessage[] = []
    for (const g of this.groups.values()) {
      if (!g.items.length) continue
      const items = g.items.map((i) => this.events.get(i)).filter((e): e is ActivityEvent => !!e)
      out.push({
        id: g.id,
        sessionId: this.id,
        role: g.role,
        agent: g.role === 'assistant' ? this.agent : null,
        model: g.model ? { providerId: this.providerId, modelId: g.model } : null,
        createdAt: g.createdAt,
        completedAt: g.completedAt,
        tokens: g.tokens,
        cost: null,
        finish: g.finish,
        error: g.error,
        items,
      })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  fileChanges(): FileChange[] {
    const cwd = this.cwd
    const out: FileChange[] = []
    for (const ev of this.sortedEvents()) {
      if (ev.kind !== 'file-change' || !ev.tool) continue
      const rec = ev.tool.callId ? this.tools.get(ev.tool.callId) : undefined
      const kind: FileChangeKind = rec?.fileKind ?? (ev.tool.category === 'write' ? 'write' : ev.tool.category === 'patch' ? 'patch' : 'edit')
      let add = rec?.linesAdded ?? null
      let del = rec?.linesRemoved ?? null
      if (add === null && rec) {
        const d = this.diffText(rec)
        if (d && d.format !== 'new-file') {
          const c = countPatch(d.text)
          add = c.add
          del = c.del
        } else if (d) {
          add = d.text === '' ? 0 : d.text.replace(/\n$/, '').split('\n').length
          del = 0
        }
      }
      for (const file of ev.files) {
        const rel = cwd && (file === cwd || file.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)) ? path.relative(cwd, file) : null
        out.push({
          id: ev.id,
          sessionId: this.id,
          rootId: this.rootId(),
          harness: this.harness,
          ts: ev.ts,
          path: file,
          workspaceRoot: cwd,
          relPath: rel,
          kind,
          tool: ev.tool.name,
          status: ev.status ?? 'completed',
          additions: ev.files.length === 1 ? add : null,
          deletions: ev.files.length === 1 ? del : null,
        })
      }
    }
    return out
  }

  /** Raw (unredacted) diff text for a tool call, or null. */
  private diffText(rec: ToolRec): { format: FileDiff['format']; text: string } | null {
    if (rec.resultDiff) return rec.resultDiff
    const file = rec.ev.files[0] ?? ''
    const a = rec.args
    if (rec.category === 'patch') {
      const p = patchArg(a)
      if (p) return { format: 'patch-text', text: p }
    }
    if (!isObj(a)) return null
    const hunk = (o: string, n: string) => {
      const ol = o.split('\n')
      const nl = n.split('\n')
      return `@@ -1,${ol.length} +1,${nl.length} @@\n${[...ol.map((l) => `-${l}`), ...nl.map((l) => `+${l}`)].join('\n')}\n`
    }
    const oldS = str(a.old_string) ?? str(a.old_str) ?? str(a.oldString) ?? (typeof a.old_string === 'string' ? a.old_string : null)
    const newS = typeof a.new_string === 'string' ? a.new_string : typeof a.new_str === 'string' ? a.new_str : typeof a.newString === 'string' ? a.newString : null
    if (oldS !== null && newS !== null) return { format: 'unified', text: `--- a/${file}\n+++ b/${file}\n${hunk(oldS, newS)}` }
    if (Array.isArray(a.edits)) {
      const hunks = a.edits
        .filter(isObj)
        .map((e) => {
          const o = typeof e.old_string === 'string' ? e.old_string : typeof e.oldString === 'string' ? e.oldString : null
          const n = typeof e.new_string === 'string' ? e.new_string : typeof e.newString === 'string' ? e.newString : null
          return o !== null && n !== null ? hunk(o, n) : ''
        })
        .join('')
      if (hunks) return { format: 'unified', text: `--- a/${file}\n+++ b/${file}\n${hunks}` }
    }
    if (rec.category === 'write') {
      const content = typeof a.content === 'string' ? a.content : typeof a.file_text === 'string' ? a.file_text : typeof a.contents === 'string' ? a.contents : null
      if (content !== null) return { format: 'new-file', text: content }
    }
    return null
  }

  diff(activityId: string): FileDiff | null {
    const ev = this.events.get(activityId)
    if (!ev || ev.kind !== 'file-change' || !ev.tool?.callId) return null
    const rec = this.tools.get(ev.tool.callId)
    const file = ev.files[0] ?? ''
    if (!rec) return { id: activityId, path: file, format: 'none', text: null, note: 'No diff data recorded', truncated: false }
    const d = this.diffText(rec)
    if (!d) return { id: activityId, path: file, format: 'none', text: null, note: 'No diff data recorded for this tool call', truncated: false }
    const t = truncate(redactText(d.text), LIMITS.diffBytes)
    return { id: activityId, path: file, format: d.format, text: t.text, note: null, truncated: t.truncated }
  }

  part(id: string): PartDetail | null {
    return this.details.get(id) ?? null
  }

  /**
   * Status of a spawned child as the parent's tool call reports it. Harnesses whose spawn tool
   * returns immediately (Codex `spawn_agent`) override this to follow the child's own state.
   */
  spawnStatus(rec: ToolRec, _child: TranscriptModel): ActivityStatus {
    return rec.ev.status ?? 'running'
  }

  /** Subagent tool calls (for spawn linking). */
  subagentCalls(): ToolRec[] {
    return [...this.tools.values()].filter((r) => r.ev.kind === 'subagent')
  }
}
