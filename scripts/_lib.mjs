// Shared helpers for scripts/*.mjs (Node >= 22, no dependencies).
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function parseArgs(argv, defaults) {
  const out = { ...defaults }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[k] = true
    else { out[k] = /^\d+$/.test(next) ? Number(next) : next; i++ }
  }
  return out
}

export class Report {
  constructor(title) { this.title = title; this.rows = []; console.log(`\n== ${title} ==`) }
  check(name, ok, detail = '') {
    this.rows.push({ name, ok, skipped: false })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
    return ok
  }
  info(name, detail) { console.log(`INFO  ${name}  — ${detail}`) }
  skip(name, detail) { this.rows.push({ name, ok: true, skipped: true }); console.log(`SKIP  ${name}  — ${detail}`) }
  finish() {
    const failed = this.rows.filter((r) => !r.ok).length
    console.log(`\n${this.title}: ${this.rows.length - failed}/${this.rows.length} ok${failed ? `, ${failed} FAILED` : ''}`)
    process.exitCode = failed ? 1 : 0
    return failed === 0
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function getJson(base, path) {
  const t0 = performance.now()
  const res = await fetch(base + path)
  const text = await res.text()
  const ms = performance.now() - t0
  let json = null
  try { json = JSON.parse(text) } catch { /* leave null */ }
  return { status: res.status, ms, bytes: Buffer.byteLength(text), json, text }
}

export async function waitForServer(base, timeoutMs = 30000) {
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    try { const r = await fetch(base + '/api/meta'); if (r.ok) return performance.now() - t0 } catch { /* retry */ }
    await sleep(100)
  }
  throw new Error(`server at ${base} did not come up within ${timeoutMs} ms`)
}

/** Read /api/stream for `ms`, calling onFrame(frame, receivedAtMs). */
export async function readStream(base, ms, onFrame) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(base + '/api/stream', { signal: ctrl.signal, headers: { accept: 'text/event-stream' } })
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2)
        const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
        if (!data) { if (raw.startsWith(':')) onFrame({ type: '_ping' }, Date.now()); continue }
        try { onFrame(JSON.parse(data), Date.now()) } catch { /* ignore */ }
      }
    }
  } catch (e) {
    if (e?.name !== 'AbortError') throw e
  } finally { clearTimeout(timer) }
}

export function startServer(port, extraArgs = []) {
  const child = spawn(process.execPath, [join(ROOT, 'bin/occ.mjs'), '--no-open', '--port', String(port), ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.resume(); child.stderr.resume()
  return child
}

export function psStats(pid) {
  const out = execFileSync('ps', ['-o', 'rss=,cputime=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/)
  const rssMb = Number(out[0]) / 1024
  const parts = out[1].split(':').map(Number) // [H:]M:SS.ss
  let cpu = 0
  for (const p of parts) cpu = cpu * 60 + p
  return { rssMb, cpuSec: cpu }
}
