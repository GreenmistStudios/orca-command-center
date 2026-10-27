import { spawn } from 'node:child_process'
import { CliError, USAGE, isLoopbackHost, parseCli } from './cli.js'
import { resolveConfig } from './config.js'
import { createHub } from './hub/hub.js'
import { createHttpServer } from './http/server.js'
import { createLogger } from './lib/log.js'
import { createStore } from './store/index.js'
import type { Config, Store } from './types.js'
import { VERSION } from './version.js'

function shouldOpen(config: Config, env: NodeJS.ProcessEnv): boolean {
  return config.open && !config.dev && !!process.stdout.isTTY && !env.CI && !env.SSH_CONNECTION
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd!, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* ignore */
  }
}

function banner(url: string, config: Config, notes: string[]): string {
  const line = (label: string, value: string | null, off: string) => `    ${label.padEnd(14)}${value ?? off}`
  const out = [
    '',
    `  Orca Command Center v${VERSION}`,
    `  ${url}   (read-only — never writes to agents or Orca)`,
    '',
    '  Sources:',
    line('OpenCode', config.opencodeDb, 'not found / disabled'),
    line('Copilot CLI', config.copilotDir, 'not found / disabled'),
    line('Claude Code', config.claudeDir ?? null, 'not found / disabled'),
    line('Codex', config.codexDir ?? null, 'not found / disabled'),
    line('Cursor', config.cursorDir ?? null, 'not found / disabled'),
    line('Orca dir', config.orcaDir, 'not found'),
    line('Orchestration', config.orchestrationDb, 'not found / disabled'),
    line('Orca hooks', config.hooksFile, 'disabled'),
    line('Orca CLI', config.orcaCli, 'not found / disabled'),
  ]
  if (notes.length) out.push('', '  Notes:', ...notes.map((n) => `    - ${n}`))
  out.push('')
  return out.join('\n')
}

async function main(): Promise<void> {
  let parsed
  try {
    parsed = parseCli(process.argv.slice(2))
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`occ: ${e.message}\n(see --help)\n`)
      process.exit(2)
    }
    throw e
  }
  if ('help' in parsed) {
    process.stdout.write(USAGE)
    return
  }
  if ('version' in parsed) {
    process.stdout.write(VERSION + '\n')
    return
  }

  let resolved
  try {
    resolved = resolveConfig(parsed, process.env)
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`occ: ${e.message}\n`)
      process.exit(2)
    }
    throw e
  }
  const { config, notes } = resolved
  const log = createLogger({ verbose: config.verbose })
  if (!isLoopbackHost(config.host)) {
    log.warn(`Binding to ${config.host}: there is NO authentication — everything on this machine's agents is readable by anyone who can reach this port.`)
  }

  // The hub needs meta() from the store; the store needs the hub. Break the cycle lazily.
  let store: Store | undefined
  const hub = createHub({ meta: () => store!.meta(), log })
  store = createStore({ config, log, now: Date.now, hub, version: VERSION })
  const http = createHttpServer({ config, store, hub, log })

  let listening: { url: string }
  try {
    await store.start()
    listening = await http.listen()
  } catch (e) {
    await store.stop().catch(() => {})
    if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
      process.stderr.write(`occ: port ${config.port} is already in use on ${config.host} (choose another with --port)\n`)
    } else {
      process.stderr.write(`occ: failed to start: ${e instanceof Error ? e.message : String(e)}\n`)
    }
    process.exit(1)
  }

  process.stderr.write(banner(listening.url, config, notes) + '\n')
  if (shouldOpen(config, process.env)) openBrowser(listening.url)

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) process.exit(1)
    stopping = true
    log.info(`${signal} received, shutting down`)
    const closing = http.close()
    hub.close()
    await closing.catch(() => {})
    await store!.stop().catch((e) => log.error('store stop failed: %s', String(e)))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((e) => {
  process.stderr.write(`occ: fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
  process.exit(1)
})
