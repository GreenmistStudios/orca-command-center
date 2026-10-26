#!/usr/bin/env node
// API smoke test against a running server. Usage: node scripts/smoke.mjs [--port 4280] [--stream-ms 15000]
import { request as httpRequest } from 'node:http'
import { Report, getJson, parseArgs, readStream, waitForServer } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2), { port: 4280, 'stream-ms': 15000 })
const base = `http://127.0.0.1:${args.port}`
const r = new Report(`smoke ${base}`)
const has = (o, keys) => o && typeof o === 'object' && keys.every((k) => k in o)

try { await waitForServer(base, 30000) } catch (e) { r.check('server reachable', false, e.message); r.finish(); process.exit(1) }

const meta = await getJson(base, '/api/meta')
r.check('/api/meta shape', meta.status === 200 && has(meta.json, ['app', 'version', 'bootId', 'sources', 'orca', 'readOnly']) && meta.json.readOnly === true,
  `${meta.ms.toFixed(0)} ms · sources: ${(meta.json?.sources ?? []).map((s) => `${s.id}=${s.status}`).join(' ')}`)

const boot = await getJson(base, '/api/bootstrap')
const b = boot.json
r.check('/api/bootstrap shape', boot.status === 200 && has(b, ['meta', 'sessions', 'orca', 'attention', 'activity', 'orchestration', 'stats']),
  `${boot.ms.toFixed(0)} ms · ${(boot.bytes / 1024).toFixed(0)} KB · ${b?.sessions?.length} sessions, ${b?.activity?.length} activity`)
r.check('bootstrap ≤ 2 MB', boot.bytes <= 2 * 1024 * 1024, `${(boot.bytes / 1048576).toFixed(2)} MB`)
r.check('bootstrap ≤ 1.5 s', boot.ms <= 1500, `${boot.ms.toFixed(0)} ms`)

const sessions = b?.sessions ?? []
const roots = sessions.filter((s) => !s.parentId)
const counts = new Map()
for (const s of sessions) counts.set(s.rootId, (counts.get(s.rootId) ?? 0) + 1)
const rootId = [...counts.entries()].sort((a, b2) => b2[1] - a[1])[0]?.[0] ?? roots[0]?.id
r.check('has sessions', sessions.length > 0, `${sessions.length} total, ${roots.length} roots`)

if (rootId) {
  const tree = await getJson(base, `/api/sessions/${encodeURIComponent(rootId)}/tree`)
  r.check('tree for most active root', tree.status === 200 && tree.json && typeof tree.json === 'object', `${tree.ms.toFixed(0)} ms · ${(tree.bytes / 1024).toFixed(0)} KB · root ${rootId} (${counts.get(rootId)} sessions)`)
  const detail = await getJson(base, `/api/sessions/${encodeURIComponent(rootId)}`)
  r.check('session detail', detail.status === 200, `${detail.ms.toFixed(0)} ms`)
  const tr = await getJson(base, `/api/sessions/${encodeURIComponent(rootId)}/transcript?limit=50`)
  r.check('transcript page', tr.status === 200 && has(tr.json, ['messages', 'hasMore']), `${tr.ms.toFixed(0)} ms · ${(tr.bytes / 1024).toFixed(0)} KB · ${tr.json?.messages?.length} messages`)
}

const act = await getJson(base, '/api/activity?limit=200')
r.check('/api/activity?limit=200', act.status === 200 && has(act.json, ['events']), `${act.ms.toFixed(0)} ms · ${act.json?.events?.length} events`)
const stats = await getJson(base, '/api/stats')
r.check('/api/stats', stats.status === 200 && has(stats.json, ['sessions', 'activity', 'windowMs']), `${stats.ms.toFixed(0)} ms`)
const orch = await getJson(base, '/api/orchestration')
r.check('/api/orchestration', orch.status === 200 && orch.json && typeof orch.json === 'object', `${orch.ms.toFixed(0)} ms · runs ${orch.json?.runs?.length ?? '?'}`)
const orca = await getJson(base, '/api/orca')
r.check('/api/orca', orca.status === 200, `running=${orca.json?.status?.running} pid=${orca.json?.status?.pid ?? '-'}`)
const bad = await getJson(base, '/api/sessions?bogus=1')
r.check('unknown query key → 400', bad.status === 400)
// Token flow usage API: shape + latency for each scope.
const SCOPE_KEYS = ['totals', 'rates', 'series', 'byModel', 'byAgent', 'bySession', 'byHarness', 'sankey', 'recentCalls', 'inFlight', 'coverage', 'ledgerSeq']
const usageScopes = [['fleet', ''], ...(rootId ? [['workflow', rootId], ['session', rootId], ['run', 'none']] : [])]
for (const [scope, id] of usageScopes) {
  const u = await getJson(base, `/api/usage?scope=${scope}${id ? `&id=${encodeURIComponent(id)}` : ''}`)
  if (scope === 'run' && u.status !== 200) { r.check('/api/usage?scope=run unknown id handled', u.status >= 400 && u.status < 500, `status ${u.status}`); continue }
  r.check(`/api/usage scope=${scope}`, u.status === 200 && has(u.json, SCOPE_KEYS) && has(u.json.totals, ['calls', 'tokens', 'inflow', 'outflow', 'cost']) && u.ms <= 500,
    `${u.ms.toFixed(0)} ms · ${(u.bytes / 1024).toFixed(0)} KB · ${u.json?.totals?.calls} calls`)
}
const uc = await getJson(base, `/api/usage/calls?scope=${rootId ? 'workflow' : 'fleet'}${rootId ? `&id=${encodeURIComponent(rootId)}` : ''}&limit=50`)
r.check('/api/usage/calls shape', uc.status === 200 && uc.json && typeof uc.json === 'object' && Array.isArray(uc.json.calls ?? uc.json.samples ?? uc.json.items), `${uc.ms.toFixed(0)} ms · keys ${Object.keys(uc.json ?? {}).join(',')}`)
const host = await new Promise((res) => {
  const q = httpRequest({ host: '127.0.0.1', port: args.port, path: '/api/meta', headers: { host: 'evil.example' } }, (x) => { x.resume(); res(x.statusCode) })
  q.on('error', () => res(0)); q.end()
})
r.check('bad Host header rejected', host === 403, `status ${host}`)

const counts2 = {}
let first = null
const t0 = Date.now()
await readStream(base, args['stream-ms'], (f) => { counts2[f.type] = (counts2[f.type] ?? 0) + 1; first ??= f })
r.info('usage SSE frames', `${counts2.usage ?? 0} in ${args['stream-ms'] / 1000}s`)
r.check('SSE hello first', first?.type === 'hello', `first frame: ${first?.type}`)
r.info('SSE frames', `${args['stream-ms'] / 1000}s: ${JSON.stringify(counts2)}`)
const nonPing = Object.entries(counts2).filter(([k]) => k !== '_ping').reduce((a, [, v]) => a + v, 0)
r.check('SSE ≤ 4 frames/s', nonPing / ((Date.now() - t0) / 1000) <= 4, `${(nonPing / ((Date.now() - t0) / 1000)).toFixed(2)}/s`)
r.finish()
