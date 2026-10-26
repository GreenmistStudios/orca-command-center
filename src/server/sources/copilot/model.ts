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
  type PartDetail,
  type SessionCounters,
  type ToolCallInfo,
  type TranscriptMessage,
  type UsageEstimate,
  type TokenUsage,
  type UsageSample,
} from '../../../shared/contract.js'
import type { HarnessSession } from '../../types.js'
import { redactText, redactValue } from '../../lib/redact.js'
import { clip, compactJson, extractLinks, oneLine, stripAnsi, truncate } from '../../lib/text.js'
import { parseTime } from '../../lib/time.js'
import type { ToolClassifier } from '../../lib/tool-classify.js'
import type { CopilotWorkspace } from './workspace.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export interface ToolRec {
  callId: string
  name: string
  ev: ActivityEvent
  args: unknown
  linesAdded: number | null
  linesRemoved: number | null
}

interface Group {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: number
  completedAt: number | null
  model: string | null
  error: string | null
  finish: string | null
  items: string[]
}

const safe = (s: string, max: number): string => clip(oneLine(redactText(stripAnsi(s))), max)

function pathArg(args: unknown): string | null {
  if (!isObj(args)) return null
  return str(args.path) ?? str(args.file_path) ?? str(args.filePath) ?? str(args.filename)
}

function patchFiles(patch: string): string[] {
  const out: string[] = []
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) out.push(m[1]!.trim())
  if (out.length === 0) for (const m of patch.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) if (m[1] !== '/dev/null') out.push(m[1]!)
  return out
}

function countPatch(patch: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const l of patch.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++
    else if (l.startsWith('-') && !l.startsWith('---')) del++
  }
  return { add, del }
}

const zero = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
function addTo(a: TokenUsage, b: TokenUsage): void {
  a.input += b.input
  a.output += b.output
  a.reasoning += b.reasoning
  a.cacheRead += b.cacheRead
  a.cacheWrite += b.cacheWrite
}

export class SessionModel {
  readonly events = new Map<string, ActivityEvent>()
  readonly details = new Map<string, PartDetail>()
  readonly tools = new Map<string, ToolRec>()
  readonly groups = new Map<string, Group>()
  /** Activity ids changed since the last drain(). */
  private touched = new Set<string>()
  ws: CopilotWorkspace | null = null
  fileMtimeMs = 0
  alive = false
  /** Byte offset just after the last fully consumed line. */
  offset = 0
  size = 0
  truncatedHead = false

  private seq = 0
  private startSeq = 0
  private endSeq = 0
  private errSeq = 0
  private stopSeq = 0
  private turnsEnded = 0
  private firstTs = 0
  private lastTs = 0
  private startCwd: string | null = null
  private startModel: string | null = null
  private lastModel: string | null = null
  private version: string | null = null
  private premium: string | null = null
  private routed: string | null = null
  private firstPrompt: string | null = null
  private lastPrompt: string | null = null
  private lastMessage: string | null = null
  private currentTurn: string | null = null
  readonly samples = new Map<string, UsageSample>()
  private readonly callStarts = new Map<string, number>()
  private inFlightSince: number | null = null
  private usageOut: { samples: UsageSample[]; estimates: UsageEstimate[] } = { samples: [], estimates: [] }
  /** Multiple-shutdown rule (resumed sessions). Real data on this machine has one multi-shutdown
   *  session and its metrics are all zero, so it cannot discriminate; Copilot's shutdown reports the
   *  process run, so the default is 'per-run' (additive). 'cumulative' subtracts what earlier
   *  shutdowns already reported. */
  shutdownMode: 'per-run' | 'cumulative' = 'per-run'
  private periodStart: number | null = null
  private periodCalls = new Map<string, { t: TokenUsage; aiu: number }>()
  private prevTotals = new Map<string, { t: TokenUsage; aiu: number }>()
  private shutdowns = 0
  private checkpointAiu: number | null = null
  private shutdownFacts: Array<{ label: string; value: string }> = []
  private readonly pending = new Map<string, { ts: number; label: string }>()
  private readonly running = new Map<string, number>()

  constructor(
    readonly id: string,
    private readonly classifier: ToolClassifier,
  ) {}

  drain(): string[] {
    const out = [...this.touched]
    this.touched = new Set()
    return out
  }

  drainUsage(): { samples: UsageSample[]; estimates: UsageEstimate[] } {
    const out = this.usageOut
    this.usageOut = { samples: [], estimates: [] }
    return out
  }

