import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { resetOccStore, useOcc } from '../../state/store'
import { usageBus } from '../../state/usage-bus'
import { setFlowReducedOverride } from '../../ui/flow'
import type { UsageSample } from '../../../shared/contract'
import { EdgeParticles, NodeFlowOverlay } from './FlowOverlay'
import { mockBootstrap } from '../../../../test/client/render'

afterEach(() => setFlowReducedOverride(null))
const svg = (n: React.ReactNode) => render(<svg>{n}</svg>)
const flow = (o: Partial<{ live: boolean; inflowPerMin: number; outflowPerMin: number }> = {}) =>
  ({ childId: 'ses_x', live: true, inflowPerMin: 1e6, outflowPerMin: 100, ...o })

describe('EdgeParticles', () => {
  it('draws up/down streams with log-mapped counts and durations', () => {
    const { container } = svg(<EdgeParticles path="M0 0 L10 10" flow={flow()} reduced={false} />)
    expect(container.querySelectorAll('[data-particle="input"]')).toHaveLength(4)
    const out = container.querySelectorAll('[data-particle="output"]')
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThan(4)
    expect(container.querySelector('[data-particle="input"]')!.getAttribute('data-dur')).toBe('0.8')
    expect(container.querySelector('animateMotion')!.getAttribute('repeatCount')).toBe('indefinite')
  })
  it('emits nothing for non-live children', () => {
    const { container } = svg(<EdgeParticles path="M0 0 L10 10" flow={flow({ live: false })} reduced={false} />)
    expect(container.querySelector('[data-particle]')).toBeNull()
  })
  it('adds a burst on a completed call', () => {
    const { container } = svg(<EdgeParticles path="M0 0 L10 10" flow={flow({ inflowPerMin: 10, outflowPerMin: 10 })} reduced={false} />)
    const before = container.querySelectorAll('[data-particle]').length
    act(() => usageBus.emit({ estimates: [], samples: [{ id: 'a', ledgerSeq: 1, sessionId: 'ses_x', rootId: null, ts: 1, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: null } as UsageSample] }))
    expect(container.querySelectorAll('[data-particle]').length).toBeGreaterThan(before)
  })
  it('reduced motion → static dual-tone stroke, no particles', () => {
    const { container } = svg(<EdgeParticles path="M0 0 L10 10" flow={flow()} reduced />)
    expect(container.querySelector('[data-testid="edge-flow-static"]')).toBeTruthy()
    expect(container.querySelector('circle')).toBeNull()
  })
})

describe('NodeFlowOverlay', () => {
  it('ring arcs follow shares and a pulse appears on a completed call', () => {
    resetOccStore()
    useOcc.getState().applyBootstrap(mockBootstrap())
    const s = Object.values(useOcc.getState().sessions)[0]!
    const { container, queryByTestId } = render(<NodeFlowOverlay s={s} shares={{ inShare: 0.4, outShare: 0.1 }} />)
    expect(container.querySelector('[data-arc="in"]')!.getAttribute('data-length')).toBe('0.2')
    expect(container.querySelector('[data-arc="out"]')!.getAttribute('data-length')).toBe('0.05')
    expect(queryByTestId('flow-pulse')).toBeNull()
    act(() => usageBus.emit({ estimates: [], samples: [{ id: 'b', ledgerSeq: 1, sessionId: s.id, rootId: s.rootId, ts: 1, tokens: { input: 1, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 } as UsageSample] }))
    expect(queryByTestId('flow-pulse')).toBeTruthy()
  })
})
