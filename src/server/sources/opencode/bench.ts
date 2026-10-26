/**
 * Manual perf check against the real opencode.db (read-only). Run:
 *   npx tsx src/server/sources/opencode/bench.ts [path-to-opencode.db]
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_THRESHOLDS_FOR_BENCH, benchConfig } from './bench-config.js'
import { createLogger } from '../../lib/log.js'
import { createOpenCodeSource } from './index.js'

void DEFAULT_THRESHOLDS_FOR_BENCH
const path = process.argv[2] ?? join(homedir(), '.local/share/opencode/opencode.db')
const config = benchConfig(path)
const src = createOpenCodeSource({ config, log: createLogger({ verbose: false, prefix: 'bench' }), now: Date.now })

const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6
let t = process.hrtime.bigint()
await src.start()
const seedMs = ms(t)
const h = src.health()
console.log(`status=${h.status} mode=${h.version} detail="${h.detail}"`)
console.log(`seed: ${seedMs.toFixed(1)} ms`)

t = process.hrtime.bigint()
const sessions = src.listSessions(Date.now() - config.windowMs)
console.log(`listSessions(window): ${sessions.length} sessions in ${ms(t).toFixed(1)} ms`)

t = process.hrtime.bigint()
for (let i = 0; i < 1000; i++) src.tick()
console.log(`idle tick: ${(ms(t) / 1000).toFixed(4)} ms avg (1000 ticks)`)

// largest window session = most parts-heavy proxy: the one with most cost/tokens
const biggest = [...sessions].sort((a, b) => b.tokens.cacheRead - a.tokens.cacheRead)[0]
if (biggest) {
  t = process.hrtime.bigint()
  const c = src.getCounters(biggest.id)
  console.log(`getCounters(${biggest.id}, "${biggest.title.slice(0, 40)}"): ${ms(t).toFixed(1)} ms`, JSON.stringify(c))
  t = process.hrtime.bigint()
  src.getToolStats([biggest.id])
  console.log(`getToolStats: ${ms(t).toFixed(1)} ms`)
  t = process.hrtime.bigint()
  src.getTranscript(biggest.id, { limit: 40 })
  console.log(`getTranscript(40): ${ms(t).toFixed(1)} ms`)
  t = process.hrtime.bigint()
  const a = src.getActivity([biggest.id], { limit: 200 })
  console.log(`getActivity(200): ${a.events.length} events in ${ms(t).toFixed(1)} ms`)
  t = process.hrtime.bigint()
  src.getFileChanges([biggest.id])
  console.log(`getFileChanges: ${ms(t).toFixed(1)} ms`)
}
t = process.hrtime.bigint()
const recent = src.recentActivity({ sinceMs: Date.now() - 3600_000, limit: 500 })
console.log(`recentActivity: ${recent.length} events in ${ms(t).toFixed(1)} ms`)

// ── usage samples (Task-19): Σ samples must equal the session row totals exactly
{
  const { openReadOnly, OPENCODE_DENIED_TABLES } = await import('../../lib/sqlite.js')
  const db = openReadOnly(path, { deniedTables: OPENCODE_DENIED_TABLES })
  const top = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3)
  for (const s of top) {
    t = process.hrtime.bigint()
    const samples = src.getUsageSamples!([s.id])
    const took = ms(t)
    const row = db.get<Record<string, number>>(
      'SELECT cost, tokens_input AS i, tokens_output AS o, tokens_reasoning AS r, tokens_cache_read AS cr, tokens_cache_write AS cw FROM session WHERE id = ?',
      s.id,
    )!
    const sum = { i: 0, o: 0, r: 0, cr: 0, cw: 0, cost: 0 }
    const ttft: number[] = []
    for (const x of samples) {
      sum.i += x.tokens.input
      sum.o += x.tokens.output
      sum.r += x.tokens.reasoning
      sum.cr += x.tokens.cacheRead
      sum.cw += x.tokens.cacheWrite
      sum.cost += x.cost ?? 0
      if (x.ttftMs != null) ttft.push(x.ttftMs)
    }
    ttft.sort((a, b) => a - b)
    const match =
      sum.i === row.i && sum.o === row.o && sum.r === row.r && sum.cr === row.cr && sum.cw === row.cw && Math.abs(sum.cost - row.cost) < 1e-9
    console.log(
      `usage ${s.id}: ${samples.length} samples Σ in=${sum.i} out=${sum.o} rsn=${sum.r} cr=${sum.cr} cw=${sum.cw} cost=${sum.cost.toFixed(6)}` +
        ` | session row in=${row.i} out=${row.o} rsn=${row.r} cr=${row.cr} cw=${row.cw} cost=${Number(row.cost).toFixed(6)}` +
        ` | ${match ? 'EXACT MATCH' : 'MISMATCH'} | ttft p50=${ttft.length ? ttft[Math.floor(ttft.length / 2)] : 'n/a'} ms (${ttft.length} measured) | getUsageSamples ${took.toFixed(1)} ms`,
    )
  }
  db.close()
}
await src.stop()