  /** After a full parse: forget replayed history, keep only a still-open in-flight estimate. */
  dropHistoricalUsage(): void {
    this.usageOut = { samples: [], estimates: [] }
    if (this.inFlightSince !== null) this.estimate(true, this.inFlightSince, this.lastTs)
  }

  private estimate(inFlight: boolean, startedAt: number, ts: number): void {
    this.usageOut.estimates.push({ sessionId: this.id, rootId: null, harness: 'copilot', startedAt, updatedAt: ts, estOutputTokens: 0, inFlight })
  }

  private endInFlight(ts: number): void {
    if (this.inFlightSince === null) return
    this.estimate(false, this.inFlightSince, ts)
    this.inFlightSince = null
  }

  private callStarted(d: Obj, ts: number): void {
    const started = typeof d.timestampMs === 'number' ? d.timestampMs : ts
    const turn = d.turn === undefined || d.turn === null ? null : String(d.turn)
    if (turn !== null) this.callStarts.set(turn, started)
    this.inFlightSince = started
    this.estimate(true, started, ts)
  }

  private callSuccess(d: Obj, ts: number, eid: string): void {
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const usage = isObj(d.responseUsage) ? d.responseUsage : {}
    const ptd = isObj(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
    const ctd = isObj(usage.completion_tokens_details) ? usage.completion_tokens_details : {}
    const cu = isObj(d.copilotUsage) ? d.copilotUsage : {}
    let cacheWrite = 0
    if (Array.isArray(cu.token_details)) {
      for (const t of cu.token_details) if (isObj(t) && t.token_type === 'cache_write') cacheWrite += Math.max(0, num(t.token_count) ?? 0)
    }
    const cacheRead = Math.max(0, num(ptd.cached_tokens) ?? 0)
    const prompt = num(usage.prompt_tokens) ?? 0
    const completion = num(usage.completion_tokens) ?? 0
    const reasoning = Math.max(0, num(ctd.reasoning_tokens) ?? 0)
    const duration = num(d.modelCallDurationMs)
    const turn = d.turn === undefined || d.turn === null ? null : String(d.turn)
    const started = turn !== null ? this.callStarts.get(turn) : undefined
    if (turn !== null) this.callStarts.delete(turn)
    const mc = isObj(d.modelCall) ? d.modelCall : {}
    const modelId = str(mc.model) ?? str(d.model)
    const nano = num(isObj(d.copilotUsage) ? cu.total_nano_aiu : null)
    const callId = str(d.callId) ?? eid
    const sample: UsageSample = {
      id: `copilot:${this.id}:call:${callId}`,
      harness: 'copilot',
      sessionId: this.id,
      rootId: null,
      ledgerSeq: 0,
      ts,
      startTs: started ?? (duration !== null ? ts - duration : null),
      model: modelId ? { providerId: 'github-copilot', modelId } : null,
      agent: 'copilot',
      // prompt_tokens includes cache reads and writes (matches session.shutdown tokenDetails.input)
      tokens: { input: Math.max(0, prompt - cacheRead - cacheWrite), output: Math.max(0, completion - reasoning), reasoning, cacheRead, cacheWrite },
      cost: null,
      aiu: nano === null ? null : nano / 1e9,
      ttftMs: num(d.ttftMs),
      durationMs: duration,
      finish: null,
      source: 'copilot.model_call_success',
    }
    if (modelId) this.lastModel = this.lastModel ?? modelId
    this.samples.set(sample.id, sample)
    if (modelId) {
      const acc = this.periodCalls.get(modelId) ?? { t: zero(), aiu: 0 }
      addTo(acc.t, sample.tokens)
      acc.aiu += sample.aiu ?? 0
      this.periodCalls.set(modelId, acc)
    }
    this.usageOut.samples.push(sample)
    this.estimate(false, this.inFlightSince ?? sample.startTs ?? ts, ts)
    this.inFlightSince = null
  }

  /** Per-model remainder samples: shutdown totals minus per-call samples already counted. */
  private shutdownSummary(d: Obj, ts: number, eid: string): void {
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const start = this.periodStart ?? this.firstTs
    this.periodStart = ts
    this.shutdowns++
    const mm = isObj(d.modelMetrics) ? d.modelMetrics : null
    const nextPrev = new Map(this.prevTotals)
    if (mm) {
      for (const [modelId, raw] of Object.entries(mm)) {
        if (!isObj(raw)) continue
        const u = isObj(raw.usage) ? raw.usage : {}
        const td = isObj(raw.tokenDetails) ? raw.tokenDetails : {}
        const cacheRead = Math.max(0, num(u.cacheReadTokens) ?? 0)
        const cacheWrite = Math.max(0, num(u.cacheWriteTokens) ?? 0)
        const reasoning = Math.max(0, num(u.reasoningTokens) ?? 0)
        const fresh = isObj(td.input) ? num(td.input.tokenCount) : null
        const total: TokenUsage = {
          input: fresh !== null ? Math.max(0, fresh) : Math.max(0, (num(u.inputTokens) ?? 0) - cacheRead - cacheWrite),
          output: Math.max(0, (num(u.outputTokens) ?? 0) - reasoning),
          reasoning,
          cacheRead,
          cacheWrite,
        }
        const aiu = Math.max(0, num(raw.totalNanoAiu) ?? 0) / 1e9
        nextPrev.set(modelId, { t: { ...total }, aiu })
        const prev = this.shutdownMode === 'cumulative' ? this.prevTotals.get(modelId) : undefined
        const calls = this.periodCalls.get(modelId)
        const t: TokenUsage = {
          input: Math.max(0, total.input - (prev?.t.input ?? 0) - (calls?.t.input ?? 0)),
          output: Math.max(0, total.output - (prev?.t.output ?? 0) - (calls?.t.output ?? 0)),
          reasoning: Math.max(0, total.reasoning - (prev?.t.reasoning ?? 0) - (calls?.t.reasoning ?? 0)),
          cacheRead: Math.max(0, total.cacheRead - (prev?.t.cacheRead ?? 0) - (calls?.t.cacheRead ?? 0)),
          cacheWrite: Math.max(0, total.cacheWrite - (prev?.t.cacheWrite ?? 0) - (calls?.t.cacheWrite ?? 0)),
        }
        const rest = Math.max(0, aiu - (prev?.aiu ?? 0) - (calls?.aiu ?? 0))
        if (t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite === 0 && rest < 1e-12) continue
        const sample: UsageSample = {
          id: `copilot:${this.id}:summary:${eid}:${modelId}`,
          harness: 'copilot',
          sessionId: this.id,
          rootId: null,
          ledgerSeq: 0,
          ts,
          startTs: start || null,
          model: { providerId: 'github-copilot', modelId },
          agent: 'copilot',
          tokens: t,
          cost: null,
          aiu: rest,
          ttftMs: null,
          durationMs: null,
          finish: 'session-summary',
          source: 'copilot.session-summary',
        }
        this.samples.set(sample.id, sample)
        this.usageOut.samples.push(sample)
      }
    }
    this.prevTotals = nextPrev
    this.periodCalls = new Map()
  }

  private shutdownInfo(d: Obj): void {
    const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const f: Array<{ label: string; value: string }> = []
    const sys = n(d.systemTokens)
    const tools = n(d.toolDefinitionsTokens)
    const conv = n(d.conversationTokens)
    const fmt = (v: number | null) => (v === null ? '?' : v.toLocaleString('en-US'))
    if (sys !== null || tools !== null || conv !== null) f.push({ label: 'Context (system · tools · conversation)', value: `${fmt(sys)} · ${fmt(tools)} · ${fmt(conv)}` })
    const api = n(d.totalApiDurationMs)
    if (api !== null) f.push({ label: 'API time', value: `${api} ms` })
    this.shutdownFacts = f
  }

  get copilotVersion(): string | null {
    return this.version
  }

  /* ───────────────────────── ingestion ───────────────────────── */

  ingest(line: string): void {
    if (!line.trim()) return
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      return
    }
    if (!isObj(e)) return
    const type = str(e.type)
    if (!type) return
    const ts = parseTime(e.timestamp) ?? this.lastTs ?? 0
    const data = isObj(e.data) ? e.data : {}
    const eid = str(e.id) ?? `seq${this.seq + 1}`
    this.seq++
    if (!this.firstTs) this.firstTs = ts
    if (ts > this.lastTs) this.lastTs = ts
    try {
      this.apply(type, data, ts, eid)
    } catch {
      /* a malformed event never breaks the session */
    }
  }

