import { useReducedMotion } from 'motion/react'

/** Motion tokens (design-system §15.2). */
export const COUNTER_SPRING = { stiffness: 220, damping: 26, mass: 0.8 } as const
export const BAR_SPRING = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 } as const
export const GAUGE_SPRING = { stiffness: 160, damping: 22 } as const
export const CHIP_ENTER_MS = 180
export const CHIP_HOLD_MS = 700
export const CHIP_EXIT_MS = 320
export const CHIP_MERGE_MS = 300
export const MAX_CHIPS = 3
export const EWMA_TAU_S = 8
export const BUCKET_EASE_MS = 400
export const RANK_FLASH_MS = 400
export const METER_FADE_MS = 250
export const METER_TICK_MS = 1500
export const MAX_PARTICLES = 600

let override: boolean | null = null

/** Test override for reduced motion (`null` restores the real preference). */
export function setFlowReducedOverride(v: boolean | null): void {
  override = v
}

export function getFlowReducedOverride(): boolean | null {
  return override
}

/** Reduced-motion state: `motion`'s preference unless a test override is set. */
export function useFlowMotion(): { reduced: boolean } {
  const pref = useReducedMotion()
  return { reduced: override ?? Boolean(pref) }
}
