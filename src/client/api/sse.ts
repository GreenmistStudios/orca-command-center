import type { StreamEvent } from '../../shared/contract'
import type { ConnectionState } from '../state/store'
import { isMockMode } from './types'

export interface StreamHandle { close(): void }

let warned = false
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000

/**
 * Subscribe to `/api/stream` (or the mock stream). `onopen` → `live`; `onerror` → `reconnecting`
 * (EventSource retries by itself, sending `Last-Event-ID`). Malformed frames are ignored with a
 * single console warning.
 */
export function connectStream(args: {
  since: number
  onEvent: (e: StreamEvent) => void
  onState: (s: ConnectionState) => void
}): StreamHandle {
  if (isMockMode()) {
    args.onState('live')
    let off: (() => void) | null = null
    let closed = false
    void import('./mock').then((m) => { if (!closed) off = m.getMockBackend().connect(args.onEvent) })
    return { close: () => { closed = true; off?.() } }
  }
  let es: EventSource | null = null
  let closed = false
  let lastSeq = args.since
  let delay = RECONNECT_MIN_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  const open = () => {
    timer = null
    const cur = new EventSource(`/api/stream?since=${encodeURIComponent(String(lastSeq))}`)
    es = cur
    cur.onopen = () => { delay = RECONNECT_MIN_MS; args.onState('live') }
    cur.onerror = () => {
      if (cur.readyState !== EventSource.CLOSED) { args.onState('reconnecting'); return }
      // The browser gave up: retry ourselves with backoff (1 s → 2 s → … 30 s), resuming from the last seq.
      args.onState('offline')
      cur.close()
      if (closed || timer) return
      timer = setTimeout(open, delay)
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
    }
    cur.onmessage = (m: MessageEvent<string>) => {
      try {
        const e = JSON.parse(m.data) as StreamEvent
        if ('seq' in e && typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq
        args.onEvent(e)
      } catch {
        if (!warned) { warned = true; console.warn('[occ] ignoring malformed stream frame') }
      }
    }
  }
  open()
  return { close: () => { closed = true; if (timer) clearTimeout(timer); es?.close() } }
}
