/**
 * Cursor adapter: agent transcripts at `<cursorDir>/projects/<slug>/agent-transcripts/<chatId>.jsonl`
 * (or `<chatId>/<chatId>.jsonl`), with optional chat metadata at `<cursorDir>/chats/<hash>/<chatId>/meta.json`
 * (see docs/data-sources.md §2d). Lines carry `{role, message: {content: [blocks]}}` and usually no
 * timestamp, so the file mtime stands in for time.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { HarnessSource, SourceDeps } from '../../types.js'
import type { ToolClassifier } from '../../lib/tool-classify.js'
import { createJsonlSource, type JsonlLayout, type JsonlRef, type JsonlSourceOptions, type Lister } from '../jsonl/source.js'
import { TranscriptModel, isObj, str, textOf, type Obj } from '../jsonl/model.js'

const CURSOR_OPTS = { harness: 'cursor', agent: 'cursor', providerId: null, source: 'cursor.transcript', untitled: 'Cursor chat' } as const

/** The user's request without Cursor's injected context wrappers; null = nothing human-written. */
export function cleanCursorPrompt(text: string): string | null {
  const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(text)
  let t = q ? q[1]! : text
  t = t.replace(/<(system_reminder|system-reminder|user_info|attached_files|additional_data|rules|project_layout)>[\s\S]*?<\/\1>/g, '').trim()
  return t || null
}

export class CursorModel extends TranscriptModel {
  constructor(id: string, classifier: ToolClassifier) {
    super(id, classifier, CURSOR_OPTS)
  }

  protected apply(l: Obj): void {
    const role = str(l.role) ?? str(l.type)
    if (!role) return
    const ts = this.stamp(l.timestamp ?? l.createdAt ?? l.time)
    const msg = isObj(l.message) ? l.message : null
    const content = msg && 'content' in msg ? msg.content : l.content
    const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    const model = (msg && str(msg.model)) ?? str(l.model)
    if (model) this.modelId = model
    const native = (i: number) => `l${String(this.seq).padStart(7, '0')}.${i}`

    if (role === 'user' || role === 'tool') {
      let prompted = false
      blocks.forEach((b, i) => {
        if (!isObj(b)) return
        const bt = str(b.type)
        if (bt === 'tool_result') {
          const callId = str(b.tool_use_id) ?? str(b.toolCallId)
          if (callId) this.endTool({ callId, ts, ok: b.is_error !== true, output: b.content })
          return
        }
        if (role === 'tool' || (bt && bt !== 'text')) return
        const text = cleanCursorPrompt(str(b.text) ?? '')
        if (!text) return
        if (!prompted) {
          this.settleTools(ts)
          this.currentGroup = null
        }
        this.addPrompt(native(i), ts, text, { group: `user:${this.seq}` })
        prompted = true
      })
      if (prompted) this.turnState = 'working'
      return
    }
    if (role !== 'assistant') return
    if (!this.currentGroup) this.currentGroup = `turn:${this.seq}`
    const key = this.currentGroup
    let toolUse = false
    let text = false
    blocks.forEach((b, i) => {
      if (!isObj(b)) return
      switch (str(b.type)) {
        case 'text': {
          const s = str(b.text) ?? ''
          if (s.trim()) text = true
          this.addText(native(i), ts, s, { group: key, model: this.modelId })
          break
        }
        case 'thinking':
        case 'reasoning':
          this.addThinking(native(i), ts, str(b.thinking) ?? str(b.text) ?? textOf(b.summary), { group: key, model: this.modelId })
          break
        case 'tool_use':
        case 'tool_call': {
          const callId = str(b.id) ?? str(b.toolCallId) ?? native(i)
          this.startTool({ callId, name: str(b.name) ?? 'tool', args: b.input ?? b.args ?? b.arguments, ts, group: key, model: this.modelId })
          toolUse = true
          break
        }
      }
    })
    if (toolUse) this.turnState = 'working'
    else if (text) {
      // A text-only reply: Cursor does not always log tool results, so close what is still open.
      this.settleTools(ts)
      this.turnState = 'done'
      this.completeGroup(key, ts, 'stop')
      this.steps++
    }
  }
}

/**
 * Decode a Cursor project slug (`Users-me-src-my-app`) back to a directory by probing the
 * filesystem: '-' is ambiguous between '/' and a literal dash (or '.', '_'). Bounded search.
 */
export function decodeCursorSlug(slug: string, exists: (p: string) => boolean = defaultIsDir): string | null {
  const parts = slug.split('-').filter((p) => p !== '')
  if (!parts.length) return null
  let budget = 4000
  const walk = (base: string, i: number): string | null => {
    if (i >= parts.length) return base
    for (let j = i + 1; j <= parts.length; j++) {
      if (--budget < 0) return null
      const segs = parts.slice(i, j)
      for (const sep of ['-', '.', '_', ' ']) {
        if (segs.length === 1 && sep !== '-') continue
        const cand = `${base}/${segs.join(sep)}`
        if (exists(cand)) {
          const r = walk(cand, j)
          if (r) return r
        }
      }
    }
    return null
  }
  return walk('', 0)
}

function defaultIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

interface ChatMeta {
  title: string | null
  cwd: string | null
  createdAtMs: number | null
  model: string | null
}

export interface CursorSourceOptions extends JsonlSourceOptions {}

export function cursorLayout(cursorDir: string | null): JsonlLayout {
  const root = cursorDir ? path.join(cursorDir, 'projects') : null
  const chatsDir = cursorDir ? path.join(cursorDir, 'chats') : null
  const slugOf = new Map<string, string>()
  const slugDir = new Map<string, string | null>()
  let lsRef: Lister | null = null
  const metaCache = new Map<string, { sig: string; meta: ChatMeta | null }>()

  /** chats/<hash>/<chatId>/meta.json, located through the cached lister. */
  function metaPath(chatId: string): string | null {
    if (!chatsDir || !lsRef) return null
    for (const h of lsRef(chatsDir) ?? []) {
      if (!h.isDir) continue
      const items = lsRef(path.join(chatsDir, h.name))
      if (items?.some((i) => i.isDir && i.name === chatId)) return path.join(chatsDir, h.name, chatId, 'meta.json')
    }
    return null
  }

  function readMeta(chatId: string): ChatMeta | null {
    const p = metaPath(chatId)
    if (!p) return null
    try {
      const st = statSync(p)
      const sig = `${st.size}:${st.mtimeMs}`
      const hit = metaCache.get(chatId)
      if (hit && hit.sig === sig) return hit.meta
      let meta: ChatMeta | null = null
      if (st.size < 1024 * 1024) {
        const o: unknown = JSON.parse(readFileSync(p, 'utf8'))
        if (isObj(o)) {
          const created = typeof o.createdAtMs === 'number' ? o.createdAtMs : typeof o.createdAt === 'number' ? o.createdAt : null
          meta = { title: str(o.title) ?? str(o.name), cwd: str(o.cwd) ?? str(o.workspaceRoot), createdAtMs: created, model: str(o.model) ?? str(o.lastUsedModel) }
        }
      }
      metaCache.set(chatId, { sig, meta })
      return meta
    } catch {
      return null
    }
  }

  return {
    id: 'cursor',
    harness: 'cursor',
    label: 'Cursor',
    root,
    disabledDetail: 'Cursor directory not configured',
    missingDetail: 'projects directory not found',
    discover(ls) {
      lsRef = ls
      const out: JsonlRef[] = []
      if (!root) return out
      for (const proj of ls(root) ?? []) {
        if (!proj.isDir) continue
        const tdir = path.join(root, proj.name, 'agent-transcripts')
        for (const it of ls(tdir) ?? []) {
          let ref: JsonlRef | null = null
          if (it.isFile && it.name.endsWith('.jsonl')) ref = { id: it.name.slice(0, -'.jsonl'.length), file: path.join(tdir, it.name), parentId: null }
          else if (it.isDir && (ls(path.join(tdir, it.name)) ?? []).some((f) => f.isFile && f.name === `${it.name}.jsonl`)) {
            ref = { id: it.name, file: path.join(tdir, it.name, `${it.name}.jsonl`), parentId: null }
          }
          if (!ref) continue
          slugOf.set(ref.id, proj.name)
          out.push(ref)
        }
      }
      return out
    },
    createModel(ref, classifier) {
      return new CursorModel(ref.id, classifier)
    },
    refresh(ref, model) {
      const before = JSON.stringify([model.title, model.cwd, model.createdAtHint, model.modelId])
      const meta = readMeta(ref.id)
      if (meta?.title) model.title = meta.title
      if (meta?.model && !model.modelId) model.modelId = meta.model
      if (!model.createdAtHint) {
        let created = meta?.createdAtMs ?? null
        if (!created) {
          try {
            created = statSync(ref.file).birthtimeMs || null
          } catch {
            /* ignore */
          }
        }
        model.createdAtHint = created
      }
      if (meta?.cwd) model.cwd = meta.cwd
      else if (!model.cwd) {
        const slug = slugOf.get(ref.id)
        if (slug) {
          if (!slugDir.has(slug)) slugDir.set(slug, decodeCursorSlug(slug))
          model.cwd = slugDir.get(slug) ?? null
        }
      }
      return JSON.stringify([model.title, model.cwd, model.createdAtHint, model.modelId]) !== before
    },
  }
}

export function createCursorSource(deps: SourceDeps, options: CursorSourceOptions = {}): HarnessSource {
  return createJsonlSource(deps, cursorLayout(deps.config.cursorDir ?? null), options)
}
