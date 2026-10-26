import { describe, expect, it } from 'vitest'
import { agentColorIndex, agentMonogram, orchStatusTone, stateTone, toneClasses } from './tones'

describe('tones', () => {
  it('maps states', () => {
    expect(stateTone('working')).toBe('dispatched')
    expect(stateTone('blocked')).toBe('gate')
    expect(stateTone('waiting')).toBe('blocked')
    expect(orchStatusTone('circuit_broken')).toBe('failed')
    expect(orchStatusTone('weird')).toBe('unknown')
  })
  it('agent identity', () => {
    expect(agentMonogram('sonnet-coder')).toBe('SC')
    expect(agentMonogram('build')).toBe('BU')
    expect(agentColorIndex(null)).toBe(0)
    const i = agentColorIndex('explore')
    expect(i).toBeGreaterThanOrEqual(1)
    expect(i).toBeLessThanOrEqual(8)
    expect(toneClasses('gate').accentVar).toBe('var(--status-gate)')
  })
})
