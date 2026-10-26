import { describe, expect, it } from 'vitest'
import { createLogger } from './log.js'

describe('createLogger', () => {
  it('formats lines and gates debug', () => {
    const lines: string[] = []
    const log = createLogger({ verbose: false, prefix: 'x', write: (l) => lines.push(l) })
    log.debug('hidden')
    log.info('hello %s', 'world')
    log.warn('w')
    log.error('e', 1)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2} info  \[x\] hello world$/)
    expect(lines[1]).toContain('warn')
    expect(lines[2]).toContain('e 1')
  })
  it('emits debug when verbose', () => {
    const lines: string[] = []
    createLogger({ verbose: true, write: (l) => lines.push(l) }).debug('d')
    expect(lines[0]).toMatch(/debug d$/)
  })
})
