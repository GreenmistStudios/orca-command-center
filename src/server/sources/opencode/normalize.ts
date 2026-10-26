import type {
  ActivityEvent,
  ActivityKind,
  ActivityStatus,
  FileChangeKind,
  TokenUsage,
  ToolCallInfo,
  ToolCategory,
} from '../../../shared/contract.js'
import { LIMITS } from '../../../shared/contract.js'
import { redactText, redactValue } from '../../lib/redact.js'
import { clip, compactJson, extractLinks, oneLine, stripAnsi, truncate } from '../../lib/text.js'
import type { ToolClassifier } from '../../lib/tool-classify.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PartRow {
  id: string
  messageId: string
  sessionId: string
  timeCreated: number
  timeUpdated: number
  data: any
}

export interface RawPartRow {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

export interface NormalizeContext {
  classifier: ToolClassifier
  /** Role of the part's message ('user' | 'assistant' | …), null when unknown. */
  role: string | null
  /** Session working directory (to shorten paths). */
  directory: string | null
  rootId: string
  /** Event time (ms) when known; falls back to part.time_updated. */
  rev?: number | null
  source: 'opencode.event' | 'opencode.part'
}

export interface Normalized {
  event: ActivityEvent
  /** synthetic / ignored text parts: skipped in the stream, kept (muted) in the transcript. */
  muted: boolean
}

const STATUSES = new Set<string>(['pending', 'running', 'completed', 'error'])
const FILE_TOOLS = new Set(['edit', 'multiedit', 'write', 'patch', 'apply_patch'])

export function parseJson(text: string): any | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parsePartRow(raw: RawPartRow): PartRow | null {
  const data = parseJson(raw.data)
  if (!data || typeof data !== 'object') return null
  return {
    id: raw.id,
    messageId: raw.message_id,
    sessionId: raw.session_id,
    timeCreated: raw.time_created,
    timeUpdated: raw.time_updated,
    data,
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Strip ANSI, redact, then clip (redact first so a cut can't leave half a token). */
export function safeText(text: string, max: number): { text: string; truncated: boolean } {
  const head = text.length > 20_000 ? text.slice(0, 20_000) : text
  const cleaned = redactText(stripAnsi(head))
  const t = truncate(cleaned, max)
  return { text: t.text, truncated: t.truncated || head.length < text.length }
}

export function safeOneLine(text: string, max: number): string {
  const head = text.length > 20_000 ? text.slice(0, 20_000) : text
  return clip(oneLine(redactText(stripAnsi(head))), max)
}

export function relativeTo(path: string, dir: string | null): string {
  if (!dir) return path
  const d = dir.replace(/\/+$/, '')
  if (path === d) return '.'
  if (path.startsWith(d + '/')) return path.slice(d.length + 1)
  return path
}

export function toTokenUsage(t: any): TokenUsage {
  return {
    input: num(t?.input) ?? 0,
    output: num(t?.output) ?? 0,
    reasoning: num(t?.reasoning) ?? 0,
    cacheRead: num(t?.cache?.read) ?? 0,
    cacheWrite: num(t?.cache?.write) ?? 0,
  }
}

export function isMutedPart(data: any): boolean {
  return data?.type === 'text' && (data.synthetic === true || data.ignored === true)
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`
}

function toolStatus(state: any): ActivityStatus {
  return STATUSES.has(state?.status) ? (state.status as ActivityStatus) : 'pending'
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

/** The raw (unredacted, untruncated) output text of a tool state. */
export function toolOutputText(state: any): string | null {
  if (!state) return null
  if (state.status === 'completed' && state.output != null) return stringify(state.output)
  if (state.status === 'error') return typeof state.error === 'string' ? state.error : null
  const m = state.metadata?.output
  if (m != null) return stringify(m)
  return null
}

/** One-line preview of the tool input for titles. */
function inputPreview(toolName: string, category: ToolCategory, input: any, dir: string | null): string | null {
  if (input == null || typeof input !== 'object') return null
  const lname = toolName.toLowerCase()
  const p = (v: unknown) => (typeof v === 'string' && v ? v : null)
  switch (category) {
    case 'shell':
      return p(input.command) ?? p(input.description)
    case 'read':
    case 'edit':
    case 'write': {
      const f = p(input.filePath) ?? p(input.path)
      return f ? relativeTo(f, dir) : null
    }
    case 'search':
      return p(input.pattern) ?? p(input.query)
    case 'web':
      return p(input.url) ?? p(input.query)
    case 'subagent': {
      const t = p(input.subagent_type)
      const d = p(input.description)
      return t && d ? `${t} · ${d}` : (d ?? t)
    }
    case 'skill':
      return p(input.name)
    case 'question': {
      const q = Array.isArray(input.questions) ? input.questions[0] : null
      return p(q?.question)
    }
    case 'todo':
      return Array.isArray(input.todos) ? `${input.todos.length} todos` : null
    case 'patch': {
      const files = patchFiles(input)
      return files.length ? files.map((f) => relativeTo(f.path, dir)).join(', ') : null
    }
    case 'mcp':
    case 'plugin':
    case 'other':
    default:
      if (lname === 'list' || lname === 'ls') return p(input.path)
      return Object.keys(input).length ? compactJson(redactValue(input), LIMITS.titleChars) : null
  }
}

/* ─────────────────────────── patch text / diffs ─────────────────────────── */

export interface PatchFile {
  path: string
  op: 'add' | 'update' | 'delete'
  additions: number
  deletions: number
}

export function patchTextOf(input: any): string | null {
  if (!input || typeof input !== 'object') return null
  return str(input.patchText) ?? str(input.patch) ?? str(input.diff) ?? str(input.input)
}

/** Parse `*** Update File: path` style apply_patch bodies (per-file +/- counts). */
export function parsePatchText(text: string): PatchFile[] {
  const files: PatchFile[] = []
  let cur: PatchFile | null = null
  for (const line of text.split('\n')) {
    const m = /^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/.exec(line)
    if (m) {
      cur = { path: m[2]!, op: m[1] === 'Add' ? 'add' : m[1] === 'Delete' ? 'delete' : 'update', additions: 0, deletions: 0 }
      files.push(cur)
      continue
    }
    if (!cur || line.startsWith('***')) continue
    if (line.startsWith('+')) cur.additions++
    else if (line.startsWith('-')) cur.deletions++
  }
  return files
}

export function patchFiles(input: any): PatchFile[] {
  const text = patchTextOf(input)
  if (text) {
    const parsed = parsePatchText(text)
    if (parsed.length) return parsed
  }
  const f = str(input?.filePath) ?? str(input?.path)
  return f ? [{ path: f, op: 'update', additions: 0, deletions: 0 }] : []
}

export function countUnifiedDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

export function countLines(text: string): number {
  if (!text) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

/** Absolute paths touched by a part. */
export function filesOfPart(data: any, dir: string | null): string[] {
  const abs = (p: string) => (p.startsWith('/') || !dir ? p : `${dir.replace(/\/+$/, '')}/${p}`)
  if (data.type === 'patch') return Array.isArray(data.files) ? data.files.filter((f: unknown) => typeof f === 'string') : []
  if (data.type !== 'tool') return []
  const tool = String(data.tool ?? '').toLowerCase()
  const input = data.state?.input
  if (!input || typeof input !== 'object') return []
  if (tool === 'apply_patch' || tool === 'patch') {
    const text = patchTextOf(input)
    const parsed = text ? parsePatchText(text) : []
    if (parsed.length) return parsed.map((f) => abs(f.path))
  }
  const f = str(input.filePath) ?? str(input.path)
  if (f && (FILE_TOOLS.has(tool) || tool === 'read')) return [abs(f)]
  return []
}

export function fileChangeKindOf(data: any): FileChangeKind {
  const tool = String(data.tool ?? '').toLowerCase()
  if (tool === 'write') return data.state?.metadata?.exists === false ? 'create' : 'write'
  if (tool === 'edit' || tool === 'multiedit') return 'edit'
  return 'patch'
}

/* ───────────────────────────── normalization ───────────────────────────── */

function kindForCategory(category: ToolCategory): ActivityKind {
  switch (category) {
    case 'subagent':
      return 'subagent'
    case 'todo':
      return 'todo'
    case 'edit':
    case 'write':
    case 'patch':
      return 'file-change'
    case 'mcp':
      return 'mcp'
    default:
      return 'tool'
  }
}

/** part → ActivityEvent. Returns null for parts that are not events (step-start, malformed). */
export function normalizePart(row: PartRow, ctx: NormalizeContext): Normalized | null {
  const d = row.data
  const type = str(d.type)
  if (!type || type === 'step-start') return null

  const base = {
    id: `opencode:${row.id}`,
    rev: ctx.rev ?? row.timeUpdated,
    harness: 'opencode' as const,
    sessionId: row.sessionId,
    rootId: ctx.rootId,
    messageId: row.messageId,
    source: ctx.source,
  }
  const empty = {
    status: null as ActivityStatus | null,
    summary: null as string | null,
    tool: null as ToolCallInfo | null,
    files: [] as string[],
    childSessionId: null as string | null,
    usage: null as ActivityEvent['usage'],
    links: [] as string[],
    detailRef: null as string | null,
    endTs: null as number | null,
  }
  const safeLinks = (text: string | null) =>
    text ? extractLinks(text, LIMITS.linksPerEvent).map((u) => redactText(u)) : []

  switch (type) {
    case 'text': {
      const text = str(d.text) ?? ''
      const muted = isMutedPart(d)
      const first = text.split('\n').find((l) => l.trim()) ?? ''
      const time = d.time
      const status: ActivityStatus = time && num(time.start) != null && num(time.end) == null ? 'running' : 'completed'
      const title = safeOneLine(first, LIMITS.titleChars - 14)
      return {
        muted,
        event: {
          ...base,
          ...empty,
          ts: num(time?.start) ?? row.timeCreated,
          endTs: num(time?.end),
          kind: ctx.role === 'user' ? 'prompt' : 'text',
          status,
          title: muted ? `(synthetic) ${title}` : title,
          summary: safeText(text, LIMITS.summaryChars).text,
          links: safeLinks(text),
          detailRef: row.id,
        },
      }
    }
    case 'reasoning': {
      const text = str(d.text) ?? ''
      const time = d.time
      return {
        muted: false,
        event: {
          ...base,
          ...empty,
          ts: num(time?.start) ?? row.timeCreated,
          endTs: num(time?.end),
          kind: 'thinking',
          status: num(time?.end) != null ? 'completed' : 'running',
          title: 'Thinking',
          summary: text ? safeText(text, LIMITS.summaryChars).text : null,
          links: safeLinks(text),
          detailRef: row.id,
        },
      }
    }
    case 'tool': {
      const name = str(d.tool) ?? 'unknown'
      ctx.classifier.observe(name)
      const cls = ctx.classifier.classify('opencode', name)
      const state = d.state ?? {}
      const input = state.input
      const status = toolStatus(state)
      const preview = inputPreview(name, cls.category, input, ctx.directory)
      const rawTitle =
        cls.category === 'subagent' ? (preview ?? 'subagent') : preview ? `${cls.displayName} · ${preview}` : cls.displayName
      const rawOut = toolOutputText(state)
      const isRead = cls.category === 'read'
      const out = rawOut != null && !isRead && status !== 'error' ? safeText(rawOut, LIMITS.toolOutputChars) : null
      const errRaw = status === 'error' ? (typeof state.error === 'string' ? state.error : (rawOut ?? 'error')) : null
      const err = errRaw ? safeText(errRaw, LIMITS.toolInputChars) : null

      let inputStr: { text: string; truncated: boolean } | null = null
      if (input != null) {
        const raw =
          cls.category === 'shell' && typeof input.command === 'string'
            ? input.command
            : compactJson(redactValue(input), 20_000)
        inputStr = safeText(raw, LIMITS.toolInputChars)
      }
      const start = num(state.time?.start)
      const end = num(state.time?.end)
      const tool: ToolCallInfo = {
        name,
        displayName: cls.displayName,
        category: cls.category,
        mcpServer: cls.mcpServer,
        callId: str(d.callID),
        input: inputStr?.text ?? null,
        output: out?.text ?? null,
        error: err?.text ?? null,
        durationMs: start != null && end != null ? Math.max(0, end - start) : null,
        truncated: Boolean(inputStr?.truncated || out?.truncated || err?.truncated),
      }
      // summary: tool output (completed) / metadata.output (running) / error text; never read output
      const summary = isRead ? null : err ? err.text : out ? truncate(out.text, LIMITS.summaryChars).text : null
      return {
        muted: false,
        event: {
          ...base,
          ...empty,
          ts: start ?? row.timeCreated,
          endTs: end,
          kind: kindForCategory(cls.category),
          status,
          title: safeOneLine(rawTitle, LIMITS.titleChars),
          summary,
          tool,
          files: filesOfPart(d, ctx.directory),
          childSessionId: cls.category === 'subagent' ? str(state.metadata?.sessionId) : null,
          links: isRead ? [] : safeLinks(rawOut),
          detailRef: row.id,
        },
      }
    }
    case 'step-finish': {
      const tokens = toTokenUsage(d.tokens)
      const total =
        num(d.tokens?.total) ?? tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
      return {
        muted: false,
        event: {
          ...base,
          ...empty,
          ts: row.timeCreated,
          kind: 'step',
          status: 'completed',
          title: `Step · ${str(d.reason) ?? 'finish'} · ${fmtTokens(total)}`,
          usage: { tokens, cost: num(d.cost) ?? 0 },
        },
      }
    }
    case 'patch': {
      const files = filesOfPart(d, ctx.directory)
      return {
        muted: false,
        event: {
          ...base,
          ...empty,
          ts: row.timeCreated,
          kind: 'file-change',
          status: 'completed',
          title: `Snapshot · ${files.length} file${files.length === 1 ? '' : 's'} changed`,
          files,
          detailRef: row.id,
        },
      }
    }
    case 'file': {
      const name = str(d.filename) ?? str(d.mime) ?? 'file'
      return {
        muted: false,
        event: {
          ...base,
          ...empty,
          ts: row.timeCreated,
          kind: 'prompt',
          status: 'completed',
          title: safeOneLine(`Attachment · ${name}`, LIMITS.titleChars),
        },
      }
    }
    default:
      return {
        muted: true,
        event: {
          ...base,
          ...empty,
          ts: row.timeCreated,
          kind: 'text',
          status: 'completed',
          title: safeOneLine(type, LIMITS.titleChars),
        },
      }
  }
}

/* ───────────────────────────── part detail ───────────────────────────── */

function dropKeys(v: unknown, keys: Set<string>, depth = 0): unknown {
  if (depth > 8) return v
  if (Array.isArray(v)) return v.map((x) => dropKeys(x, keys, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!keys.has(k)) out[k] = dropKeys(x, keys, depth + 1)
    }
    return out
  }
  return v
}

function clipDeep(v: unknown, max: number, flag: { truncated: boolean }, depth = 0): unknown {
  if (typeof v === 'string') {
    if (v.length > max) {
      flag.truncated = true
      return v.slice(0, max) + '…'
    }
    return v
  }
  if (depth > 8) return v
  if (Array.isArray(v)) return v.map((x) => clipDeep(x, max, flag, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clipDeep(x, max, flag, depth + 1)
    return out
  }
  return v
}

export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (text.length <= maxBytes / 4 || Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  return { text: Buffer.from(text).subarray(0, maxBytes).toString('utf8') + '…', truncated: true }
}

export interface PartDetailParts {
  text: string | null
  input: unknown
  output: string | null
  error: string | null
  metadata: unknown
  truncated: boolean
}

export function partDetailOf(d: any): PartDetailParts {
  const flag = { truncated: false }
  const bytes = LIMITS.partDetailBytes
  let text: string | null = null
  let output: string | null = null
  let error: string | null = null
  let input: unknown = null
  let metadata: unknown = null
  if (d.type === 'text' || d.type === 'reasoning') {
    const c = capBytes(redactText(stripAnsi(str(d.text) ?? '')), bytes)
    text = c.text
    flag.truncated ||= c.truncated
    if (d.type === 'reasoning') metadata = redactValue(dropKeys(d.metadata ?? null, new Set(['signature'])))
  } else if (d.type === 'tool') {
    const state = d.state ?? {}
    input = clipDeep(redactValue(dropKeys(state.input ?? null, new Set(['signature']))), bytes, flag)
    const raw = toolOutputText(state)
    if (raw != null) {
      const c = capBytes(redactText(stripAnsi(raw)), bytes)
      if (state.status === 'error') error = c.text
      else output = c.text
      flag.truncated ||= c.truncated
    }
    if (state.status === 'error' && typeof state.error === 'string' && error == null) {
      error = redactText(stripAnsi(state.error))
    }
    metadata = clipDeep(redactValue(dropKeys(state.metadata ?? null, new Set(['signature']))), bytes, flag)
  } else if (d.type === 'file') {
    metadata = { mime: d.mime ?? null, filename: d.filename ?? null, url: '[data-url omitted]' }
    if (typeof d.url === 'string' && !d.url.startsWith('data:')) (metadata as any).url = redactText(d.url)
  } else if (d.type === 'patch') {
    metadata = { hash: d.hash ?? null, files: Array.isArray(d.files) ? d.files : [] }
  } else {
    metadata = clipDeep(redactValue(dropKeys(d, new Set(['signature']))), bytes, flag)
  }
  return { text, input, output, error, metadata, truncated: flag.truncated }
}