  private apply(type: string, d: Obj, ts: number, eid: string): void {
    switch (type) {
      case 'session.start': {
        this.version = str(d.copilotVersion) ?? this.version
        this.startModel = str(d.selectedModel) ?? this.startModel
        const ctx = isObj(d.context) ? d.context : null
        this.startCwd = (ctx && str(ctx.cwd)) ?? this.startCwd
        return
      }
      case 'user.message': {
        const content = str(d.content) ?? ''
        const clean = redactText(content)
        if (!this.firstPrompt && content.trim()) this.firstPrompt = safe(content, 80)
        this.lastPrompt = safe(content, LIMITS.promptChars)
        const id = `copilot:${this.id}:${eid}`
        const gid = str(d.messageId) ?? eid
        this.addEvent(
          this.base(id, ts, 'prompt', null, safe(content, LIMITS.titleChars) || 'Prompt', {
            summary: clip(clean, LIMITS.summaryChars),
            links: extractLinks(clean, LIMITS.linksPerEvent),
            messageId: gid,
          }),
          { kind: 'prompt', title: 'Prompt', text: truncate(clean, LIMITS.partDetailBytes).text },
          { key: `user:${gid}`, role: 'user', model: null },
        )
        return
      }
      case 'assistant.turn_start': {
        this.startSeq = this.seq
        this.currentTurn = str(d.turnId) ?? eid
        this.group(`turn:${this.currentTurn}`, 'assistant', ts, null)
        return
      }
      case 'assistant.turn_end': {
        this.endSeq = this.seq
        this.turnsEnded++
        this.endInFlight(ts)
        const g = this.groups.get(`turn:${str(d.turnId) ?? this.currentTurn}`)
        if (g) {
          g.completedAt = ts
          g.finish = g.error ? 'error' : 'stop'
        }
        return
      }
      case 'assistant.message': {
        const turn = str(d.turnId) ?? this.currentTurn ?? eid
        const model = str(d.model)
        if (model) this.lastModel = model
        const reasoning = str(d.reasoningText)
        const content = str(d.content)
        if (reasoning && reasoning.trim()) {
          const clean = redactText(reasoning)
          this.addEvent(
            this.base(`copilot:${this.id}:${eid}:thinking`, ts, 'thinking', null, 'Thinking', {
              summary: clip(oneLine(clean), LIMITS.summaryChars),
              messageId: `turn:${turn}`,
            }),
            { kind: 'thinking', title: 'Thinking', text: truncate(clean, LIMITS.partDetailBytes).text },
            { key: `turn:${turn}`, role: 'assistant', model },
          )
        }
        if (content && content.trim()) {
          const clean = redactText(content)
          this.lastMessage = safe(content, LIMITS.summaryChars)
          this.addEvent(
            this.base(`copilot:${this.id}:${eid}`, ts, 'text', null, safe(content, LIMITS.titleChars), {
              summary: clip(clean, LIMITS.summaryChars),
              links: extractLinks(clean, LIMITS.linksPerEvent),
              messageId: `turn:${turn}`,
            }),
            { kind: 'text', title: 'Assistant', text: truncate(clean, LIMITS.partDetailBytes).text },
            { key: `turn:${turn}`, role: 'assistant', model },
          )
        }
        return
      }
      case 'tool.execution_start':
        return this.toolStart(d, ts)
      case 'tool.execution_complete':
        return this.toolComplete(d, ts)
      case 'permission.requested':
        return this.permRequested(d, ts)
      case 'permission.completed':
        return this.permCompleted(d, ts)
      case 'session.usage_checkpoint': {
        const n = d.totalPremiumRequests
        if (typeof d.totalNanoAiu === 'number' && Number.isFinite(d.totalNanoAiu)) this.checkpointAiu = d.totalNanoAiu / 1e9
        if (typeof n === 'number' || typeof n === 'string') this.premium = String(n)
        return
      }
      case 'session.auto_mode_resolved':
        this.routed = str(d.chosenModel) ?? this.routed
        return
      case 'model.model_call_started':
        return this.callStarted(d, ts)
      case 'model.model_call_success':
        return this.callSuccess(d, ts, eid)
      case 'session.shutdown':
        this.shutdownInfo(d)
        this.shutdownSummary(d, ts, eid)
        this.endInFlight(ts)
        this.stopSeq = this.seq
        this.pending.clear()
        this.running.clear()
        return
      case 'session.error':
      case 'abort': {
        this.errSeq = this.seq
        this.endInFlight(ts)
        this.pending.clear()
        this.running.clear()
        const msg = str(d.message) ?? str(d.reason) ?? type
        const title = type === 'abort' ? 'Aborted' : `Error${str(d.errorType) ? ` · ${str(d.errorType)}` : ''}`
        const g = this.currentTurn ? this.groups.get(`turn:${this.currentTurn}`) : undefined
        if (g) g.error = safe(msg, LIMITS.summaryChars)
        this.addEvent(
          this.base(`copilot:${this.id}:${eid}`, ts, 'error', 'error', safe(`${title}: ${msg}`, LIMITS.titleChars), {
            summary: safe(msg, LIMITS.summaryChars),
            messageId: this.currentTurn ? `turn:${this.currentTurn}` : `sys:${eid}`,
          }),
          { kind: 'error', title, text: truncate(redactText(msg), LIMITS.partDetailBytes).text, error: safe(msg, LIMITS.summaryChars) },
          { key: this.currentTurn ? `turn:${this.currentTurn}` : `sys:${eid}`, role: this.currentTurn ? 'assistant' : 'system', model: null },
        )
        return
      }
      default:
        if (type.startsWith('subagent.')) this.subagent(type, d, ts, eid)
    }
  }

