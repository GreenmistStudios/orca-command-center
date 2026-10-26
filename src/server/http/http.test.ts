import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiResponses, ServerMeta, StreamEvent } from '../../shared/contract.js'
import { createHub, type Hub } from '../hub/hub.js'
import type { Config, StoreReader } from '../types.js'
import { ROUTES } from './routes.js'
import { createHttpServer, type HttpServer } from './server.js'

const meta = { app: 'orca-command-center' } as ServerMeta

function fakeStore(): StoreReader & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {}
  const rec = (n: string, v: unknown) => (calls[n] = [...(calls[n] ?? []), v])
  return {
    calls,
    meta: () => meta,
    bootstrap: () => ({ seq: 0 }) as never,
    listSessions: (q) => (rec('listSessions', q), []),
    sessionDetail: (id) => (id === 'boom' ? (() => { throw new Error('secret stack') })() : id === 'known' ? ({ id } as never) : null),
    sessionTree: (id) => (id === 'known' ? ({ id } as never) : null),
    transcript: (id, o) => (rec('transcript', o), id === 'known' ? ({ items: [] } as never) : null),
    activity: (q) => (rec('activity', q), { events: [], before: null, hasMore: false }),
    part: (id) => (id === 'known' ? ({ id } as never) : null),
    fileChanges: () => [],
    fileDiff: (id) => (id === 'known' ? ({ id } as never) : null),
    artifacts: () => [],
    attention: () => [],
    stats: (w) => (rec('stats', w), {} as never),
    orca: () => ({}) as never,
    orchestration: () => ({}) as never,
    orchestrationRun: (id) => (id === 'known' ? ({ id } as never) : null),
    orchestrationTask: (id) => (id === 'known' ? ({ id } as never) : null),
    usage: (q) => (rec('usage', q), q.scope.id === 'nope' ? null : ({ scope: q.scope } as never)),
    usageCalls: (q) => (rec('usageCalls', q), q.scope.id === 'nope' ? null : ({ calls: [], before: null, hasMore: false } as never)),
  }
}

let dir: string
let config: Config
let hub: Hub
let srv: HttpServer
let base: string
let port: number
const store = fakeStore()
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'occ-static-'))
  mkdirSync(path.join(dir, 'assets'))
  writeFileSync(path.join(dir, 'index.html'), '<html>app</html>')
  writeFileSync(path.join(dir, 'assets', 'a.js'), 'x')
  writeFileSync(path.join(dir, 'assets', 'a.css'), 'x')
  writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>')
  writeFileSync(path.join(path.dirname(dir), 'occ-secret.txt'), 'secret')
  config = { host: '127.0.0.1', port: 0, dev: false, staticDir: dir, allowedHosts: [] } as unknown as Config
  hub = createHub({ meta: () => meta, flushMs: 20 })
  srv = createHttpServer({ config, store, hub, log: quiet, ssePingMs: 50 })
  const l = await srv.listen()
  port = l.port
  config.allowedHosts.push(`127.0.0.1:${port}`)
  base = `http://127.0.0.1:${port}`
})
afterAll(async () => {
  hub.close()
  await srv.close()
})

