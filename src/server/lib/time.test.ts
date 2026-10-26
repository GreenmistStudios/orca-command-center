import { describe, expect, it } from 'vitest'
import { parseTime } from './time.js'

describe('parseTime', () => {
  it('numbers', () => {
    expect(parseTime(1792668387916)).toBe(1792668387916)
    expect(parseTime(1792668387)).toBe(1792668387000)
    expect(parseTime(1792668387.5)).toBe(1792668387500)
    expect(parseTime(12345)).toBeNull()
    expect(parseTime(0)).toBeNull()
    expect(parseTime(NaN)).toBeNull()
  })
  it('ISO strings', () => {
    expect(parseTime('2026-10-26T12:00:00.000Z')).toBe(Date.UTC(2026, 9, 26, 12))
    expect(parseTime('2026-10-26T12:00:00+02:00')).toBe(Date.UTC(2026, 9, 26, 10))
  })
  it('SQL timestamps are UTC', () => {
    expect(parseTime('2026-10-26 12:00:00')).toBe(Date.UTC(2026, 9, 26, 12))
    expect(parseTime('2026-10-26 12:00:00.250')).toBe(Date.UTC(2026, 9, 26, 12, 0, 0, 250))
  })
  it('garbage', () => {
    for (const v of ['', 'abc', '1', null, undefined, {}, [], true, '2026-13-45 99:00:00']) expect(parseTime(v)).toBeNull()
  })
})