  private subagent(type: string, d: Obj, ts: number, eid: string): void {
    const phase = type.slice('subagent.'.length)
    if (phase === 'selected' || phase === 'deselected') return
    const callId = str(d.toolCallId)
    const name = str(d.agentName) ?? str(d.agentDisplayName) ?? str(d.type) ?? phase
    const id = callId ? `copilot:${this.id}:subagent:${callId}` : `copilot:${this.id}:${eid}`
    const prev = this.events.get(id)
    const status: ActivityStatus = /fail|error/.test(phase) ? 'error' : /complet|end|finish/.test(phase) ? 'completed' : 'running'
    const key = this.currentTurn ? `turn:${this.currentTurn}` : `sys:${eid}`
    const ev = this.base(id, prev?.ts ?? ts, 'subagent', status, safe(`Subagent · ${name}`, LIMITS.titleChars), {
      summary: safe(str(d.description) ?? str(d.message) ?? phase, LIMITS.summaryChars),
      messageId: key,
    })
    ev.rev = ts
    if (status !== 'running') ev.endTs = ts
    this.addEvent(ev, { kind: 'subagent', title: ev.title, text: ev.summary, metadata: redactValue(d) }, { key, role: this.currentTurn ? 'assistant' : 'system', model: null })
  }

  /* ───────────────────────── tools ───────────────────────── */

