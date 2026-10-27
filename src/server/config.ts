import { statSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError, isLoopbackHost, type CliOptions } from './cli.js'
import { defaultClaudeDir, defaultCodexDir, defaultCopilotDir, defaultCursorDir, defaultOpencodeDb, defaultOrcaDirs, resolveOrcaCli } from './lib/paths.js'
import type { Config } from './types.js'

export interface ConfigDeps {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  homedir?: string
  exists?: (p: string) => boolean
  stat?: (p: string) => { mtimeMs: number } | null
  /** Override the package root (tests). */
  packageRoot?: string
  isExecutable?: (file: string) => boolean
}

function defaultExists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

function defaultStat(p: string): { mtimeMs: number } | null {
  try {
    return { mtimeMs: statSync(p).mtimeMs }
  } catch {
    return null
  }
}

export function packageRoot(): string {
  // src/server/config.ts and dist/server/config.js are both two levels below the package root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function resolveConfig(
  cli: CliOptions,
  env: Record<string, string | undefined> = process.env,
  deps: ConfigDeps = {},
): { config: Config; notes: string[] } {
  const platform = deps.platform ?? process.platform
  const home = deps.homedir ?? osHomedir()
  const exists = deps.exists ?? defaultExists
  const stat = deps.stat ?? defaultStat
  const pe = { env, platform, homedir: home }
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const notes: string[] = []
  const tilde = (p: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : p)

  // OpenCode
  let opencodeDb: string | null = null
  if (cli.noOpencode) notes.push('OpenCode disabled (--no-opencode)')
  else if (cli.opencodeDb) {
    if (!exists(cli.opencodeDb)) throw new CliError(`--opencode-db: cannot read ${cli.opencodeDb}`)
    opencodeDb = cli.opencodeDb
  } else {
    const p = defaultOpencodeDb(pe)
    if (exists(p)) opencodeDb = p
    else notes.push(`OpenCode database not found at ${tilde(p)}`)
  }

  // Copilot
  let copilotDir: string | null = null
  if (cli.noCopilot) notes.push('Copilot CLI disabled (--no-copilot)')
  else if (cli.copilotDir) {
    if (!exists(cli.copilotDir)) throw new CliError(`--copilot-dir: cannot read ${cli.copilotDir}`)
    copilotDir = cli.copilotDir
  } else {
    const p = defaultCopilotDir(pe)
    if (exists(p)) copilotDir = p
    else notes.push(`Copilot CLI not found at ${tilde(p)}`)
  }

  // Claude Code, Codex, Cursor: same rules as Copilot (explicit path must exist; default is optional)
  const optionalDir = (label: string, flag: string, disabled: boolean, explicit: string | null, fallback: string): string | null => {
    if (disabled) {
      notes.push(`${label} disabled (--no-${flag})`)
      return null
    }
    if (explicit) {
      if (!exists(explicit)) throw new CliError(`--${flag}-dir: cannot read ${explicit}`)
      return explicit
    }
    if (exists(fallback)) return fallback
    notes.push(`${label} not found at ${tilde(fallback)}`)
    return null
  }
  const claudeDir = optionalDir('Claude Code', 'claude', cli.noClaude, cli.claudeDir, defaultClaudeDir(pe))
  const codexDir = optionalDir('Codex', 'codex', cli.noCodex, cli.codexDir, defaultCodexDir(pe))
  const cursorDir = optionalDir('Cursor', 'cursor', cli.noCursor, cli.cursorDir, defaultCursorDir(pe))

  // Orca dir
  let orcaDir: string | null = null
  if (cli.orcaDir) {
    if (!exists(cli.orcaDir)) throw new CliError(`--orca-dir: cannot read ${cli.orcaDir}`)
    orcaDir = cli.orcaDir
  } else {
    let bestMtime = -1
    for (const dir of defaultOrcaDirs(pe)) {
      const db = join(dir, 'orchestration.db')
      if (!exists(db) && !exists(join(dir, 'agent-hooks'))) continue
      const m = Math.max(stat(db)?.mtimeMs ?? 0, stat(db + '-wal')?.mtimeMs ?? 0)
      if (orcaDir === null || m > bestMtime) {
        orcaDir = dir
        bestMtime = m
      }
    }
    if (!orcaDir) notes.push('Orca data directory not found')
  }

  let orchestrationDb: string | null = null
  let hooksFile: string | null = null
  if (orcaDir) {
    const db = join(orcaDir, 'orchestration.db')
    if (cli.noOrchestration) notes.push('Orchestration disabled (--no-orchestration)')
    else if (exists(db)) orchestrationDb = db
    else notes.push(`orchestration.db not found in ${tilde(orcaDir)}`)
    if (cli.noHooks) notes.push('Orca hooks disabled (--no-hooks)')
    else hooksFile = join(orcaDir, 'agent-hooks', 'last-status.json')
  } else {
    if (cli.noOrchestration) notes.push('Orchestration disabled (--no-orchestration)')
    if (cli.noHooks) notes.push('Orca hooks disabled (--no-hooks)')
  }

  // Orca CLI
  let orcaCli: string | null = null
  if (cli.noOrcaCli) notes.push('Orca CLI disabled (--no-orca-cli)')
  else {
    orcaCli = cli.orcaCli ?? resolveOrcaCli({ ...pe, isExecutable: deps.isExecutable })
    if (!orcaCli) notes.push('Orca CLI not found on PATH')
  }

  const p = cli.port
  const remote = !isLoopbackHost(cli.host)
  const bound = cli.host.includes(':') && !cli.host.startsWith('[') ? `[${cli.host}]` : cli.host
  const allowedHosts = remote ? [`${bound}:${p}`] : [`${cli.host}:${p}`, `localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`]
  if (remote) notes.push(`Serving on ${cli.host}:${p} (--allow-remote): NO authentication — transcripts are readable by anyone who can reach this port`)
  if (cli.dev) allowedHosts.push('localhost:5173', '127.0.0.1:5173')

  const config: Config = {
    host: cli.host,
    port: p,
    open: !cli.noOpen,
    verbose: cli.verbose,
    dev: cli.dev,
    windowMs: cli.windowHours * 3_600_000,
    pollMs: cli.pollMs,
    orcaPollMs: cli.orcaPollMs,
    orcaTimeoutMs: cli.orcaTimeoutMs,
    orcaDir,
    orchestrationDb,
    hooksFile,
    opencodeDb,
    copilotDir,
    claudeDir,
    codexDir,
    cursorDir,
    orcaCli,
    mcpServers: cli.mcpServers,
    ringSize: cli.ringSize,
    staticDir: cli.dev ? null : path.join(deps.packageRoot ?? packageRoot(), 'dist', 'client'),
    allowedHosts: [...new Set(allowedHosts)],
    thresholds: { liveMs: 600_000, idleMs: 1_800_000, stalledMs: 600_000, workingMs: 120_000 },
  }
  return { config, notes }
}
