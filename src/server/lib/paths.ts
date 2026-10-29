import { accessSync, constants, statSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import path from 'node:path'

export interface PathEnv {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  homedir?: string
}

function ctx(o: PathEnv) {
  const platform = o.platform ?? process.platform
  return {
    env: o.env ?? process.env,
    platform,
    home: o.homedir ?? osHomedir(),
    join: (platform === 'win32' ? path.win32.join : path.posix.join) as typeof path.join,
  }
}

/** Candidate Orca userData directories, in preference order. */
export function defaultOrcaDirs(o: PathEnv = {}): string[] {
  const { env, platform, home, join } = ctx(o)
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'orca'), join(home, 'Library', 'Application Support', 'orca-dev')]
  }
  if (platform === 'win32') {
    return [join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'orca')]
  }
  return [join(env.XDG_CONFIG_HOME || join(home, '.config'), 'orca')]
}

export function defaultOpencodeDb(o: PathEnv = {}): string {
  const { env, home, join } = ctx(o)
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'opencode.db')
}

export function defaultCopilotDir(o: PathEnv = {}): string {
  const { home, join } = ctx(o)
  return join(home, '.copilot')
}

/** Claude Code config dir: $CLAUDE_CONFIG_DIR, else ~/.claude (contains projects/). */
export function defaultClaudeDir(o: PathEnv = {}): string {
  const { env, home, join } = ctx(o)
  return env.CLAUDE_CONFIG_DIR || join(home, '.claude')
}

/** Codex home: $CODEX_HOME, else ~/.codex (contains sessions/YYYY/MM/DD/rollout-*.jsonl). */
export function defaultCodexDir(o: PathEnv = {}): string {
  const { env, home, join } = ctx(o)
  return env.CODEX_HOME || join(home, '.codex')
}

/** Cursor dir: ~/.cursor (contains projects/<slug>/agent-transcripts/ and chats/). */
export function defaultCursorDir(o: PathEnv = {}): string {
  const { home, join } = ctx(o)
  return join(home, '.cursor')
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveOrcaCli(o: PathEnv & { isExecutable?: (file: string) => boolean } = {}): string | null {
  const { env, platform, join } = ctx(o)
  const exists = o.isExecutable ?? isExecutable
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND
  const names = platform === 'win32' ? ['orca.exe', 'orca.cmd', 'orca.bat'] : ['orca']
  const delimiter = platform === 'win32' ? ';' : ':'
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const n of names) {
      const candidate = join(dir, n)
      if (exists(candidate)) return candidate
    }
  }
  if (platform === 'darwin') {
    const app = '/Applications/Orca.app/Contents/Resources/bin/orca'
    if (exists(app)) return app
  }
  return null
}
