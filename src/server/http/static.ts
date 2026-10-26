import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Config } from '../types.js'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

export const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

function sendBuffer(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | string) {
  const len = Buffer.byteLength(body)
  res.writeHead(status, { ...headers, 'Content-Length': String(len) })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function notBuilt(config: Config): string {
  const msg = config.dev
    ? 'Dev mode: open <a href="http://localhost:5173">http://localhost:5173</a>.'
    : 'The client is not built. Run <code>npm run build</code> and restart.'
  return `<!doctype html><meta charset="utf-8"><title>Orca Command Center</title><body style="font-family:system-ui;padding:2rem"><h1>Orca Command Center</h1><p>${msg}</p></body>`
}

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  config: Config,
): Promise<void> {
  const root = config.staticDir
  const htmlHeaders = { 'Content-Type': TYPES['.html']!, 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP }
  if (!root || !existsSync(path.join(root, 'index.html'))) {
    if (pathname === '/' || !path.extname(pathname)) {
      return sendBuffer(req, res, 200, { ...htmlHeaders }, notBuilt(config))
    }
    return sendBuffer(req, res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'Not found')
  }

  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return sendBuffer(req, res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request')
  }
  if (rel.includes('\0')) return sendBuffer(req, res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden')
  const absRoot = path.resolve(root)
  let file = path.resolve(absRoot, '.' + path.posix.normalize('/' + rel))
  if (rel.split(/[\\/]/).includes('..') || (file !== absRoot && !file.startsWith(absRoot + path.sep))) {
    return sendBuffer(req, res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden')
  }
  if (file === absRoot) file = path.join(absRoot, 'index.html')

  let isFile = false
  try {
    isFile = statSync(file).isFile()
  } catch {
    /* missing */
  }
  if (!isFile) {
    if (path.extname(rel)) {
      return sendBuffer(req, res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'Not found')
    }
    file = path.join(absRoot, 'index.html')
  }

  const ext = path.extname(file).toLowerCase()
  const headers: Record<string, string> = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' }
  if (path.basename(file) === 'index.html') {
    headers['Cache-Control'] = 'no-store'
    headers['Content-Security-Policy'] = CSP
  } else if (path.relative(absRoot, file).split(path.sep)[0] === 'assets') {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  } else {
    headers['Cache-Control'] = 'no-cache'
  }
  if (ext === '.html') headers['Content-Security-Policy'] = CSP
  try {
    sendBuffer(req, res, 200, headers, await readFile(file))
  } catch {
    sendBuffer(req, res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found')
  }
}
