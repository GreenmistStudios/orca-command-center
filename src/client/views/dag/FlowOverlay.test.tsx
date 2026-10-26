import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('in-flight meter morphs to the metered value, then disappears', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000)
    try {
      resetOccStore()
      useOcc.getState().applyBootstrap(mockBootstrap())
      const s = Object.values(useOcc.getState().sessions).find((x) => x.rootId)!
      const T0 = Date.now()
      const est = (inFlight: boolean) => ({ sessionId: s.id, rootId: s.rootId, harness: s.harness, startedAt: T0, updatedAt: T0, estOutputTokens: 40, inFlight })
      let seq = 99000
      const frame = (samples: unknown[], estimates: unknown[]) => useOcc.getState().applyStreamEvent({ type: 'usage', seq: ++seq, samples, estimates } as never)
      const { container } = render(<NodeFlowOverlay s={{ ...s, usage: undefined }} shares={{ inShare: 0.4, outShare: 0.1 }} />)
      act(() => { frame([], [est(true)]); vi.advanceTimersByTime(300) })
      expect(container.querySelector('[data-metered]') ?? container.querySelector('[class*="top-[34px]"]')).toBeTruthy()
      act(() => {
        frame([], [est(false)])
        frame([{ id: 'mm', harness: s.harness, sessionId: s.id, rootId: s.rootId, ledgerSeq: 9_000_001, ts: T0 + 500, startTs: null, model: null, agent: null, tokens: { input: 1, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.01, aiu: null, ttftMs: null, durationMs: null, finish: null, source: 't' }], [])
        vi.advanceTimersByTime(300)
      })
      expect(container.querySelector('[class*="top-[34px]"]')).toBeTruthy()
      expect(container.textContent).toMatch(/300/)
      act(() => { vi.advanceTimersByTime(2500) })
      expect(container.querySelector('[class*="top-[34px]"]')).toBeNull()
    } finally { vi.useRealTimers() }
  })
})
