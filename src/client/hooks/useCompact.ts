import { useSyncExternalStore } from 'react'

/** Compact layout below the `lg` breakpoint (design-system §5). */
export const COMPACT_QUERY = '(max-width: 1023.98px)'

function mql(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_QUERY) : null
}

function subscribe(cb: () => void): () => void {
  const m = mql()
  if (!m) return () => {}
  m.addEventListener('change', cb)
  return () => m.removeEventListener('change', cb)
}

/** True when the viewport is < 1024 px. Views use it to hide minimap/legend. */
export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, () => mql()?.matches ?? false, () => false)
}