  private toolStart(d: Obj, ts: number): void {
    const callId = str(d.toolCallId)
    const name = str(d.toolName)
    if (!callId || !name) return
    const model = str(d.model)
    if (model) this.lastModel = model
    this.classifier.observe(name)
    const cls = this.classifier.classify('copilot', name)
    const args = d.arguments
    const files = this.argFiles(name, args)
    const inputPreview = this.inputPreview(name, args)
    const kind: ActivityKind =
      cls.category === 'mcp' ? 'mcp' : cls.category === 'subagent' ? 'subagent' : ['edit', 'write', 'patch'].includes(cls.category) ? 'file-change' : 'tool'
    const tool: ToolCallInfo = {
      name,
      displayName: cls.displayName,
      category: cls.category,
      mcpServer: cls.mcpServer,
      callId,
      input: inputPreview.text,
      output: null,
      error: null,
      durationMs: null,
      truncated: inputPreview.truncated,
    }
    const id = `copilot:${this.id}:tool:${callId}`
    const turn = str(d.turnId) ?? this.currentTurn
    const key = turn ? `turn:${turn}` : `sys:${id}`
    const ev = this.base(id, ts, kind, 'running', this.toolTitle(kind, cls.displayName, name, tool.input, files), {
      tool,
      files,
      messageId: key,
      links: extractLinks(redactText(typeof args === 'string' ? args : compactJson(args, 4000)), LIMITS.linksPerEvent),
    })
    this.tools.set(callId, { callId, name, ev, args, linesAdded: null, linesRemoved: null })
    this.running.set(callId, ts)
    this.addEvent(
      ev,
      {
        kind,
        title: ev.title,
        text: null,
        input: this.boundedInput(args),
        metadata: { toolCallId: callId, toolName: name, model: model ?? null },
      },
      { key, role: 'assistant', model },
    )
  }

