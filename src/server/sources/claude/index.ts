/**
 * Claude Code adapter: `<claudeDir>/projects/<encoded-cwd>/<sessionId>.jsonl`, plus subagent
 * transcripts at `<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl` (see docs/data-sources.md §2b).
 */
import path from 'node:path'
import { LIMITS, type TokenUsage } from '../../../shared/contract.js'
import type { HarnessSource, SourceDeps } from '../../types.js'
import type { ToolClassifier } from '../../lib/tool-classify.js'
import { createJsonlSource, type JsonlLayout, type JsonlRef, type JsonlSourceOptions } from '../jsonl/source.js'
import { TranscriptModel, isObj, num, str, type Obj } from '../jsonl/model.js'

const CLAUDE_OPTS = { harness: 'claude', agent: 'claude', providerId: 'anthropic', source: 'claude.jsonl', untitled: 'Claude Code session' } as const

/** Strip Claude Code's injected wrappers from user text; null = not a human prompt. */
export function cleanClaudePrompt(text: string): string | null {
  let t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!t) return null
  if (/^<local-command-(stdout|stderr|caveat)>/.test(t) || t.startsWith('Caveat: The messages below')) return null
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t)
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim()
    const name = cmd[1]!.trim()
    return `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`
  }
  t = t.replace(/<\/?command-(message|args)>/g, '').trim()
  return t || null
}

export class ClaudeModel extends TranscriptModel {
  private customTitle: string | null = null
  private aiTitle: string | null = null
  private summary: string | null = null
  private readonly usageByMessage = new Map<string, TokenUsage>()

  constructor(
    id: string,
    classifier: ToolClassifier,
    private readonly isSubagent: boolean,
  ) {
    super(id, classifier, { ...CLAUDE_OPTS, agent: isSubagent ? 'subagent' : 'claude' })
  }

  protected apply(l: Obj): void {
    const type = str(l.type)
    if (!type) return
    // Older Claude Code versions interleaved subagent (sidechain) lines into the parent file.
    if (!this.isSubagent && l.isSidechain === true) return
    const cwd = str(l.cwd)
    if (cwd) this.cwd = cwd
    const v = str(l.version)
    if (v) {
      this.version = v
      this.facts.set('Claude Code version', v)
    }
    const branch = str(l.gitBranch)
    if (branch && branch !== 'HEAD') this.facts.set('Branch', branch)
    switch (type) {
      case 'summary':
        this.summary = str(l.summary) ?? this.summary
        break
      case 'custom-title':
        this.customTitle = str(l.customTitle) ?? this.customTitle
        break
      case 'ai-title':
        this.aiTitle = str(l.aiTitle) ?? this.aiTitle
        break
      case 'user':
        this.user(l)
        break
      case 'assistant':
        this.assistant(l)
        break
      case 'system':
        this.system(l)
        break
      default:
        return
    }
    this.title = this.customTitle ?? this.aiTitle ?? this.summary
  }

