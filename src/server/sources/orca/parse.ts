import type { OrcaStatus, TerminalInfo, WorktreeInfo, WorktreeLinkRef } from '../../../shared/contract.js'
import { redactText } from '../../lib/redact.js'
import { clip, stripAnsi } from '../../lib/text.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export interface Parsed<T> {
  value: T
  warnings: number
  error: string | null
}

/** Unwrap `{ok,result,error}`. Returns the result object or an error message. */
export function parseEnvelope(text: string): { result: Obj; error: null } | { result: null; error: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { result: null, error: 'invalid JSON from orca CLI' }
  }
  if (!isObj(json)) return { result: null, error: 'unexpected orca CLI output' }
  if (json.ok === false) {
    const e = json.error
    const msg = isObj(e) ? str(e.message) : str(e)
    return { result: null, error: msg ?? 'orca CLI reported an error' }
  }
  return { result: isObj(json.result) ? json.result : {}, error: null }
}

export function parseStatus(json: string, now: number): OrcaStatus {
  const env = parseEnvelope(json)
  if (env.error !== null) {
    return { running: false, reachable: false, pid: null, version: null, runtimeState: null, checkedAt: now, error: env.error }
  }
  const app = isObj(env.result.app) ? env.result.app : {}
  const rt = isObj(env.result.runtime) ? env.result.runtime : {}
  return {
    running: app.running === true,
    reachable: rt.reachable === true,
    pid: num(app.pid),
    version: str(rt.appVersion),
    runtimeState: str(rt.state),
    checkedAt: now,
    error: null,
  }
}

function linkRef(kind: WorktreeLinkRef['kind'], v: unknown): WorktreeLinkRef | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return { kind, label: `#${v}`, url: null }
  if (typeof v === 'string') return v ? { kind, label: v, url: /^https?:\/\//.test(v) ? v : null } : null
  if (!isObj(v)) return null
  const url = str(v.url)
  const number = num(v.number)
  const label =
    str(v.identifier) ?? (number !== null ? `#${number}` : null) ?? str(v.title) ?? (url ? url.split('/').slice(-2).join('/') : null)
  if (!label && !url) return null
  return { kind, label: label ?? url ?? '', url }
}

function collectLinks(w: Obj): WorktreeLinkRef[] {
  const out: WorktreeLinkRef[] = []
  const seen = new Set<string>()
  const add = (r: WorktreeLinkRef | null) => {
    if (!r) return
    const key = r.url ?? `${r.kind}:${r.label}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(r)
  }
  add(linkRef('pr', w.linkedPR))
  add(linkRef('issue', w.linkedIssue))
  add(linkRef('pr', w.linkedGitLabMR))
  add(linkRef('issue', w.linkedGitLabIssue))
  add(linkRef('issue', w.linkedLinearIssue))
  if (Array.isArray(w.linkedItems)) {
    for (const it of w.linkedItems) {
      if (!isObj(it)) continue
      const t = str(it.type)
      const kind: WorktreeLinkRef['kind'] = t === 'pr' || t === 'mr' ? 'pr' : t === 'issue' ? 'issue' : 'other'
      add(linkRef(kind, it))
    }
  }
  return out
}

export function parseWorktrees(json: string): Parsed<WorktreeInfo[]> {
  const env = parseEnvelope(json)
  if (env.error !== null) return { value: [], warnings: 0, error: env.error }
  const list = env.result.worktrees
  if (!Array.isArray(list)) return { value: [], warnings: 1, error: null }
  let warnings = 0
  const value: WorktreeInfo[] = []
  for (const w of list) {
    if (!isObj(w)) {
      warnings++
      continue
    }
    const id = str(w.worktreeId) ?? str(w.id)
    const path = str(w.path)
    if (!id && !path) {
      warnings++
      continue
    }
    const branch = str(w.branch)
    value.push({
      id: id ?? path ?? '',
      repoId: str(w.repoId),
      repo: str(w.repo),
      path: path ?? '',
      branch: branch ? branch.replace(/^refs\/heads\//, '') : null,
      displayName: str(w.displayName),
      status: str(w.status),
      workspaceStatus: str(w.workspaceStatus),
      isActive: w.isActive === true,
      isMainWorktree: w.isMainWorktree === true,
      liveTerminalCount: num(w.liveTerminalCount) ?? 0,
      lastActivityAt: num(w.lastActivityAt),
      lastOutputAt: num(w.lastOutputAt),
      links: collectLinks(w),
    })
  }
  return { value, warnings, error: null }
}

export function parseTerminals(json: string): Parsed<TerminalInfo[]> {
  const env = parseEnvelope(json)
  if (env.error !== null) return { value: [], warnings: 0, error: env.error }
  const list = env.result.terminals
  if (!Array.isArray(list)) return { value: [], warnings: 1, error: null }
  let warnings = 0
  const value: TerminalInfo[] = []
  for (const t of list) {
    const handle = isObj(t) ? str(t.handle) : null
    if (!isObj(t) || !handle) {
      warnings++
      continue
    }
    const tabId = str(t.tabId)
    const leafId = str(t.leafId)
    const preview = typeof t.preview === 'string' ? t.preview : null
    value.push({
      handle,
      worktreeId: str(t.worktreeId),
      worktreePath: str(t.worktreePath),
      tabId,
      leafId,
      paneKey: tabId && leafId ? `${tabId}:${leafId}` : null,
      title: str(t.title),
      agentIdentity: str(t.agentIdentity),
      connected: t.connected === true,
      lastOutputAt: num(t.lastOutputAt),
      preview: preview === null ? null : clip(redactText(stripAnsi(preview)), 300),
      sessionId: null,
    })
  }
  return { value, warnings, error: null }
}
