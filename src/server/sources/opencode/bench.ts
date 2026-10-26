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
await src.stop()
