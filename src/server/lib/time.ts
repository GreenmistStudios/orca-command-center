/** Parse assorted timestamp encodings into epoch ms; null when not understood. */
export function parseTime(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    if (value >= 1e12) return Math.round(value)
    if (value > 1e9) return Math.round(value * 1000)
    return null
  }
  if (typeof value !== 'string') return null
  const s = value.trim()
  const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s)
  if (sql) {
    const t = Date.parse(`${sql[1]}T${sql[2]}Z`)
    return Number.isNaN(t) ? null : t
  }
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(s)) {
    const t = Date.parse(s)
    return Number.isNaN(t) ? null : t
  }
  return null
}