  private toolComplete(d: Obj, ts: number): void {
    const callId = str(d.toolCallId)
    if (!callId) return
    const rec = this.tools.get(callId)
    this.running.delete(callId)
    if (!rec) return
    const ev = rec.ev
    const ok = d.success !== false
    const result = d.result
    let full = ''
    if (typeof result === 'string') full = result
    else if (isObj(result)) full = str(result.detailedContent) ?? str(result.content) ?? compactJson(result, LIMITS.partDetailBytes)
    else if (result !== undefined && result !== null) full = compactJson(result, LIMITS.partDetailBytes)
    const clean = redactText(stripAnsi(full))
    const previewSrc = isObj(result) ? (str(result.content) ?? full) : full
    const preview = truncate(oneLine(redactText(stripAnsi(previewSrc))), LIMITS.toolOutputChars)
    let error: string | null = null
    if (!ok) {
      const er = d.error
      const msg = typeof er === 'string' ? er : isObj(er) ? (str(er.message) ?? compactJson(er, 400)) : null
      error = safe(msg ?? previewSrc ?? 'failed', LIMITS.summaryChars) || 'failed'
    }
    ev.status = ok ? 'completed' : 'error'
    ev.endTs = ts
    ev.rev = Math.max(ts, ev.rev + 1)
    ev.summary = preview.text || null
    ev.links = extractLinks(clean, LIMITS.linksPerEvent).concat(ev.links).filter((u, i, a) => a.indexOf(u) === i).slice(0, LIMITS.linksPerEvent)
    if (ev.tool) {
      ev.tool.output = preview.text || null
      ev.tool.error = error
      ev.tool.durationMs = Math.max(0, ts - ev.ts)
      ev.tool.truncated = ev.tool.truncated || preview.truncated
    }
    const tele = isObj(d.toolTelemetry) && isObj(d.toolTelemetry.metrics) ? d.toolTelemetry.metrics : null
    if (tele) {
      if (typeof tele.linesAdded === 'number') rec.linesAdded = tele.linesAdded
      if (typeof tele.linesRemoved === 'number') rec.linesRemoved = tele.linesRemoved
    }
    const det = this.details.get(ev.id)
    if (det) {
      const t = truncate(clean, LIMITS.partDetailBytes)
      det.output = t.text
      det.error = error
      det.truncated = t.truncated
      det.metadata = { ...(isObj(det.metadata) ? det.metadata : {}), success: ok, durationMs: ev.tool?.durationMs ?? null }
    }
    this.touched.add(ev.id)
  }

  private toolTitle(kind: ActivityKind, display: string, raw: string, input: string | null, files: string[]): string {
    if (kind === 'file-change' && files[0]) {
      const verb = raw === 'create' ? 'Created' : raw === 'apply_patch' ? 'Patched' : 'Edited'
      return clip(`${verb} ${files[0]}${files.length > 1 ? ` (+${files.length - 1})` : ''}`, LIMITS.titleChars)
    }
    return clip(input ? `${display} · ${oneLine(input)}` : display, LIMITS.titleChars)
  }

