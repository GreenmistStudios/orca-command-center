import path from 'node:path'
import type {
  HookEntry,
  OrcaLink,
  OrchDispatch,
  OrchRun,
  OrchRunDetail,
  TerminalInfo,
  WorkspaceRef,
  WorktreeInfo,
} from '../../shared/contract.js'

export function normalizeDir(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return n === '' ? '/' : n
}

export function baseName(p: string): string {
  const n = normalizeDir(p)
  return n.slice(n.lastIndexOf('/') + 1) || n
}

function isPrefixDir(prefix: string, dir: string): boolean {
  const a = normalizeDir(prefix)
  const b = normalizeDir(dir)
  return b === a || b.startsWith(a === '/' ? '/' : a + '/')
}

export interface JoinInput {
  hooks: HookEntry[]
  terminals: TerminalInfo[]
  worktrees: WorktreeInfo[]
  runs: OrchRunDetail[]
  summaryRuns: OrchRun[]
}

export interface RoleInfo {
  role: 'coordinator' | 'worker'
  runId: string
  taskId: string | null
  dispatchId: string | null
}

/** Indexes over the Orca-side facts (data-sources §6). Rebuilt whenever any input changes. */
export class JoinIndex {
  readonly hookBySession = new Map<string, HookEntry>()
  readonly hookByPane = new Map<string, HookEntry>()
  readonly terminalByPane = new Map<string, TerminalInfo>()
  readonly terminalByHandle = new Map<string, TerminalInfo>()
  readonly worktreeById = new Map<string, WorktreeInfo>()
  private readonly worktreesByPathLen: WorktreeInfo[]
  /** terminal handle → session id (via hooks). */
  readonly sessionByHandle = new Map<string, string>()
  readonly handleBySession = new Map<string, string>()
  readonly coordinatorByHandle = new Map<string, OrchRun>()
  readonly dispatchByHandle = new Map<string, OrchDispatch>()

  constructor(input: JoinInput) {
    for (const h of input.hooks) {
      this.hookByPane.set(h.paneKey, h)
      if (!h.providerSessionId) continue
      const prev = this.hookBySession.get(h.providerSessionId)
      if (!prev || (h.receivedAt ?? 0) >= (prev.receivedAt ?? 0)) this.hookBySession.set(h.providerSessionId, h)
    }
    for (const t of input.terminals) {
      this.terminalByHandle.set(t.handle, t)
      if (t.paneKey) this.terminalByPane.set(t.paneKey, t)
    }
    for (const w of input.worktrees) this.worktreeById.set(w.id, w)
    this.worktreesByPathLen = input.worktrees.filter((w) => w.path).sort((a, b) => b.path.length - a.path.length)
    for (const t of input.terminals) {
      const hook = t.paneKey ? this.hookByPane.get(t.paneKey) : undefined
      if (hook?.providerSessionId) {
        this.sessionByHandle.set(t.handle, hook.providerSessionId)
        this.handleBySession.set(hook.providerSessionId, t.handle)
      }
    }
    for (const r of input.summaryRuns) if (r.coordinatorHandle) this.coordinatorByHandle.set(r.coordinatorHandle, r)
    for (const d of input.runs) {
      for (const disp of d.dispatches) {
        if (!disp.assigneeHandle) continue
        const prev = this.dispatchByHandle.get(disp.assigneeHandle)
        if (!prev || (disp.dispatchedAt ?? 0) >= (prev.dispatchedAt ?? 0)) this.dispatchByHandle.set(disp.assigneeHandle, disp)
      }
    }
  }

  terminalsWithSessions(terminals: TerminalInfo[]): TerminalInfo[] {
    return terminals.map((t) => {
      const sessionId = this.sessionByHandle.get(t.handle) ?? null
      return t.sessionId === sessionId ? t : { ...t, sessionId }
    })
  }

  terminalOfSession(sessionId: string): TerminalInfo | null {
    const hook = this.hookBySession.get(sessionId)
    if (!hook) return null
    return this.terminalByPane.get(hook.paneKey) ?? null
  }

  roleOf(sessionId: string): RoleInfo | null {
    const handle = this.terminalOfSession(sessionId)?.handle
    if (!handle) return null
    const run = this.coordinatorByHandle.get(handle)
    if (run) return { role: 'coordinator', runId: run.id, taskId: null, dispatchId: null }
    const disp = this.dispatchByHandle.get(handle)
    if (disp) return { role: 'worker', runId: disp.runId, taskId: disp.taskId, dispatchId: disp.id }
    return null
  }

  /** Worker dispatch for a session (only meaningful when it has no hook state). */
  dispatchOf(sessionId: string): OrchDispatch | null {
    const handle = this.terminalOfSession(sessionId)?.handle
    return handle ? (this.dispatchByHandle.get(handle) ?? null) : null
  }

  worktreeRef(w: WorktreeInfo): WorkspaceRef {
    return {
      key: w.id,
      name: w.displayName || baseName(w.path) || w.id,
      path: w.path,
      repo: w.repo,
      branch: w.branch,
    }
  }

  /** Workspace for a worktree id, even when the CLI snapshot does not (yet) list it. */
  workspaceOfWorktree(worktreeId: string): WorkspaceRef | null {
    const w = this.worktreeById.get(worktreeId)
    if (w) return this.worktreeRef(w)
    const i = worktreeId.indexOf('::')
    if (i < 0) return null
    const p = worktreeId.slice(i + 2)
    if (!p || !path.isAbsolute(p)) return null
    return { key: worktreeId, name: baseName(p), path: p, repo: null, branch: null }
  }

  workspaceByDirectory(directory: string | null): WorkspaceRef | null {
    if (!directory) return null
    for (const w of this.worktreesByPathLen) if (isPrefixDir(w.path, directory)) return this.worktreeRef(w)
    const dir = normalizeDir(directory)
    return { key: dir, name: baseName(dir), path: directory, repo: null, branch: null }
  }

  /** Orca link + workspace for a *root* session (null link when nothing joins). */
  linkRoot(sessionId: string, directory: string | null): { orca: OrcaLink | null; workspace: WorkspaceRef | null } {
    const hook = this.hookBySession.get(sessionId) ?? null
    const terminal = this.terminalOfSession(sessionId)
    const role = this.roleOf(sessionId)
    if (!hook && !terminal && !role) return { orca: null, workspace: this.workspaceByDirectory(directory) }
    const worktreeId = terminal?.worktreeId ?? hook?.worktreeId ?? null
    const orca: OrcaLink = {
      paneKey: hook?.paneKey ?? null,
      tabId: hook?.tabId ?? terminal?.tabId ?? null,
      terminalHandle: terminal?.handle ?? null,
      terminalTitle: terminal?.title ?? null,
      worktreeId,
      hookEvent: hook?.hookEvent ?? null,
      hookState: hook?.state ?? null,
      hookAt: hook?.receivedAt ?? null,
      runId: role?.runId ?? null,
      taskId: role?.taskId ?? null,
      dispatchId: role?.dispatchId ?? null,
      role: role?.role ?? null,
    }
    const workspace = (worktreeId ? this.workspaceOfWorktree(worktreeId) : null) ?? this.workspaceByDirectory(directory)
    return { orca, workspace }
  }
}
