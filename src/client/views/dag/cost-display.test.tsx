import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../../shared/contract'
import { mockBootstrap } from '../../../../test/client/render'
import { costDisplay, CostOrAiu } from './cost-display'

const base = () => mockBootstrap().sessions[0]!
const mk = (o: Partial<SessionSummary>): SessionSummary => ({ ...base(), ...o })
const usage = (aiu: number) => ({ calls: 1, inflow: 1, outflow: 1, aiu, cacheHitRate: null, tree: null, rates: null, inFlight: null })

describe('costDisplay', () => {
  it('Copilot with cost 0 never shows $0: AIU when known, else dash', () => {
    expect(costDisplay(mk({ harness: 'copilot', cost: 0, usage: usage(1.234) }), false)).toEqual({ kind: 'aiu', aiu: 1.234 })
    expect(costDisplay(mk({ harness: 'copilot', cost: 0, usage: usage(0) }), false)).toEqual({ kind: 'none' })
    render(<CostOrAiu d={{ kind: 'none' }} />)
    expect(screen.getByTitle('Cost not reported by this harness')).toBeTruthy()
  })
  it('free OpenCode model stays $0.00', () => {
    expect(costDisplay(mk({ harness: 'opencode', cost: 0, usage: usage(0) }), false)).toEqual({ kind: 'cost', cost: 0 })
  })
  it('roots use tree.costedCalls', () => {
    const tree = (costedCalls: number, aiu: number) => ({ ...usage(0), tree: { sessions: 1, calls: 1, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, inflow: 0, outflow: 0, cost: 2, costedCalls, aiu } })
    expect(costDisplay(mk({ harness: 'copilot', usage: tree(0, 3) }), true)).toEqual({ kind: 'aiu', aiu: 3 })
    expect(costDisplay(mk({ harness: 'copilot', usage: tree(2, 3) }), true)).toEqual({ kind: 'cost', cost: 2 })
  })
})
