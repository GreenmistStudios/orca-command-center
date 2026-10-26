import { useEffect, useRef, useState } from 'react'

/** Observe an element's content box. Returns `[ref, {width,height}]`. */
export function useElementSize<T extends HTMLElement = HTMLDivElement>(): [
  React.RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setSize((p) => (p.width === r.width && p.height === r.height ? p : { width: r.width, height: r.height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}