  private inputPreview(name: string, args: unknown): { text: string | null; truncated: boolean } {
    let raw: string | null = null
    if (typeof args === 'string') raw = args
    else if (isObj(args)) {
      raw =
        name === 'bash' || name.endsWith('_bash')
          ? (str(args.command) ?? null)
          : (str(args.pattern) ?? pathArg(args) ?? str(args.query) ?? str(args.url) ?? null)
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

  private argFiles(name: string, args: unknown): string[] {
    const cwd = this.ws?.cwd ?? this.startCwd
    const abs = (p: string) => (path.isAbsolute(p) || !cwd ? p : path.resolve(cwd, p))
    if (typeof args === 'string' && name === 'apply_patch') return patchFiles(args).map(abs)
    const p = pathArg(args)
    return p ? [abs(p)] : []
  }

  /* ───────────────────────── permissions ───────────────────────── */

  private permRequested(d: Obj, ts: number): void {
    const rid = str(d.requestId)
    if (!rid) return
    const pr = isObj(d.permissionRequest) ? d.permissionRequest : {}
    const toolCallId = str(pr.toolCallId)
    const toolName = (toolCallId && this.tools.get(toolCallId)?.name) || str(pr.toolName) || str(pr.kind) || 'tool'
    const label = safe(toolName, 80)
    this.pending.set(rid, { ts, label })
    const detail = str(pr.fullCommandText) ?? str(pr.intention) ?? str(pr.path) ?? str(pr.url) ?? null
    const id = `copilot:${this.id}:perm:${rid}`
    const key = this.currentTurn ? `turn:${this.currentTurn}` : `sys:${id}`
    this.addEvent(
      this.base(id, ts, 'permission', 'pending', `Permission requested · ${label}`, {
        summary: detail ? safe(detail, LIMITS.summaryChars) : null,
        messageId: key,
      }),
      { kind: 'permission', title: `Permission requested · ${label}`, text: detail ? truncate(redactText(detail), LIMITS.partDetailBytes).text : null, metadata: redactValue({ permissionKind: pr.kind, requestId: rid }) },
      { key, role: this.currentTurn ? 'assistant' : 'system', model: null },
    )
  }

  private permCompleted(d: Obj, ts: number): void {
    const rid = str(d.requestId)
    if (!rid) return
    const prev = this.pending.get(rid)
    this.pending.delete(rid)
    const ev = this.events.get(`copilot:${this.id}:perm:${rid}`)
    if (!ev) return
    const res = isObj(d.result) ? d.result : {}
    const kind = str(res.kind) ?? 'completed'
    const ok = /^approved/.test(kind)
    ev.status = ok ? 'completed' : 'error'
    ev.endTs = ts
    ev.rev = Math.max(ts, ev.rev + 1)
    ev.title = safe(`Permission ${ok ? 'approved' : 'denied'} · ${prev?.label ?? ev.title.replace('Permission requested · ', '')}`, LIMITS.titleChars)
    const det = this.details.get(ev.id)
    if (det) {
      det.title = ev.title
      det.metadata = { ...(isObj(det.metadata) ? det.metadata : {}), result: kind }
    }
    this.touched.add(ev.id)
  }

  /* ───────────────────────── plumbing ───────────────────────── */

  private base(
    id: string,
    ts: number,
    kind: ActivityKind,
    status: ActivityStatus | null,
    title: string,
    extra: Partial<ActivityEvent> & { messageId?: string } = {},
  ): ActivityEvent {
    return {
      id,
      rev: ts,
      harness: 'copilot',
      sessionId: this.id,
      rootId: this.id,
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
      source: 'copilot.events',
      detailRef: id,
    }
  }

  private group(key: string, role: Group['role'], ts: number, model: string | null): Group {
    let g = this.groups.get(key)
    if (!g) {
      g = { id: `copilot:${this.id}:${key}`, role, createdAt: ts, completedAt: null, model, error: null, finish: null, items: [] }
      this.groups.set(key, g)
    }
    if (model) g.model = model
    return g
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
      title: detail.title === ev.title ? ev.title : detail.title,
      text: detail.text ?? null,
      input: detail.input ?? null,
      output: detail.output ?? null,
      error: detail.error ?? null,
      metadata: detail.metadata ?? null,
      truncated: false,
    })
    if (isNew) this.group(grp.key, grp.role, ev.ts, grp.model).items.push(ev.id)
    this.touched.add(ev.id)
  }

  /* ───────────────────────── queries ───────────────────────── */

  state(): HarnessSession['transcriptState'] {
    if (this.pending.size > 0) return 'waiting'
    const turn = Math.max(this.startSeq, this.endSeq)
    if (this.errSeq > turn && this.errSeq > this.stopSeq) return 'error'
    if (this.startSeq > this.endSeq && this.startSeq > this.stopSeq && this.startSeq > this.errSeq) return 'working'
    return this.turnsEnded > 0 ? 'done' : 'unknown'
  }

  current(): CurrentActivity | null {
    if (this.state() !== 'working' && this.state() !== 'waiting') return null
    let latest: ToolRec | null = null
    for (const [cid, ts] of this.running) {
      const rec = this.tools.get(cid)
      if (rec && (!latest || ts >= latest.ev.ts)) latest = rec
    }
    if (latest) {
      return {
        kind: latest.ev.kind,
        label: latest.ev.tool?.displayName ?? latest.name,
        detail: latest.ev.tool?.input ?? null,
        since: latest.ev.ts,
        activityId: latest.ev.id,
      }
    }
    if (this.startSeq > this.endSeq) return { kind: 'thinking', label: 'Thinking', detail: null, since: this.lastTs, activityId: null }
    return null
  }