  private user(l: Obj): void {
    const ts = this.stamp(l.timestamp)
    if (l.isMeta === true) return
    const msg = isObj(l.message) ? l.message : null
    const content = msg ? msg.content : null
    const uuid = str(l.uuid)
    const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    const result = isObj(l.toolUseResult) ? l.toolUseResult : null
    let prompted = false
    blocks.forEach((b, i) => {
      if (!isObj(b)) return
      const bt = str(b.type)
      if (bt === 'tool_result') {
        const callId = str(b.tool_use_id)
        if (!callId) return
        const rec = this.endTool({ callId, ts, ok: b.is_error !== true, output: b.content, error: b.is_error === true ? (typeof b.content === 'string' ? b.content : null) : null })
        if (rec && result) {
          const patch = Array.isArray(result.structuredPatch) ? result.structuredPatch : null
          if (patch && patch.length) {
            const file = rec.ev.files[0] ?? str(result.filePath) ?? ''
            const lines: string[] = [`--- a/${file}`, `+++ b/${file}`]
            let add = 0
            let del = 0
            for (const h of patch) {
              if (!isObj(h) || !Array.isArray(h.lines)) continue
              lines.push(`@@ -${num(h.oldStart) ?? 0},${num(h.oldLines) ?? 0} +${num(h.newStart) ?? 0},${num(h.newLines) ?? 0} @@`)
              for (const ln of h.lines) {
                if (typeof ln !== 'string') continue
                lines.push(ln)
                if (ln.startsWith('+')) add++
                else if (ln.startsWith('-')) del++
              }
            }
            rec.resultDiff = { format: 'unified', text: `${lines.join('\n')}\n` }
            rec.linesAdded = add
            rec.linesRemoved = del
          }
          if (str(result.type) === 'create' && rec.category === 'write') rec.fileKind = 'create'
          const agentId = str(result.agentId)
          if (agentId && rec.ev.kind === 'subagent') rec.childId = `${this.parentId ?? this.id}.agent-${agentId}`
        }
        return
      }
      if (bt !== 'text') return
      const raw = str(b.text)
      if (!raw) return
      if (/^\[Request interrupted by user/.test(raw.trim())) {
        this.settleTools(ts, false)
        this.addError(uuid ? `${uuid}.${i}` : null, ts, 'Interrupted', 'Request interrupted by user')
        this.turnState = 'done'
        this.currentGroup = null
        return
      }
      const text = cleanClaudePrompt(raw)
      if (!text) return
      this.addPrompt(uuid ? `${uuid}.${i}` : null, ts, text, { group: `user:${uuid ?? this.seq}` })
      prompted = true
    })
    if (prompted) {
      this.turnState = 'working'
      this.currentGroup = null
    }
  }

  private assistant(l: Obj): void {
    const ts = this.stamp(l.timestamp)
    const msg = isObj(l.message) ? l.message : {}
    const uuid = str(l.uuid) ?? `l${this.seq}`
    const model = str(msg.model)
    const realModel = model && model !== '<synthetic>' ? model : null
    if (realModel) this.modelId = realModel
    const key = `msg:${str(msg.id) ?? uuid}`
    this.currentGroup = key
    const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []
    if (l.isApiErrorMessage === true) {
      const text = content.map((b) => (isObj(b) ? (str(b.text) ?? '') : '')).join('\n') || 'API error'
      this.addError(uuid, ts, 'API error', text, { group: key })
      this.turnState = 'error'
      return
    }
    let toolUse = false
    content.forEach((b, i) => {
      if (!isObj(b)) return
      const native = `${uuid}.${i}`
      switch (str(b.type)) {
        case 'text':
          this.addText(native, ts, str(b.text) ?? '', { group: key, model: realModel })
          break
        case 'thinking':
          // `signature` is opaque and never read; redacted_thinking blocks are skipped.
          this.addThinking(native, ts, str(b.thinking) ?? '', { group: key, model: realModel })
          break
        case 'tool_use': {
          const callId = str(b.id) ?? native
          const name = str(b.name) ?? 'tool'
          this.startTool({ callId, name, args: b.input, ts, group: key, model: realModel })
          toolUse = true
          break
        }
      }
    })
    const u = isObj(msg.usage) ? msg.usage : null
    if (u) {
      const tokens: TokenUsage = {
        input: num(u.input_tokens) ?? 0,
        output: num(u.output_tokens) ?? 0,
        reasoning: 0,
        cacheRead: num(u.cache_read_input_tokens) ?? 0,
        cacheWrite: num(u.cache_creation_input_tokens) ?? 0,
      }
      const mid = str(msg.id) ?? uuid
      if (!this.usageByMessage.has(mid)) this.steps++
      this.usageByMessage.set(mid, tokens)
      this.groupTokens(key, tokens)
      const total: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
      for (const t of this.usageByMessage.values()) {
        total.input += t.input
        total.output += t.output
        total.cacheRead += t.cacheRead
        total.cacheWrite += t.cacheWrite
      }
      this.tokens = total
    }
    const stop = str(msg.stop_reason)
    if (toolUse || stop === 'tool_use' || this.hasRunningTools()) this.turnState = 'working'
    else {
      // end_turn / stop_sequence / max_tokens — and null on the last streamed block of a reply.
      this.turnState = 'done'
      this.completeGroup(key, ts, stop ?? 'stop')
    }
  }

  private system(l: Obj): void {
    const ts = this.stamp(l.timestamp)
    const sub = str(l.subtype)
    if (sub === 'turn_duration' || sub === 'stop_hook_summary') {
      if (!this.hasRunningTools() && this.turnState === 'working') this.turnState = 'done'
      return
    }
    if (sub === 'compact_boundary') {
      this.facts.set('Compacted', 'yes')
      return
    }
    if (str(l.level) === 'error') {
      const text = str(l.content) ?? 'Error'
      this.addError(str(l.uuid), ts, 'Error', text.slice(0, LIMITS.partDetailBytes))
    }
  }
}

export interface ClaudeSourceOptions extends JsonlSourceOptions {}

export function claudeLayout(claudeDir: string | null): JsonlLayout {
  const root = claudeDir ? path.join(claudeDir, 'projects') : null
  return {
    id: 'claude',
    harness: 'claude',
    label: 'Claude Code',
    root,
    disabledDetail: 'Claude Code directory not configured',
    missingDetail: 'projects directory not found',
    discover(ls) {
      const out: JsonlRef[] = []
      if (!root) return out
      for (const proj of ls(root) ?? []) {
        if (!proj.isDir) continue
        const pdir = path.join(root, proj.name)
        const items = ls(pdir) ?? []
        for (const it of items) {
          if (it.isFile && it.name.endsWith('.jsonl')) out.push({ id: it.name.slice(0, -'.jsonl'.length), file: path.join(pdir, it.name), parentId: null })
        }
        for (const it of items) {
          if (!it.isDir) continue
          const subs = ls(path.join(pdir, it.name, 'subagents'))
          if (!subs) continue
          for (const f of subs) {
            if (f.isFile && f.name.endsWith('.jsonl')) {
              out.push({ id: `${it.name}.${f.name.slice(0, -'.jsonl'.length)}`, file: path.join(pdir, it.name, 'subagents', f.name), parentId: it.name })
            }
          }
        }
      }
      return out
    },
    createModel(ref, classifier) {
      return new ClaudeModel(ref.id, classifier, ref.parentId !== null)
    },
  }
}

export function createClaudeSource(deps: SourceDeps, options: ClaudeSourceOptions = {}): HarnessSource {
  return createJsonlSource(deps, claudeLayout(deps.config.claudeDir ?? null), options)
}
