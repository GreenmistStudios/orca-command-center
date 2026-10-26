import { useEffect, useState } from 'react'

/**
 * Local 1 s clock. (The shared `useNow` passes an inline `subscribe` to useSyncExternalStore, which
 * resubscribes — and resets its snapshot — on every render and loops; this avoids depending on it.)
 */
export function useClock(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