describe('routes', () => {
  it('routes every ApiResponses key', () => {
    const keys: Array<keyof ApiResponses> = [
      'GET /api/meta', 'GET /api/bootstrap', 'GET /api/sessions', 'GET /api/sessions/:id', 'GET /api/sessions/:id/tree',
      'GET /api/sessions/:id/transcript', 'GET /api/activity', 'GET /api/parts/:id', 'GET /api/file-changes',
      'GET /api/file-changes/:id/diff', 'GET /api/artifacts', 'GET /api/attention', 'GET /api/stats', 'GET /api/orca',
      'GET /api/orchestration', 'GET /api/orchestration/runs/:id', 'GET /api/orchestration/tasks/:id',
      'GET /api/usage', 'GET /api/usage/calls',
    ]
    expect(ROUTES.map((r) => r.key).sort()).toEqual(keys.sort())
  })

  it('every route returns 200 with security headers and no CORS', async () => {
    for (const r of ROUTES) {
      const p = r.path.replace(':id', 'known') + (r.path.startsWith('/api/usage') ? '?scope=session&id=known' : '')
      const res = await fetch(base + p)
      expect(res.status, p).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'")
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('parses query params', async () => {
    await fetch(`${base}/api/sessions?windowHours=2&harness=copilot&state=working&live=1&q=x&limit=5`)
    expect(store.calls.listSessions!.at(-1)).toEqual({ windowMs: 7_200_000, harness: 'copilot', state: 'working', liveOnly: true, q: 'x', limit: 5 })
    await fetch(`${base}/api/activity?kinds=tool,mcp&limit=10&rootId=r`)
    expect(store.calls.activity!.at(-1)).toMatchObject({ kinds: ['tool', 'mcp'], limit: 10, rootId: 'r' })
    await fetch(`${base}/api/sessions/known/transcript`)
    expect(store.calls.transcript!.at(-1)).toEqual({ before: undefined, limit: 40 })
  })

  it('rejects bad input with 400', async () => {
    for (const q of ['/api/sessions?bogus=1', '/api/sessions?limit=2001', '/api/sessions?limit=1x', '/api/sessions?harness=nope',
      '/api/sessions?state=nope', '/api/activity?kinds=tool,zzz', '/api/activity?limit=5001', '/api/stats?windowHours=0',
      '/api/sessions/known/transcript?limit=201', '/api/activity?sessionId=a&rootId=b']) {
      const res = await fetch(base + q)
      expect(res.status, q).toBe(400)
      expect((await res.json()).code).toBe('bad_request')
    }
    expect((await (await fetch(`${base}/api/sessions?bogus=1`)).json()).error).toContain('bogus')
  })

  it('parses usage params', async () => {
    await fetch(`${base}/api/usage?scope=workflow&id=r1&windowHours=2&bucketMs=5000&middle=model`)
    expect(store.calls.usage!.at(-1)).toEqual({ scope: { kind: 'workflow', id: 'r1' }, windowMs: 7_200_000, bucketMs: 5000, middle: 'model' })
    await fetch(`${base}/api/usage?scope=fleet`)
    expect(store.calls.usage!.at(-1)).toEqual({ scope: { kind: 'fleet', id: null }, windowMs: undefined, bucketMs: undefined, middle: undefined })
    await fetch(`${base}/api/usage/calls?scope=run&id=x&before=1:a&limit=10`)
    expect(store.calls.usageCalls!.at(-1)).toEqual({ scope: { kind: 'run', id: 'x' }, before: '1:a', limit: 10 })
    await fetch(`${base}/api/usage/calls?scope=session&id=x`)
    expect(store.calls.usageCalls!.at(-1)).toMatchObject({ limit: 200 })
  })

  it('validates usage params', async () => {
    for (const q of ['/api/usage', '/api/usage?scope=nope', '/api/usage?scope=workflow', '/api/usage?scope=fleet&bogus=1',
      '/api/usage?scope=fleet&windowHours=0', '/api/usage?scope=fleet&windowHours=721', '/api/usage?scope=fleet&bucketMs=999',
      '/api/usage?scope=fleet&bucketMs=86400001', '/api/usage?scope=fleet&middle=x', '/api/usage/calls?scope=session',
      '/api/usage/calls?scope=session&id=a&limit=0', '/api/usage/calls?scope=session&id=a&limit=2001']) {
      const res = await fetch(base + q)
      expect(res.status, q).toBe(400)
    }
    expect((await fetch(`${base}/api/usage?scope=session&id=nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/usage/calls?scope=session&id=nope`)).status).toBe(404)
  })

  it('503 unavailable when the store has no usage support', async () => {
    const { usage, usageCalls, ...bare } = fakeStore()
    void usage
    void usageCalls
    const { handleApi } = await import('./routes.js')
    const r = handleApi(bare, '/api/usage', new URLSearchParams('scope=fleet'))
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ code: 'unavailable' })
    expect(handleApi(bare, '/api/usage/calls', new URLSearchParams('scope=fleet')).status).toBe(503)
  })

  it('404 for unknown ids / routes, 500 without stack', async () => {
    expect((await fetch(`${base}/api/sessions/nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404)
    const res = await fetch(`${base}/api/sessions/boom`)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('secret stack')
    expect(JSON.parse(text).code).toBe('internal')
  })

  it('405 for non-GET, 403 for bad Host', async () => {
    expect((await fetch(`${base}/api/meta`, { method: 'POST' })).status).toBe(405)
    const http = await import('node:http')
    const bad = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/meta', headers: { Host: 'evil.com:4271' } }, (r) => {
          let body = ''
          r.on('data', (d) => (body += d))
          r.on('end', () => resolve({ status: r.statusCode!, body }))
        })
        .on('error', reject)
    })
    expect(bad.status).toBe(403)
    expect(JSON.parse(bad.body)).toEqual({ error: 'Host not allowed', code: 'bad_request' })
  })
})

describe('static', () => {
  it('serves files with types and caching', async () => {
    const js = await fetch(`${base}/assets/a.js`)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await fetch(`${base}/assets/a.css`)).headers.get('content-type')).toContain('text/css')
    expect((await fetch(`${base}/favicon.svg`)).headers.get('content-type')).toBe('image/svg+xml')
    const idx = await fetch(`${base}/`)
    expect(idx.headers.get('content-type')).toContain('text/html')
    expect(idx.headers.get('cache-control')).toBe('no-store')
    expect(idx.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('SPA fallback for extension-less paths, 404 for missing files', async () => {
    expect(await (await fetch(`${base}/session/abc`)).text()).toBe('<html>app</html>')
    expect((await fetch(`${base}/missing.js`)).status).toBe(404)
  })

  it('blocks traversal', async () => {
    const net = await import('node:net')
    for (const p of ['/../occ-secret.txt', '/assets/../../occ-secret.txt', '/%2e%2e/occ-secret.txt', '/..%2foc-secret.txt']) {
      const status = await new Promise<string>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`))
        let buf = ''
        s.on('data', (d) => (buf += d))
        s.on('close', () => resolve(buf))
      })
      expect(status, p).not.toContain('secret\n')
      expect(status.split('\r\n\r\n')[1] ?? '', p).not.toBe('secret')
    }
  })

  it('shows a not-built page when staticDir is missing', async () => {
    const c2 = { ...config, staticDir: path.join(dir, 'nope'), allowedHosts: config.allowedHosts } as Config
    const s2 = createHttpServer({ config: { ...c2, port: 0 }, store, hub, log: quiet })
    const l = await s2.listen()
    c2.allowedHosts.push(`127.0.0.1:${l.port}`)
    const res = await fetch(l.url + '/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('not built')
    await s2.close()
  })
})

