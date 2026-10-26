import { useEffect, useState } from 'react'

/** Returns `value` after it has been stable for `ms`. */
export function useDebouncedValue<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}
