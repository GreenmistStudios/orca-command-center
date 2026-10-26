#!/usr/bin/env node
// Safety audit against a running server + server source. Usage: node scripts/safety-audit.mjs [--port 4280]
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT, Report, getJson, parseArgs } from './_lib.mjs'

const args = parseArgs(process.argv.slice(2), { port: 4280 })
const base = `http://127.0.0.1:${args.port}`
const r = new Report('safety audit')

const redactPath = join(ROOT, 'dist/server/lib/redact.js')
if (!existsSync(redactPath)) { r.check('dist built', false, 'run npm run build'); r.finish(); process.exit(1) }
const { redactText } = await import(pathToFileURL(redactPath).href)

// Residual-secret detection: a response is dirty if redacting it changes it (it still holds an unredacted secret).
const stable = (s) => redactText(s) === s
const dataUrl = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{64,}/i
const scan = (label, text) => {
  const leaks = []
  if (!stable(text)) {
    // locate roughly: compare line-by-line over JSON-ish chunks
    const chunks = text.split(/(?<=[,{}\[\]])/)
    for (const c of chunks) if (!stable(c)) leaks.push(c.slice(0, 80).replace(/[A-Za-z0-9]{12,}/g, '…'))
  }
  if (dataUrl.test(text)) leaks.push('data: URL')
  return r.check(`no secrets / data URLs in ${label}`, leaks.length === 0, leaks.length ? `${leaks.length} hits, e.g. ${JSON.stringify(leaks.slice(0, 3))}` : `${(text.length / 1024).toFixed(0)} KB scanned`)
}

try {
  const boot = await getJson(base, '/api/bootstrap')
  if (boot.status !== 200) throw new Error(`bootstrap status ${boot.status}`)
  scan('bootstrap', boot.text)
  const sessions = boot.json.sessions
  const pick = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 6)
  let transcriptText = '', partText = '', diffText = '', nParts = 0, nDiffs = 0
  for (const s of pick) {
    const tr = await getJson(base, `/api/sessions/${encodeURIComponent(s.id)}/transcript?limit=100`)
    transcriptText += tr.text
    const items = (tr.json?.messages ?? []).flatMap((m) => m.items).filter((x) => x.kind === 'tool' || x.kind === 'file-change')
    for (const e of items.slice(-8)) {
      const id = e.id
      const p = await getJson(base, `/api/parts/${encodeURIComponent(id)}`)
      if (p.status === 200) { partText += p.text; nParts++ }
    }
    const fc = await getJson(base, `/api/file-changes?sessionId=${encodeURIComponent(s.id)}`)
    for (const c of (fc.json?.changes ?? []).slice(0, 5)) {
      const d = await getJson(base, `/api/file-changes/${encodeURIComponent(c.id)}/diff`)
      if (d.status === 200) { diffText += d.text; nDiffs++ }
    }
  }
  scan(`transcripts (${pick.length} sessions)`, transcriptText)
  scan(`part details (${nParts})`, partText)
  scan(`diffs (${nDiffs})`, diffText)
  const act = await getJson(base, '/api/activity?limit=500')
  scan('activity (500)', act.text)

  // Usage payloads: no long strings, no secrets, no request/response bodies.
  const rootCounts = new Map()
  for (const x of sessions) rootCounts.set(x.rootId, (rootCounts.get(x.rootId) ?? 0) + 1)
  const rootId = [...rootCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const urls = ['/api/usage?scope=fleet', '/api/usage/calls?scope=fleet&limit=500']
  if (rootId) urls.push(`/api/usage?scope=workflow&id=${encodeURIComponent(rootId)}`, `/api/usage?scope=session&id=${encodeURIComponent(rootId)}`, `/api/usage/calls?scope=workflow&id=${encodeURIComponent(rootId)}&limit=500`)
  const copilot = sessions.find((x) => x.harness === 'copilot')
  if (copilot) urls.push(`/api/usage?scope=session&id=${encodeURIComponent(copilot.id)}`)
  let usageText = ''
  let longest = 0
  const longStrings = []
  const walkJson = (v, path) => {
    if (typeof v === 'string') { longest = Math.max(longest, v.length); if (v.length > 200) longStrings.push(`${path} (${v.length})`) }
    else if (Array.isArray(v)) v.forEach((x, i) => walkJson(x, `${path}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkJson(x, `${path}.${k}`)
  }
  for (const u of urls) {
    const res = await getJson(base, u)
    if (res.status !== 200) { r.check(`usage fetch ${u}`, false, `status ${res.status}`); continue }
    usageText += res.text
    walkJson(res.json, u)
  }
  scan(`usage payloads (${urls.length})`, usageText)
  r.check('no usage string > 200 chars', longStrings.length === 0, longStrings.slice(0, 3).join(', ') || `longest ${longest} chars`)
  const banned = ['requestMessages', 'responseChunk', 'quotaSnapshots'].filter((w) => usageText.includes(w))
  r.check('no requestMessages / responseChunk / quotaSnapshots in usage payloads', banned.length === 0, banned.join(', '))
} catch (e) { r.check('fetch samples', false, e.message) }

// Source scans
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
const src = walk(join(ROOT, 'src/server')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
const denied = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:main\.)?(account|account_state|control_account|credential)\b/i
const deniedHits = []
for (const f of src) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (denied.test(line)) deniedHits.push(`${relative(ROOT, f)}:${i + 1}`) })
}
r.check('no SQL against denied tables', deniedHits.length === 0, deniedHits.join(', ') || `${src.length} server files scanned`)

const writeSql = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i
const writeHits = []
for (const f of src) {
  if (relative(ROOT, f).startsWith('src/server/lib/sqlite.ts')) continue
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (writeSql.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) writeHits.push(`${relative(ROOT, f)}:${i + 1}`) })
}
r.check('no write SQL in server source', writeHits.length === 0, writeHits.join(', '))

const cliUse = []
for (const f of src) {
  const rel = relative(ROOT, f)
  const text = readFileSync(f, 'utf8')
  if (/from\s+['"](?:node:)?child_process['"]|require\(['"](?:node:)?child_process['"]\)/.test(text) && !rel.endsWith('sources/orca/runner.ts') && rel !== 'src/server/main.ts') cliUse.push(rel)
}
r.check('child processes only via the orca CLI runner', cliUse.length === 0, cliUse.join(', ') || 'only sources/orca/runner.ts (+ main.ts browser opener)')
const runner = readFileSync(join(ROOT, 'src/server/sources/orca/runner.ts'), 'utf8')
const allow = [...runner.matchAll(/freeze\(\[\s*('[^\]]*)\]\)/g)].map((m) => m[1].replace(/['\s]/g, ''))
const expected = ['status,--json', 'worktree,ps,--json', 'terminal,list,--json']
r.check('orca CLI allowlist is exactly status / worktree ps / terminal list', JSON.stringify(allow) === JSON.stringify(expected), allow.join(' | '))

// Listening sockets
try {
  const out = execFileSync('lsof', ['-nP', `-iTCP:${args.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  const names = out.split('\n').slice(1).filter(Boolean).map((l) => l.trim().split(/\s+/).slice(-2, -1)[0] ?? l)
  r.check('listens on loopback only', names.length > 0 && names.every((n) => /^(127\.0\.0\.1|\[::1\]|localhost):/.test(n)), names.join(', '))
} catch { r.check('listens on loopback only', false, `nothing listening on ${args.port}`) }

r.finish()