async function readFrames(res: Response, count: number): Promise<string> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while ((buf.match(/\n\n/g) ?? []).length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value)
  }
  await reader.cancel()
  return buf
}
const parse = (buf: string) =>
  buf.split('\n\n').filter((f) => f.includes('data: ')).map((f) => JSON.parse(f.split('data: ')[1]!) as StreamEvent)

describe('sse', () => {
  it('hello → published frame → replay → resync', async () => {
    const ac = new AbortController()
    const res = await fetch(`${base}/api/stream`, { signal: ac.signal })
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    hub.publish({ type: 'attention', items: [] })
    const live = parse(await readFrames(res, 2))
    expect(live.map((e) => e.type)).toEqual(['hello', 'attention'])
    const seq = live[1]!.seq
    ac.abort()

    hub.publish({ type: 'attention', items: [] })
    await new Promise((r) => setTimeout(r, 80))
    const replay = parse(await readFrames(await fetch(`${base}/api/stream`, { headers: { 'Last-Event-ID': String(seq) } }), 2))
    expect(replay.map((e) => e.type)).toEqual(['hello', 'attention'])
    expect(replay[1]!.seq).toBe(seq + 1)

    const q = parse(await readFrames(await fetch(`${base}/api/stream?since=${seq + 100}`), 2))
    expect(q[1]).toMatchObject({ type: 'resync', reason: 'cursor-ahead' })
  })

  it('sends pings', async () => {
    const buf = await readFrames(await fetch(`${base}/api/stream`), 2)
    expect(buf).toContain(': ping')
  })
})
