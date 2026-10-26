import { useNow } from '../hooks/useNow'
import { formatDuration, formatRelative } from '../lib/format'

/** `12s ago` style label, ticking every `intervalMs` (default 5 s). */
export function RelativeTime({ ts, className, intervalMs = 5000 }: { ts: number; className?: string; intervalMs?: number }) {
  const now = useNow(intervalMs)
  return (
    <time dateTime={new Date(ts).toISOString()} className={className} title={new Date(ts).toLocaleString()}>
      {formatRelative(ts, now)}
    </time>
  )
}

/** Duration between `start` and `end` (live-ticking when `end` is null). */
export function Duration({ start, end, className }: { start: number; end: number | null; className?: string }) {
  const now = useNow(end == null ? 1000 : 60_000)
  return <span className={className}>{formatDuration((end ?? now) - start)}</span>
}
