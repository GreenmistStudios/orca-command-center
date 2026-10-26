import type { OrcaStatus, SourceHealth, TerminalInfo, WorktreeInfo } from '../../../shared/contract.js'
import type { CliRunner, OrcaCliSource, OrcaCliUpdate, SourceDeps } from '../../types.js'
import { parseStatus, parseTerminals, parseWorktrees } from './parse.js'
import { assertAllowed, defaultCliRunner } from './runner.js'

const TIMEOUT_MS = 3000
const MAX_BUFFER = 16 * 1024 * 1024
const CLEAR_AFTER = 3
const MAX_FAILURES = 3
const BOOT_RETRIES = 3
const BOOT_RETRY_MS = 750
/** Max time start() waits for the first poll before letting the server boot (exported for tests). */
export const START_WAIT_MS = 800

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
    : { running: false, reachable: false, pid: null, version: null, runtimeState: null, checkedAt: 0, error: null }
  let worktrees: WorktreeInfo[] = []
  let terminals: TerminalInfo[] = []
  let fleetKey = JSON.stringify([worktrees, terminals])
  let healthStatus: SourceHealth['status'] = exe === null ? 'disabled' : 'starting'
  let errorMessage: string | null = null
  let lastReadAt: number | null = null
  let lastChangeAt: number | null = null
  let lastGoodAt: number | null = null
  let notRunning = 0
  let failures = 0
  let hasGood = false
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
    const r = await runner(exe as string, args, { timeoutMs: TIMEOUT_MS, maxBuffer: MAX_BUFFER })
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

  const sleep = (ms: number) =>
    new Promise<void>((res) => {
      const t = setTimeout(res, ms)
      t.unref?.()
    })

  /** A failed poll is "unknown", not "not running": keep the last good status until MAX_FAILURES in a row. */
  function onFailure(message: string) {
    failures++
    if (hasGood && failures < MAX_FAILURES) setStatus({ ...status, error: message, checkedAt: now() })
    else setStatus({ running: false, reachable: false, pid: null, version: null, runtimeState: null, checkedAt: now(), error: message })
  }

  async function poll(): Promise<void> {
    for (let retry = 0; ; retry++) {
      const ok = await pollOnce()
      if (ok) {
        failures = 0
        break
      }
      if (hasGood || stopped) {
        onFailure(errorMessage ?? 'error')
        break
      }
      if (retry >= BOOT_RETRIES) {
        onFailure(errorMessage ?? 'error')
        break
      }
      await sleep(BOOT_RETRY_MS)
      if (stopped) break
    }
    lastReadAt = now()
  }

  async function pollOnce(): Promise<boolean> {
    try {
      const next = parseStatus(await run(STATUS_ARGS), now())
      if (next.error !== null) throw new Error(next.error)
      setStatus(next)
      hasGood = true
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
      return false
    }
    return true
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
      // Don't hold up server boot on a slow or hung CLI: wait at most START_WAIT_MS for the first
      // poll (normally ~0.2 s). Boot retries continue in the background and publish their status
      // when they settle, so the first answer is still honest.
      const first = tick().catch(() => undefined)
      await Promise.race([
        first,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, START_WAIT_MS)
          t.unref?.()
        }),
      ])
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
