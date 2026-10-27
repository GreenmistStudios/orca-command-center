import { readFileSync } from 'node:fs'
import type { ActivityEvent, Harness, HookEntry, SourceHealth } from '../../../shared/contract.js'
import type { OrcaHooksSource, OrcaHooksUpdate, SourceDeps } from '../../types.js'
import { watchPath, type Watcher } from '../../lib/fs-watch.js'
import { redactText } from '../../lib/redact.js'
import { clip } from '../../lib/text.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown): string | null => {
  const s = str(v)
  return s === null ? null : clip(redactText(s), 280)
}

export function mapEntry(paneKeyFallback: string, raw: unknown): HookEntry | null {
  if (!isObj(raw)) return null
  const presence = isObj(raw.agentPresence) ? raw.agentPresence : {}
  const payload = isObj(raw.payload) ? raw.payload : {}
  const session = isObj(raw.providerSession) ? raw.providerSession : {}
  return {
    paneKey: str(raw.paneKey) ?? paneKeyFallback,
    tabId: str(raw.tabId),
    worktreeId: str(raw.worktreeId),
    agent: str(presence.agent) ?? str(raw.source),
    hookEvent: str(raw.hookEventName),
    state: str(payload.state),
    prompt: text(payload.prompt),
    lastAssistantMessage: text(payload.lastAssistantMessage),
    providerSessionId: str(session.id),
    receivedAt: num(raw.receivedAt),
    stateStartedAt: num(raw.stateStartedAt),
  }
}

function harnessOf(agent: string | null): Harness {
  const a = (agent ?? '').toLowerCase()
  if (a.includes('opencode')) return 'opencode'
  if (a.includes('copilot')) return 'copilot'
  if (a.includes('claude')) return 'claude'
  if (a.includes('codex')) return 'codex'
  if (a.includes('cursor')) return 'cursor'
  return 'unknown'
}

function titleOf(e: HookEntry): string {
  const key = `${e.hookEvent ?? ''}|${e.state ?? ''}`
  switch (key) {
    case 'SessionBusy|working':
      return 'Started working'
    case 'SessionIdle|done':
      return 'Finished turn'
    case 'PermissionRequest|blocked':
      return 'Permission requested'
    case 'AskUserQuestion|waiting':
      return 'Asked a question'
  }
  if (e.hookEvent === 'UserPromptSubmit') return 'Prompt submitted'
  return `${e.hookEvent ?? 'event'} · ${e.state ?? 'unknown'}`
}

function toEvent(e: HookEntry): ActivityEvent {
  const ts = e.receivedAt ?? 0
  const busy = e.state === 'working' || e.hookEvent === 'UserPromptSubmit' || e.hookEvent === 'SessionBusy'
  return {
    id: `orca-hook:${e.paneKey}:${ts}`,
    rev: ts,
    harness: harnessOf(e.agent),
    sessionId: e.providerSessionId,
    rootId: e.providerSessionId,
    messageId: null,
    ts,
    endTs: null,
    kind: e.hookEvent === 'PermissionRequest' ? 'permission' : 'state',
    status: null,
    title: titleOf(e),
    summary: busy ? e.prompt : e.lastAssistantMessage,
    tool: null,
    files: [],
    childSessionId: null,
    usage: null,
    links: [],
    source: 'orca.hooks',
    detailRef: null,
  }
}

const entryKey = (e: HookEntry) => `${e.hookEvent}|${e.state}|${e.receivedAt}`

export function createOrcaHooksSource(deps: SourceDeps): OrcaHooksSource {
  const { config, log, now } = deps
  const file = config.hooksFile
  let entries: HookEntry[] = []
  let healthStatus: SourceHealth['status'] = file === null ? 'disabled' : 'starting'
  let detailNote: string | null = file === null ? 'hooks file not found' : null
  let baseline = false
  let lastReadAt: number | null = null
  let lastChangeAt: number | null = null
  let lastWarnAt = 0
  let watcher: Watcher | null = null
  const listeners = new Set<(u: OrcaHooksUpdate) => void>()

  function warnOnce(msg: string) {
    const t = now()
    if (t - lastWarnAt >= 60_000) {
      lastWarnAt = t
      log.warn(msg)
    }
  }

  function read() {
    if (file === null) return
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        healthStatus = 'missing'
        detailNote = 'hooks file not found'
      } else {
        healthStatus = 'error'
        detailNote = String((e as Error).message)
        warnOnce(`orca-hooks read failed: ${detailNote}`)
      }
      return
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      warnOnce('orca-hooks: malformed hooks file (partial write?), keeping previous entries')
      return
    }
    lastReadAt = now()
    if (!isObj(json)) return
    if (json.version === 2) {
      healthStatus = 'ok'
      detailNote = null
    } else {
      healthStatus = 'degraded'
      detailNote = `hook file version ${String(json.version)}, expected 2`
    }
    const next: HookEntry[] = []
    if (isObj(json.entries)) {
      for (const [k, v] of Object.entries(json.entries)) {
        const m = mapEntry(k, v)
        if (m) next.push(m)
      }
    }
    const prev = new Map(entries.map((e) => [e.paneKey, entryKey(e)]))
    const transitions: ActivityEvent[] = []
    if (baseline) {
      for (const e of next) {
        if (e.receivedAt === null) continue
        if (prev.get(e.paneKey) !== entryKey(e)) transitions.push(toEvent(e))
      }
    }
    const changed = !baseline || transitions.length > 0 || JSON.stringify(next) !== JSON.stringify(entries)
    baseline = true
    entries = next
    if (changed) {
      lastChangeAt = now()
      const update: OrcaHooksUpdate = { type: 'hooks', entries, transitions }
      for (const l of [...listeners]) {
        try {
          l(update)
        } catch (e) {
          log.warn('orca-hooks listener failed', e)
        }
      }
    }
  }

  return {
    id: 'orca-hooks',
    async start() {
      if (file === null || watcher) return
      baseline = false
      read()
      watcher = watchPath(file, read, { debounceMs: 100, pollMs: 2000, log })
    },
    async stop() {
      watcher?.close()
      watcher = null
      listeners.clear()
    },
    health(): SourceHealth {
      return {
        id: 'orca-hooks',
        label: 'Orca hooks',
        status: healthStatus,
        path: file,
        version: 'v2',
        detail:
          detailNote ?? `${entries.length} panes · ${entries.filter((e) => e.state === 'working').length} working`,
        lastReadAt,
        lastChangeAt,
      }
    },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    entries: () => entries,
  }
}
