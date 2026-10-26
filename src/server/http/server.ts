import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ApiError } from '../../shared/contract.js'
import type { Hub } from '../hub/hub.js'
import type { Config, Logger, StoreReader } from '../types.js'
import { handleApi } from './routes.js'
import { handleSse } from './sse.js'
import { serveStatic } from './static.js'

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
}

function json(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
    ...extra,
  })
  res.end(req.method === 'HEAD' ? undefined : text)
}

export interface HttpServer {
  listen(): Promise<{ url: string; port: number }>
  close(): Promise<void>
}

export function createHttpServer(deps: { config: Config; store: StoreReader; hub: Hub; log: Logger; ssePingMs?: number }): HttpServer {
  const { config, store, hub, log } = deps
  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
    const host = req.headers.host
    if (!host || !config.allowedHosts.includes(host)) {
      return json(req, res, 403, { error: 'Host not allowed', code: 'bad_request' } satisfies ApiError)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(req, res, 405, { error: 'Method not allowed', code: 'bad_request' } satisfies ApiError, { Allow: 'GET, HEAD' })
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return json(req, res, 400, { error: 'Bad request', code: 'bad_request' } satisfies ApiError)
    }
    const pathname = url.pathname
    if (pathname === '/api/stream') {
      for (const k of url.searchParams.keys()) {
        if (k !== 'since') return json(req, res, 400, { error: `Unknown query parameter: ${k}`, code: 'bad_request' } satisfies ApiError)
      }
      return handleSse(req, res, url.searchParams, hub, deps.ssePingMs)
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const r = handleApi(store, pathname, url.searchParams, log)
      return json(req, res, r.status, r.body)
    }
    serveStatic(req, res, pathname, config).catch((e) => {
      log.error('static failed: %s', e instanceof Error ? e.message : String(e))
      if (!res.headersSent) json(req, res, 500, { error: 'Internal server error', code: 'internal' } satisfies ApiError)
      else res.end()
    })
  })
  server.on('clientError', (_e, socket) => socket.destroy())

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
          server.off('error', reject)
          const port = (server.address() as AddressInfo).port
          const h = config.host.includes(':') ? `[${config.host}]` : config.host
          resolve({ url: `http://${h}:${port}`, port })
        })
      })
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve())
        server.closeIdleConnections()
        // SSE connections are ended by hub.close(); force any stragglers.
        setTimeout(() => server.closeAllConnections(), 500).unref()
      })
    },
  }
}
