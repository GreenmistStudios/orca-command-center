import type { OrcaStatus, SourceHealth, TerminalInfo, WorktreeInfo } from '../../../shared/contract.js'
import type { CliRunner, OrcaCliSource, OrcaCliUpdate, SourceDeps } from '../../types.js'
import { parseStatus, parseTerminals, parseWorktrees } from './parse.js'
import { assertAllowed, defaultCliRunner } from './runner.js'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BUFFER = 16 * 1024 * 1024
const CLEAR_AFTER = 3

const STATUS_ARGS = ['status', '--json']
const WORKTREE_ARGS = ['worktree', 'ps', '--json']
const TERMINAL_ARGS = ['terminal', 'list', '--json']

function statusKey(s: OrcaStatus): string {
  return JSON.stringify([s.running, s.pid, s.version, s.runtimeState, s.reachable, s.error])
}

export function createOrcaCliSource(deps: SourceDeps & { runner?: CliRunner }): OrcaCliSource {
  const { config, log, now } = deps
  const runner = deps.runner ?? defaultCliRunner
  const exe = config.orcaCli

  const disabledStatus = (): OrcaStatus => ({
    running: false,
    reachable: false,
    pid: null,
    version: null,
    runtimeState: null,
    checkedAt: now(),
    error: 'orca CLI not found',
  })

  let status: OrcaStatus = exe === null
    ? disabledStatus()
    : { running: false, reachable: false, pid: null, version: null, runtimeState: null, checkedAt: now(), error: null }
  let worktrees: WorktreeInfo[] = []
  let terminals: TerminalInfo[] = []
  let fleetKey = JSON.stringify([worktrees, terminals])
  let healthStatus: SourceHealth['status'] = exe === null ? 'disabled' : 'starting'
  let errorMessage: string | null = null
  let lastReadAt: number | null = null
  let lastChangeAt: number | null = null
  let lastGoodAt: number | null = null
  let notRunning = 0
  let stopped = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> | null = null
  const listeners = new Set<(u: OrcaCliUpdate) => void>()

  const emit = (u: OrcaCliUpdate) => {
    for (const l of [...listeners]) {
      try {
        l(u)
      } catch (e) {
        log.warn('orca-cli listener failed', e)
      }
    }
  }

  async function run(args: string[]): Promise<string> {
    assertAllowed(args)
    const r = await runner(exe as string, args, { timeoutMs: config.orcaTimeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER })
    if (r.exitCode !== 0 && r.stdout.trim() === '') {
      throw new Error(r.stderr.trim().split('\n')[0] || `orca exited with code ${r.exitCode ?? 'unknown'}`)
    }
    return r.stdout
  }

  function setStatus(next: OrcaStatus) {
    const changed = statusKey(next) !== statusKey(status)
    status = next
    if (changed) {
      lastChangeAt = now()
      emit({ type: 'status', status })
    }
  }

  function setFleet(w: WorktreeInfo[], t: TerminalInfo[]) {
    const key = JSON.stringify([w, t])
    if (key === fleetKey) return
    fleetKey = key
    worktrees = w
    terminals = t
    lastChangeAt = now()
    emit({ type: 'fleet', worktrees, terminals })
  }

  async function poll(): Promise<void> {
    try {
      const next = parseStatus(await run(STATUS_ARGS), now())
      if (next.error !== null) throw new Error(next.error)
      setStatus(next)
      if (next.running && next.reachable) {
        notRunning = 0
        const [wt, tm] = await Promise.all([run(WORKTREE_ARGS), run(TERMINAL_ARGS)])
        const w = parseWorktrees(wt)
        const t = parseTerminals(tm)
        if (w.error !== null) throw new Error(w.error)
        if (t.error !== null) throw new Error(t.error)
        if (w.warnings + t.warnings > 0) log.debug(`orca-cli: ${w.warnings + t.warnings} shape warnings`)
        setFleet(w.value, t.value)
        healthStatus = 'ok'
        errorMessage = null
        lastGoodAt = now()
      } else {
        notRunning++
        if (notRunning >= CLEAR_AFTER) setFleet([], [])
        healthStatus = 'ok'
        errorMessage = null
        lastGoodAt = now()
      }
    } catch (e) {
      healthStatus = 'error'
      errorMessage = e instanceof Error ? e.message : String(e)
      log.warn(`orca-cli poll failed: ${errorMessage}`)
    }
    lastReadAt = now()
  }

  function schedule() {
    if (stopped) return
    timer = setTimeout(() => {
      timer = null
      void tick()
    }, config.orcaPollMs)
    timer.unref?.()
  }

  function tick(): Promise<void> {
    inflight = poll().finally(() => {
      inflight = null
      schedule()
    })
    return inflight
  }

  return {
    id: 'orca-cli',
    async start() {
      if (exe === null) return
      if (!stopped) return
      stopped = false
      await tick()
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      listeners.clear()
      if (inflight) await inflight.catch(() => undefined)
    },
    health(): SourceHealth {
      let detail: string | null
      if (exe === null) detail = 'Orca CLI not found'
      else {
        detail = `${worktrees.length} worktrees · ${terminals.length} terminals`
        if (healthStatus === 'error') {
          detail = `${errorMessage ?? 'error'}${lastGoodAt !== null ? ` — showing data from ${new Date(lastGoodAt).toLocaleTimeString()}` : ''}`
        }
      }
      return {
        id: 'orca-cli',
        label: 'Orca CLI',
        status: healthStatus,
        path: exe,
        version: status.version,
        detail,
        lastReadAt,
        lastChangeAt,
      }
    },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    status: () => status,
    worktrees: () => worktrees,
    terminals: () => terminals,
  }
}
