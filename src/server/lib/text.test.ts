import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { basename, clip, compactJson, extractLinks, normalizePath, oneLine, stripAnsi, truncate } from './text.js'

describe('truncate/clip', () => {
  it('keeps short text', () => expect(truncate('abc', 3)).toEqual({ text: 'abc', truncated: false }))
  it('cuts and appends ellipsis', () => expect(truncate('abcdef', 3)).toEqual({ text: 'abc…', truncated: true }))
  it('cuts on code points', () => {
    expect(truncate('😀😀😀', 2)).toEqual({ text: '😀😀…', truncated: true })
  })
  it('clip returns string', () => expect(clip('abcdef', 2)).toBe('ab…'))
})

describe('stripAnsi', () => {
  it('strips CSI, truecolor and OSC', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('\x1b[38;2;1;2;3mx\x1b[39m')).toBe('x')
    expect(stripAnsi('\x1b]8;;http://a\x07link\x1b]8;;\x07')).toBe('link')
    expect(stripAnsi('\x1b]0;title\x1b\\ok')).toBe('ok')
    expect(stripAnsi('\x1b[2K\x1b[1Gdone')).toBe('done')
  })
})

describe('oneLine', () => {
  it('collapses whitespace', () => expect(oneLine('  a \n\t b  ')).toBe('a b'))
})

describe('compactJson', () => {
  it('is stable and one line', () => {
    expect(compactJson({ b: 1, a: { d: 1, c: 2 } }, 100)).toBe('{"a":{"c":2,"d":1},"b":1}')
  })
  it('clips', () => expect(compactJson({ a: 'x'.repeat(50) }, 10)).toHaveLength(11))
  it('handles circular and bigint', () => {
    const o: Record<string, unknown> = { n: 1n }
    o.self = o
    expect(compactJson(o, 100)).toContain('[circular]')
  })
  it('handles undefined', () => expect(compactJson(undefined, 20)).toBe('undefined'))
})

describe('extractLinks', () => {
  it('extracts, trims, dedupes', () => {
    const t = 'see https://a.com/x. and (https://b.com/y), also https://a.com/x; http://c.org/z?q=1!'
    expect(extractLinks(t, 10)).toEqual(['https://a.com/x', 'https://b.com/y', 'http://c.org/z?q=1'])
  })
  it('respects max', () => expect(extractLinks('http://a.io http://b.io http://c.io', 2)).toHaveLength(2))
  it('ignores non-http', () => expect(extractLinks('ftp://x.com mailto:a@b', 5)).toEqual([]))
})

describe('paths', () => {
  it('basename', () => {
    expect(basename('/a/b/c.ts')).toBe('c.ts')
    expect(basename('/a/b/')).toBe('b')
    expect(basename('c')).toBe('c')
  })
  it('normalizePath', () => {
    expect(normalizePath('~/x/')).toBe(`${homedir()}/x`)
    expect(normalizePath('~')).toBe(homedir())
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('/a/b///')).toBe('/a/b')
    expect(normalizePath('~/x', '/h')).toBe('/h/x')
  })
})
