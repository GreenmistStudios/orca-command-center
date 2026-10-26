#!/usr/bin/env node
// Performance budgets (Plan §11). Starts its own server child. Usage: node scripts/perf.mjs [--port 4281] [--idle-ms 30000] [--rss-after-ms 60000]
import { Report, getJson, parseArgs, psStats, readStream, sleep, startServer, waitForServer } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2), { port: 4281, 'idle-ms': 30000, 'rss-after-ms': 60000 })
const base = `http://127.0.0.1:${args.port}`
const r = new Report('perf (Plan §11)')
const child = startServer(args.port)
const stop = () => { try { child.kill('SIGTERM') } catch { /* gone */ } }
process.on('exit', stop)
try {
  const t0 = performance.now()
  await waitForServer(base, 60000)
  let boot
  for (;;) { boot = await getJson(base, '/api/bootstrap'); if (boot.status === 200) break; await sleep(100) }
  const bootMs = performance.now() - t0
  r.check('time to first bootstrap ≤ 1.5 s', bootMs <= 1500, `${bootMs.toFixed(0)} ms (process start → first 200)`)
  r.check('bootstrap payload ≤ 2 MB', boot.bytes <= 2 * 1048576, `${(boot.bytes / 1024).toFixed(0)} KB`)

  // Usage report latency (background ledger seeding may still be running: cold = first call, warm = repeat).
  const roots = new Map()
  for (const x of boot.json?.sessions ?? []) roots.set(x.rootId, (roots.get(x.rootId) ?? 0) + 1)
  const rootId = [...roots.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (rootId) {
    const q = `/api/usage?scope=workflow&id=${encodeURIComponent(rootId)}`
    const cold = await getJson(base, q)
    await sleep(6000) // let background seeding settle
    await getJson(base, q)
    const warm = []
    for (let i = 0; i < 10; i++) warm.push((await getJson(base, q)).ms)
    warm.sort((a, b) => a - b)
    r.info('workflow usage report cold', `${cold.ms.toFixed(0)} ms`)
    r.check('workflow usage report warm ≤ 50 ms', warm[Math.floor(warm.length / 2)] <= 50, `median ${warm[Math.floor(warm.length / 2)].toFixed(1)} ms, max ${warm.at(-1).toFixed(1)} ms`)
  } else r.skip('usage report latency', 'no sessions')

  // SSE latency while measuring idle CPU: connection counts as a client, as in real use.
  const lat = []
  let frames = 0
  const cpuStart = psStats(child.pid)
  const wallStart = Date.now()
  const streamP = readStream(base, args['idle-ms'], (f, at) => {
    if (f.type === 'activity') {
      frames++
      for (const e of f.events) {
        if (e.harness === 'opencode' && e.rev > wallStart) lat.push(at - e.rev) // events that changed after we started
      }
    }
  })
  await streamP
  const cpuEnd = psStats(child.pid)
  const cpuPct = ((cpuEnd.cpuSec - cpuStart.cpuSec) / ((Date.now() - wallStart) / 1000)) * 100
  r.check('CPU < 2% over idle window', cpuPct < 2, `${cpuPct.toFixed(2)}% over ${((Date.now() - wallStart) / 1000).toFixed(0)} s (includes live fleet activity)`)

  if (lat.length >= 3) {
    lat.sort((a, b) => a - b)
    const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]
    r.check('SSE latency p95 ≤ 2 s (OpenCode)', p(0.95) <= 2000, `n=${lat.length} p50=${p(0.5)} ms p95=${p(0.95)} ms max=${lat.at(-1)} ms (receive time − part update time)`)
  } else {
    r.skip('SSE latency', `not measured: ${lat.length} live OpenCode events observed in window (${frames} activity frames)`)
  }

  const waitMore = args['rss-after-ms'] - (Date.now() - wallStart)
  if (waitMore > 0) await sleep(waitMore)
  const m = psStats(child.pid)
  r.check('RSS after 60 s ≤ 300 MB', m.rssMb <= 300, `${m.rssMb.toFixed(0)} MB`)
} catch (e) {
  r.check('perf run', false, e.message)
} finally {
  stop()
}
r.finish()
