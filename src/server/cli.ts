import { parseArgs } from 'node:util'

export class CliError extends Error {
  override name = 'CliError'
}

export interface CliOptions {
  port: number
  host: string
  allowRemote: boolean
  windowHours: number
  pollMs: number
  orcaPollMs: number
  orcaTimeoutMs: number
  opencodeDb: string | null
  orcaDir: string | null
  copilotDir: string | null
  claudeDir: string | null
  codexDir: string | null
  cursorDir: string | null
  orcaCli: string | null
  noOpencode: boolean
  noCopilot: boolean
  noClaude: boolean
  noCodex: boolean
  noCursor: boolean
  noOrcaCli: boolean
  noOrchestration: boolean
  noHooks: boolean
  mcpServers: string[]
  ringSize: number
  noOpen: boolean
  dev: boolean
  verbose: boolean
}

export const USAGE = `occ — Orca Command Center (read-only dashboard for agent fleets)

Usage: occ [options]

  --port <n>             HTTP port (default 4270; error if in use)
  --host <h>             Bind address (default 127.0.0.1; non-loopback requires --allow-remote; NO authentication)
  --allow-remote         Permit a non-loopback --host (exposes all transcripts to the network)
  --window-hours <n>     Sessions window, 1-720 (default 24)
  --poll-ms <n>          SQLite change poll, 100-60000 (default 750)
  --orca-poll-ms <n>     Orca CLI poll, 1000-600000 (default 5000)
  --orca-timeout-ms <n>  Orca CLI command timeout, 1000-120000 (default 15000)
  --opencode-db <path>   Explicit opencode.db (error if unreadable)
  --orca-dir <path>      Explicit Orca userData dir (error if unreadable)
  --copilot-dir <path>   Explicit Copilot dir (error if unreadable)
  --claude-dir <path>    Explicit Claude Code config dir, e.g. ~/.claude (error if unreadable)
  --codex-dir <path>     Explicit Codex home, e.g. ~/.codex (error if unreadable)
  --cursor-dir <path>    Explicit Cursor dir, e.g. ~/.cursor (error if unreadable)
  --orca-cli <path>      Explicit orca executable
  --no-opencode          Disable the OpenCode source
  --no-copilot           Disable the Copilot CLI source
  --no-claude            Disable the Claude Code source
  --no-codex             Disable the Codex source
  --no-cursor            Disable the Cursor source
  --no-orca-cli          Disable the Orca CLI source
  --no-orchestration     Disable orchestration.db
  --no-hooks             Disable Orca agent hooks
  --mcp-servers <a,b>    Extra known MCP server names
  --ring-size <n>        Activity ring size, 1000-200000 (default 20000)
  --no-open              Do not open a browser
  --dev                  Dev mode (client served by Vite)
  --verbose              Debug logging
  --version              Print version
  --help                 Print this help

Data sources (read-only): OpenCode opencode.db, Copilot CLI ~/.copilot/session-state,
Claude Code ~/.claude/projects, Codex ~/.codex/sessions, Cursor ~/.cursor/projects/*/agent-transcripts,
Orca orchestration.db + agent-hooks/last-status.json, and the \`orca\` CLI (status/ps/list).
`

function int(flag: string, raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined) return def
  if (!/^\d+$/.test(raw.trim())) throw new CliError(`--${flag} must be an integer between ${min} and ${max} (got "${raw}")`)
  const n = Number(raw)
  if (n < min || n > max) throw new CliError(`--${flag} must be between ${min} and ${max} (got ${n})`)
  return n
}

export function parseCli(argv: string[]): CliOptions | { help: true } | { version: true } {
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        'allow-remote': { type: 'boolean' },
        'window-hours': { type: 'string' },
        'poll-ms': { type: 'string' },
        'orca-poll-ms': { type: 'string' },
        'orca-timeout-ms': { type: 'string' },
        'opencode-db': { type: 'string' },
        'orca-dir': { type: 'string' },
        'copilot-dir': { type: 'string' },
        'claude-dir': { type: 'string' },
        'codex-dir': { type: 'string' },
        'cursor-dir': { type: 'string' },
        'orca-cli': { type: 'string' },
        'no-opencode': { type: 'boolean' },
        'no-copilot': { type: 'boolean' },
        'no-claude': { type: 'boolean' },
        'no-codex': { type: 'boolean' },
        'no-cursor': { type: 'boolean' },
        'no-orca-cli': { type: 'boolean' },
        'no-orchestration': { type: 'boolean' },
        'no-hooks': { type: 'boolean' },
        'mcp-servers': { type: 'string' },
        'ring-size': { type: 'string' },
        'no-open': { type: 'boolean' },
        dev: { type: 'boolean' },
        verbose: { type: 'boolean' },
        version: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }).values
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message.split('\n')[0]! : String(e))
  }
  if (values.help) return { help: true }
  if (values.version) return { version: true }
  const str = (k: string): string | null => {
    const v = values[k]
    if (typeof v !== 'string') return null
    if (v.trim() === '') throw new CliError(`--${k} must not be empty`)
    return v
  }
  const host = str('host') ?? '127.0.0.1'
  const allowRemote = !!values['allow-remote']
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new CliError(
      `refusing to serve on ${host} without --allow-remote: no authentication — every prompt, tool output and diff becomes readable`,
    )
  }
  return {
    port: int('port', values.port as string | undefined, 4270, 1, 65535),
    host,
    allowRemote,
    windowHours: int('window-hours', values['window-hours'] as string | undefined, 24, 1, 720),
    pollMs: int('poll-ms', values['poll-ms'] as string | undefined, 750, 100, 60_000),
    orcaPollMs: int('orca-poll-ms', values['orca-poll-ms'] as string | undefined, 5000, 1000, 600_000),
    orcaTimeoutMs: int('orca-timeout-ms', values['orca-timeout-ms'] as string | undefined, 15_000, 1000, 120_000),
    opencodeDb: str('opencode-db'),
    orcaDir: str('orca-dir'),
    copilotDir: str('copilot-dir'),
    claudeDir: str('claude-dir'),
    codexDir: str('codex-dir'),
    cursorDir: str('cursor-dir'),
    orcaCli: str('orca-cli'),
    noOpencode: !!values['no-opencode'],
    noCopilot: !!values['no-copilot'],
    noClaude: !!values['no-claude'],
    noCodex: !!values['no-codex'],
    noCursor: !!values['no-cursor'],
    noOrcaCli: !!values['no-orca-cli'],
    noOrchestration: !!values['no-orchestration'],
    noHooks: !!values['no-hooks'],
    mcpServers: (str('mcp-servers') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ringSize: int('ring-size', values['ring-size'] as string | undefined, 20_000, 1000, 200_000),
    noOpen: !!values['no-open'],
    dev: !!values.dev,
    verbose: !!values.verbose,
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.')
}
