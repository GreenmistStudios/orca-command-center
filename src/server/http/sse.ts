import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Hub } from '../hub/hub.js'

export const PING_MS = 15_000

export function parseSince(req: IncomingMessage, query: URLSearchParams): number | null {
  const raw = (req.headers['last-event-id'] as string | undefined) ?? query.get('since')
  if (raw === undefined || raw === null || !/^\d+$/.test(raw.trim())) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

export function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  hub: Hub,
  pingMs = PING_MS,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  req.socket.setNoDelay(true)
  const unsubscribe = hub.subscribe(parseSince(req, query), {
    write: (frame) => res.write(frame),
    end: () => res.end(),
    get writableLength() {
      return res.writableLength
    },
  })
  const ping = setInterval(() => res.write(': ping\n\n'), pingMs)
  ping.unref?.()
  const cleanup = () => {
    clearInterval(ping)
    unsubscribe()
  }
  res.on('close', cleanup)
  res.on('error', cleanup)
}
