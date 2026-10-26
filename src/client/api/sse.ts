import type { StreamEvent } from '../../shared/contract'
import type { ConnectionState } from '../state/store'
import { isMockMode } from './types'

export interface StreamHandle { close(): void }

let warned = false

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
  const es = new EventSource(`/api/stream?since=${encodeURIComponent(String(args.since))}`)
  es.onopen = () => args.onState('live')
  es.onerror = () => args.onState(es.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting')
  es.onmessage = (m: MessageEvent<string>) => {
    try {
      args.onEvent(JSON.parse(m.data) as StreamEvent)
    } catch {
      if (!warned) { warned = true; console.warn('[occ] ignoring malformed stream frame') }
    }
  }
  return { close: () => es.close() }
}