  toSession(): HarnessSession {
    const ws = this.ws
    const wsTitle = ws?.name && (ws.userNamed || ws.name.trim()) ? safe(ws.name, LIMITS.titleChars) : null
    const createdAt = (ws?.createdAt && parseTime(ws.createdAt)) || this.firstTs || this.fileMtimeMs
    const updatedAt = Math.max((ws?.updatedAt && parseTime(ws.updatedAt)) || 0, this.lastTs, this.fileMtimeMs)
    const modelId = this.lastModel ?? this.startModel
    const facts: Array<{ label: string; value: string }> = []
    if (this.version) facts.push({ label: 'Copilot version', value: this.version })
    if (this.shutdowns === 0 && this.checkpointAiu !== null) facts.push({ label: 'AI units so far', value: this.checkpointAiu.toFixed(2) })
    if (this.premium) facts.push({ label: 'Premium requests', value: this.premium })
    if (this.routed) facts.push({ label: 'Model routing', value: this.routed })
    facts.push(...this.shutdownFacts)
    if (this.shutdowns === 0) facts.push({ label: 'Token usage', value: 'reported when the session ends' })
    const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    for (const u of this.samples.values()) {
      tokens.input += u.tokens.input
      tokens.output += u.tokens.output
      tokens.reasoning += u.tokens.reasoning
      tokens.cacheRead += u.tokens.cacheRead
      tokens.cacheWrite += u.tokens.cacheWrite
    }
    return {
      id: this.id,
      harness: 'copilot',
      parentId: null,
      title: wsTitle || this.firstPrompt || 'Copilot session',
      agent: 'copilot',
      model: modelId ? { providerId: 'github-copilot', modelId } : null,
      directory: ws?.cwd ?? this.startCwd,
      createdAt,
      updatedAt,
      lastActivityAt: this.lastTs || null,
      archivedAt: null,
      tokens,
      cost: 0,
      spawn: null,
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
    const c: SessionCounters = { messages: 0, steps: this.turnsEnded, thinking: 0, tools: 0, toolErrors: 0, mcpCalls: 0, fileChanges: 0, filesTouched: 0, subagents: 0 }
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
        agent: g.role === 'assistant' ? 'copilot' : null,
        model: g.model ? { providerId: 'github-copilot', modelId: g.model } : null,
        createdAt: g.createdAt,
        completedAt: g.completedAt,
        tokens: null,
        cost: null,
        finish: g.finish,
        error: g.error,
        items,
      })
    }
    return out
  }

  fileChanges(): FileChange[] {
    const cwd = this.ws?.cwd ?? this.startCwd
    const out: FileChange[] = []
    for (const ev of this.sortedEvents()) {
      if (ev.kind !== 'file-change' || !ev.tool) continue
      const rec = ev.tool.callId ? this.tools.get(ev.tool.callId) : undefined
      const kind: FileChangeKind = ev.tool.category === 'write' ? 'create' : ev.tool.category === 'patch' ? 'patch' : 'edit'
      let add = rec?.linesAdded ?? null
      let del = rec?.linesRemoved ?? null
      if (add === null && rec && typeof rec.args === 'string') {
        const c = countPatch(rec.args)
        add = c.add
        del = c.del
      }
      for (const file of ev.files) {
        const rel = cwd && (file === cwd || file.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)) ? path.relative(cwd, file) : null
        out.push({
          id: ev.id,
          sessionId: this.id,
          rootId: this.id,
          harness: 'copilot',
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

  diff(activityId: string): FileDiff | null {
    const ev = this.events.get(activityId)
    if (!ev || ev.kind !== 'file-change' || !ev.tool?.callId) return null
    const rec = this.tools.get(ev.tool.callId)
    const file = ev.files[0] ?? ''
    const none = (note: string): FileDiff => ({ id: activityId, path: file, format: 'none', text: null, note, truncated: false })
    if (!rec) return none('No diff data recorded')
    const finish = (format: FileDiff['format'], text: string): FileDiff => {
      const t = truncate(redactText(text), LIMITS.diffBytes)
      return { id: activityId, path: file, format, text: t.text, note: null, truncated: t.truncated }
    }
    const a = rec.args
    if (rec.name === 'apply_patch' && typeof a === 'string') return finish('patch-text', a)
    if (isObj(a)) {
      if (rec.name === 'create' && typeof a.file_text === 'string') return finish('new-file', a.file_text)
      const oldS = typeof a.old_str === 'string' ? a.old_str : typeof a.old_string === 'string' ? a.old_string : null
      const newS = typeof a.new_str === 'string' ? a.new_str : typeof a.new_string === 'string' ? a.new_string : null
      if (oldS !== null && newS !== null) {
        const o = oldS.split('\n')
        const n = newS.split('\n')
        const body = [...o.map((l) => `-${l}`), ...n.map((l) => `+${l}`)].join('\n')
        return finish('unified', `--- a/${file}\n+++ b/${file}\n@@ -1,${o.length} +1,${n.length} @@\n${body}\n`)
      }
    }
    return none('No diff data recorded for this tool call')
  }

  part(id: string): PartDetail | null {
    return this.details.get(id) ?? null
  }
}
