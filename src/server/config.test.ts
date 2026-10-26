import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliError, parseCli, type CliOptions } from './cli.js'
import { resolveConfig } from './config.js'

const cli = (...a: string[]) => parseCli(a) as CliOptions
const base = { platform: 'darwin' as const, env: {}, isExecutable: () => false }

function home() {
  return mkdtempSync(path.join(tmpdir(), 'occ-cfg-'))
}

describe('resolveConfig', () => {
  it('discovers sources and sets derived fields', () => {
    const h = home()
    const orca = path.join(h, 'Library/Application Support/orca')
    mkdirSync(path.join(orca, 'agent-hooks'), { recursive: true })
    writeFileSync(path.join(orca, 'orchestration.db'), '')
    mkdirSync(path.join(h, '.copilot'))
    const { config, notes } = resolveConfig(cli('--port', '4300'), {}, { ...base, homedir: h })
    expect(config.orcaDir).toBe(orca)
    expect(config.orchestrationDb).toBe(path.join(orca, 'orchestration.db'))
    expect(config.hooksFile).toBe(path.join(orca, 'agent-hooks', 'last-status.json'))
    expect(config.copilotDir).toBe(path.join(h, '.copilot'))
    expect(config.opencodeDb).toBeNull()
    expect(notes.join('\n')).toMatch(/OpenCode database not found/)
    expect(config.allowedHosts).toEqual(['127.0.0.1:4300', 'localhost:4300', '[::1]:4300'])
    expect(config.staticDir).toMatch(/dist[\\/]client$/)
    expect(config.thresholds.liveMs).toBe(600_000)
    expect(config.orcaCli).toBeNull()
  })

  it('prefers the Orca dir with the newest db mtime', () => {
    const h = home()
    const a = path.join(h, 'Library/Application Support/orca')
    const b = path.join(h, 'Library/Application Support/orca-dev')
    for (const d of [a, b]) {
      mkdirSync(d, { recursive: true })
      writeFileSync(path.join(d, 'orchestration.db'), '')
    }
    utimesSync(path.join(a, 'orchestration.db'), 1000, 1000)
    utimesSync(path.join(b, 'orchestration.db'), 5000, 5000)
    expect(resolveConfig(cli(), {}, { ...base, homedir: h }).config.orcaDir).toBe(b)
  })

  it('explicit paths that are unreadable are hard errors', () => {
    const h = home()
    for (const f of ['--opencode-db', '--orca-dir', '--copilot-dir']) {
      expect(() => resolveConfig(cli(f, path.join(h, 'nope')), {}, { ...base, homedir: h })).toThrow(CliError)
    }
  })

  it('disable flags null out sources; dev adds vite hosts and no staticDir', () => {
    const h = home()
    mkdirSync(path.join(h, '.copilot'))
    const { config } = resolveConfig(cli('--dev', '--no-copilot', '--no-orca-cli', '--host', '0.0.0.0'), {}, { ...base, homedir: h })
    expect(config.copilotDir).toBeNull()
    expect(config.staticDir).toBeNull()
    expect(config.allowedHosts).toContain('localhost:5173')
    expect(config.allowedHosts).toContain('127.0.0.1:5173')
    expect(config.allowedHosts).toContain('0.0.0.0:4270')
  })

  it('orcaCli: explicit wins over discovery', () => {
    const { config } = resolveConfig(cli('--orca-cli', '/bin/orca'), {}, { ...base, homedir: home(), env: { ORCA_CLI_COMMAND: '/other' } })
    expect(config.orcaCli).toBe('/bin/orca')
  })
})
