import { render, type RenderResult } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import type { ReactElement } from 'react'
import { createMockBackend } from '../../src/client/api/mock'
import { resetOccStore, useOcc, type UiState } from '../../src/client/state/store'
import type { BootstrapPayload } from '../../src/shared/contract'

/** Fixed clock for deterministic mock data in tests (2026-10-26 12:00 local-ish). */
export const TEST_NOW = Date.UTC(2026, 9, 26, 12, 0, 0)

/** Bootstrap payload of the mock fleet without live timers. */
export function mockBootstrap(opts: { scenario?: 'healthy' | 'degraded'; now?: number } = {}): BootstrapPayload {
  return createMockBackend({ now: opts.now ?? Date.now(), live: false, scenario: opts.scenario }).bootstrap()
}

/**
 * Reset the zustand store, apply a bootstrap (default: mock fleet) and render `ui` inside the
 * providers the app uses (reduced motion, tooltips).
 */
export function renderWithMockStore(
  ui: ReactElement,
  opts: { bootstrap?: BootstrapPayload | null; uiState?: Partial<UiState> } = {},
): RenderResult {
  resetOccStore(opts.uiState)
  if (opts.bootstrap !== null) useOcc.getState().applyBootstrap(opts.bootstrap ?? mockBootstrap())
  return render(
    <MotionConfig reducedMotion="always">
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </MotionConfig>,
  )
}
