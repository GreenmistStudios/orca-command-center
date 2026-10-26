import { describe, expect, it } from 'vitest'
import {
  basename, formatCost, formatCount, formatDuration, formatRelative, formatTokens, shortModel, shortPath,
} from './format'
import { stableHash } from './hash'

describe('format', () => {
  it('formatDuration', () => {
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(3 * 60_000 + 5000)).toBe('3m')
    expect(formatDuration((2 * 60 + 5) * 60_000)).toBe('2h 5m')
    expect(formatDuration((27) * 3_600_000)).toBe('1d 3h')
    expect(formatDuration(-5)).toBe('0s')
  })
  it('formatRelative', () => {
    const now = new Date(2026, 9, 26, 12).getTime()
    expect(formatRelative(now - 1000, now)).toBe('now')
    expect(formatRelative(now - 12_000, now)).toBe('12s ago')
    expect(formatRelative(now - 3 * 60_000, now)).toBe('3m ago')
    expect(formatRelative(now - 2 * 3_600_000, now)).toBe('2h ago')
    expect(formatRelative(new Date(2026, 9, 24, 12).getTime(), now)).toBe('Oct 24')
  })
  it('formatCost / tokens / count', () => {
    expect(formatCost(0.42)).toBe('$0.42')
    expect(formatCost(0.001)).toBe('<$0.01')
    expect(formatCost(0)).toBe('$0')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(113_500)).toBe('113.5k')
    expect(formatTokens(2_100_000)).toBe('2.1M')
    expect(formatCount(12345)).toBe('12,345')
  })
  it('models and paths', () => {
    expect(shortModel('claude-opus-5.5')).toBe('opus-5.5')
    expect(shortModel('gpt-5.4-codex')).toBe('gpt-5.4-codex')
    expect(shortPath('/Users/me/proj/src/a.ts', '/Users/me/proj')).toBe('src/a.ts')
    expect(shortPath('/Users/me/x/a.ts')).toBe('~/x/a.ts')
    expect(basename('/a/b/c.ts')).toBe('c.ts')
  })
  it('stableHash is deterministic', () => {
    expect(stableHash('build')).toBe(stableHash('build'))
    expect(stableHash('a')).not.toBe(stableHash('b'))
  })
})
