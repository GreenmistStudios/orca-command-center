import { homedir } from 'node:os'

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  const cps = Array.from(text)
  if (cps.length <= max) return { text, truncated: false }
  return { text: cps.slice(0, Math.max(0, max)).join('') + '…', truncated: true }
}

export function clip(text: string, max: number): string {
  return truncate(text, max).text
}

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stable(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((v) => stable(v, seen))
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value).sort()) out[k] = stable((value as Record<string, unknown>)[k], seen)
  return out
}

export function compactJson(value: unknown, max: number): string {
  let s: string
  try {
    s = JSON.stringify(stable(value, new WeakSet())) ?? 'undefined'
  } catch {
    s = String(value)
  }
  return clip(oneLine(s), max)
}

export function extractLinks(text: string, max: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const url = m[0].replace(/[.,;:!?)\]}>*_]+$/, '')
    if (url.length <= 'https://'.length || seen.has(url)) continue
    seen.add(url)
    out.push(url)
    if (out.length >= max) break
  }
  return out
}

export function basename(path: string): string {
  const p = path.replace(/[\\/]+$/, '')
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export function normalizePath(path: string, home: string = homedir()): string {
  let p = path
  if (p === '~') p = home
  else if (p.startsWith('~/')) p = home.replace(/\/+$/, '') + p.slice(1)
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p === '' ? '/' : p
}
