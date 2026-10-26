import { describe, expect, it } from 'vitest'
import { defaultCopilotDir, defaultOpencodeDb, defaultOrcaDirs, resolveOrcaCli } from './paths.js'

describe('paths', () => {
  it('orca dirs per platform', () => {
    expect(defaultOrcaDirs({ platform: 'darwin', homedir: '/h', env: {} })).toEqual([
      '/h/Library/Application Support/orca',
      '/h/Library/Application Support/orca-dev',
    ])
    expect(defaultOrcaDirs({ platform: 'linux', homedir: '/h', env: {} })).toEqual(['/h/.config/orca'])
    expect(defaultOrcaDirs({ platform: 'linux', homedir: '/h', env: { XDG_CONFIG_HOME: '/x' } })).toEqual(['/x/orca'])
    expect(defaultOrcaDirs({ platform: 'win32', homedir: 'C:\\u', env: { APPDATA: 'C:\\A' } })).toEqual(['C:\\A\\orca'])
  })
  it('opencode db and copilot dir', () => {
    expect(defaultOpencodeDb({ homedir: '/h', env: {} })).toBe('/h/.local/share/opencode/opencode.db')
    expect(defaultOpencodeDb({ homedir: '/h', env: { XDG_DATA_HOME: '/d' } })).toBe('/d/opencode/opencode.db')
    expect(defaultCopilotDir({ homedir: '/h' })).toBe('/h/.copilot')
  })
  describe('resolveOrcaCli', () => {
    it('prefers env', () => {
      expect(resolveOrcaCli({ env: { ORCA_CLI_COMMAND: '/custom/orca', PATH: '/bin' }, isExecutable: () => true })).toBe('/custom/orca')
    })
    it('finds on PATH', () => {
      const ok = (f: string) => f === '/b/orca'
      expect(resolveOrcaCli({ platform: 'linux', env: { PATH: '/a:/b' }, isExecutable: ok })).toBe('/b/orca')
    })
    it('falls back to the macOS app bundle', () => {
      const app = '/Applications/Orca.app/Contents/Resources/bin/orca'
      expect(resolveOrcaCli({ platform: 'darwin', env: { PATH: '/a' }, isExecutable: (f) => f === app })).toBe(app)
      expect(resolveOrcaCli({ platform: 'linux', env: { PATH: '/a' }, isExecutable: (f) => f === app })).toBeNull()
    })
    it('returns null when nothing found', () => {
      expect(resolveOrcaCli({ platform: 'darwin', env: {}, isExecutable: () => false })).toBeNull()
    })
  })
})
