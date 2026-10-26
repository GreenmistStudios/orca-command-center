#!/usr/bin/env node
// Ledger-vs-harness reconciliation against a running server. Usage: node scripts/usage-reconcile.mjs [--port 4280]
import { Report, getJson, parseArgs, sleep, waitForServer } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2), { port: 4280 })
const base = `http://127.0.0.1:${args.port}`
const r = new Report(`usage reconcile ${base}`)
const FIELDS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']
const zero = () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
const add = (a, b) => { for (const k of FIELDS) a[k] += b?.[k] ?? 0; return a }
const usage = async (scope, id) => (await getJson(base, `/api/usage?scope=${scope}${id ? `&id=${encodeURIComponent(id)}` : ''}`)).json

try { await waitForServer(base, 30000) } catch (e) { r.check('server reachable', false, e.message); r.finish(); process.exit(1) }

// Wait for the background ledger seed.
let fleet
for (let i = 0; i < 60; i++) {
  fleet = await usage('fleet')
  const c = fleet?.coverage
  if (c && c.sessionsWithUsage >= c.sessions) break
  await sleep(500)
}
r.info('coverage', JSON.stringify(fleet?.coverage?.sessions != null ? { sessions: fleet.coverage.sessions, withUsage: fleet.coverage.sessionsWithUsage } : fleet?.coverage))

const { json } = await getJson(base, '/api/sessions')
const sessions = json?.sessions ?? []
const oc = sessions.filter((s) => s.harness === 'opencode')
const cp = sessions.filter((s) => s.harness !== 'opencode')
r.info('sessions', `${sessions.length} total · ${oc.length} opencode · ${cp.length} other`)

const rows = []
const per = new Map()
for (const s of oc) {
  const u = await usage('session', s.id)
  per.set(s.id, u)
  const t = u?.totals
  const tokOk = !!t && FIELDS.every((k) => (t.tokens?.[k] ?? 0) === (s.tokens?.[k] ?? 0))
  const costOk = !!t && Math.abs((t.cost ?? 0) - (s.cost ?? 0)) <= 1e-6
  rows.push({ id: s.id.slice(0, 16), tokOk, costOk, ledger: FIELDS.map((k) => t?.tokens?.[k] ?? '?').join('/'), session: FIELDS.map((k) => s.tokens?.[k] ?? 0).join('/'), ledgerCost: t?.cost, sessionCost: s.cost })
}
const bad = rows.filter((x) => !x.tokOk || !x.costOk)
if (bad.length) { console.log('\nMismatches (input/output/reasoning/cacheRead/cacheWrite):'); console.table(bad) }
r.check(`OpenCode session tokens exact (${rows.length})`, rows.every((x) => x.tokOk), `${rows.filter((x) => !x.tokOk).length} mismatches`)
r.check(`OpenCode session cost within 1e-6 (${rows.length})`, rows.every((x) => x.costOk), `${rows.filter((x) => !x.costOk).length} mismatches`)

// Workflows: roots with children.
const byRoot = new Map()
for (const s of sessions) (byRoot.get(s.rootId) ?? byRoot.set(s.rootId, []).get(s.rootId)).push(s)
let wfN = 0; const wfBad = []
for (const [root, members] of byRoot) {
  if (members.length < 2) continue
  const ocMembers = members.filter((m) => m.harness === 'opencode')
  if (ocMembers.length !== members.length) continue // mixed-harness: informational only
  wfN++
  const w = await usage('workflow', root)
  const sum = zero(); let cost = 0
  for (const m of members) { add(sum, per.get(m.id)?.totals?.tokens); cost += per.get(m.id)?.totals?.cost ?? 0 }
  const ok = w?.totals && FIELDS.every((k) => w.totals.tokens[k] === sum[k]) && Math.abs(w.totals.cost - cost) <= 1e-6
  if (!ok) wfBad.push({ root: root.slice(0, 16), members: members.length, wf: FIELDS.map((k) => w?.totals?.tokens?.[k]).join('/'), sum: FIELDS.map((k) => sum[k]).join('/'), wfCost: w?.totals?.cost, sumCost: cost })
}
if (wfBad.length) { console.log('\nWorkflow mismatches:'); console.table(wfBad) }
r.check(`workflow totals == Σ sessions (${wfN} OpenCode-only workflows)`, wfBad.length === 0, `${wfBad.length} mismatches`)

// Fleet window ≤ Σ sessions (all harnesses; Σ includes whole-session totals, fleet only the window).
fleet = await usage('fleet')
const sumAll = zero() // re-read after the fleet read so live growth cannot invert the inequality
for (const s of oc) add(sumAll, (await usage('session', s.id))?.totals?.tokens)
const ocFleet = fleet.byHarness?.find?.((h) => h.harness === 'opencode')?.totals
r.check('fleet window tokens ≤ Σ session tokens (OpenCode)', ocFleet ? FIELDS.every((k) => (ocFleet.tokens?.[k] ?? 0) <= sumAll[k]) : true,
  ocFleet ? `fleet opencode input+output ${(ocFleet.tokens?.input ?? 0) + (ocFleet.tokens?.output ?? 0)} vs Σ ${sumAll.input + sumAll.output}` : 'no byHarness row; skipped comparison')
const fleetTot = fleet.totals.inflow + fleet.totals.outflow
const sumTot = sessions.reduce((a, s) => a + (s.tokens ? FIELDS.reduce((x, k) => x + (s.tokens[k] ?? 0), 0) : 0), 0)
r.info('fleet total tokens (all harnesses)', `${fleetTot} vs Σ session summaries ${sumTot}`)

// Copilot / other.
let cpBad = 0
for (const s of cp) {
  const u = await usage('session', s.id)
  const t = u?.totals
  const ok = t && t.calls >= 0 && (t.costedCalls === 0 ? t.cost == null || t.cost === 0 : true)
  if (!ok) { cpBad++; console.log(`  copilot ${s.id}: calls=${t?.calls} cost=${t?.cost} costedCalls=${t?.costedCalls}`) }
}
r.check(`Copilot sessions sane (${cp.length}): calls ≥ 0, cost null-aware`, cpBad === 0, `${cpBad} odd`)
r.finish()
