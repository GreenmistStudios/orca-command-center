import { useCallback, useRef } from 'react'

/**
 * Cursor spotlight: returns `{ ref, onPointerMove }` to spread on a `relative` element that contains
 * an `<span className="orca-spotlight"/>`. Writes `--spot-x/--spot-y` CSS vars without re-rendering.
 */
export function useSpotlight<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null)
  const onPointerMove = useCallback((e: React.PointerEvent<T>) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--spot-x', `${e.clientX - r.left}px`)
    el.style.setProperty('--spot-y', `${e.clientY - r.top}px`)
  }, [])
  return { ref, onPointerMove }
}
