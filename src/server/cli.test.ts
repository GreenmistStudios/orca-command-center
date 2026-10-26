import { describe, expect, it } from 'vitest'
import { CliError, parseCli, type CliOptions } from './cli.js'

describe('parseCli', () => {
  it('applies defaults', () => {
    const o = parseCli([]) as CliOptions
    expect(o).toMatchObject({ port: 4270, host: '127.0.0.1', windowHours: 24, pollMs: 750, orcaPollMs: 5000, ringSize: 20000, noOpen: false, dev: false })
  })
  it('parses values and flags', () => {
    const o = parseCli(['--port', '4271', '--no-open', '--no-copilot', '--mcp-servers', 'a, b', '--opencode-db', '/x.db']) as CliOptions
    expect(o.port).toBe(4271)
    expect(o.noOpen && o.noCopilot).toBe(true)
    expect(o.mcpServers).toEqual(['a', 'b'])
    expect(o.opencodeDb).toBe('/x.db')
  })
  it('help and version', () => {
    expect(parseCli(['--help'])).toEqual({ help: true })
    expect(parseCli(['--version'])).toEqual({ version: true })
  })
  it.each([
    [['--port', '0'], '--port'],
    [['--port', '70000'], '--port'],
    [['--port', 'abc'], '--port'],
    [['--window-hours', '721'], '--window-hours'],
    [['--poll-ms', '99'], '--poll-ms'],
    [['--orca-poll-ms', '999'], '--orca-poll-ms'],
    [['--ring-size', '10'], '--ring-size'],
    [['--bogus'], 'bogus'],
    [['--port'], 'port'],
  ])('rejects %j', (argv, name) => {
    expect(() => parseCli(argv)).toThrow(CliError)
    expect(() => parseCli(argv)).toThrow(name)
  })
})
