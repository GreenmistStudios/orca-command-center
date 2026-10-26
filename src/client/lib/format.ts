const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

/** `12s`, `3m`, `2h 5m`, `1d 3h`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** `now`, `12s ago`, `3m ago`, `2h ago`, then `Oct 25` after 24 h. */
export function formatRelative(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 5000) return 'now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const d = new Date(ts)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** `HH:MM:SS` (local time). */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** `Mon, Oct 26`. */
export function formatDay(ts: number): string {
  const d = new Date(ts)
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** `$0.42`, `<$0.01`, `$0`. */
export function formatCost(n: number): string {
  if (!n) return '$0'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

/** `950`, `113.5k`, `2.1M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** Thousands separators. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/** `claude-opus-5.5` → `opus-5.5`; other ids unchanged. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return ''
  return model.replace(/^claude-/, '')
}

/** Path relative to `root` when inside it, else with the home directory collapsed to `~`. */
export function shortPath(path: string, root?: string | null): string {
  if (root && path.startsWith(root.endsWith('/') ? root : root + '/')) {
    return path.slice(root.length).replace(/^\//, '')
  }
  return path.replace(/^\/(Users|home)\/[^/]+/, '~')
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
