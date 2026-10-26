import { useEffect, useRef } from 'react'

/** Run `fn` every `ms` (null pauses). Always calls the latest `fn`. */
export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (ms == null) return
    const id = setInterval(() => ref.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}
