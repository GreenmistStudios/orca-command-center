import { randomUUID } from 'node:crypto'
import type {
  ActivityEvent,
  OrcaSnapshot,
  ServerMeta,
  SessionSummary,
  StreamEvent,
  StreamPayload,
} from '../../shared/contract.js'
import type { Clock, HubPublisher, Logger } from '../types.js'

export interface HubClient {
  write(frame: string): boolean
  end(): void
  readonly writableLength: number
}

export interface Hub extends HubPublisher {
  /** Registers a client. Sends hello, then replays frames after `since` or sends resync. */
  subscribe(since: number | null, client: HubClient): () => void
  clientCount(): number
  close(): void
}

export interface HubOptions {
  meta: () => ServerMeta
  now?: Clock
  flushMs?: number
  replaySize?: number
  maxBufferedBytes?: number
  log?: Logger
}

type Frame = { seq: number; text: string }

function frame(seq: number, event: StreamEvent): string {
  return `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`
}

/** Coalesce queued payloads into at most one payload per type (ordered by first appearance). */
export function coalesce(queue: StreamPayload[]): StreamPayload[] {
  const order: StreamPayload['type'][] = []
  const activity = new Map<string, ActivityEvent>()
  const sessions = new Map<string, SessionSummary>()
  const removed = new Set<string>()
  let orca: Partial<OrcaSnapshot> = {}
  const runIds = new Set<string>()
  const last = new Map<string, StreamPayload>()

  for (const p of queue) {
    if (!order.includes(p.type)) order.push(p.type)
    switch (p.type) {
      case 'activity':
        for (const e of p.events) {
          const prev = activity.get(e.id)
          if (!prev || e.rev >= prev.rev) activity.set(e.id, e)
        }
        break
      case 'sessions':
        for (const s of p.sessions) {
          sessions.set(s.id, s)
          removed.delete(s.id)
        }
        for (const id of p.removed) {
          sessions.delete(id)
          removed.add(id)
        }
        break
      case 'orca':
        orca = { ...orca, ...p.orca }
        break
      case 'orchestration':
        for (const id of p.changedRunIds) runIds.add(id)
        last.set('orchestration', p)
        break
      default:
        last.set(p.type, p)
    }
  }

  const out: StreamPayload[] = []
  for (const type of order) {
    switch (type) {
      case 'activity':
        out.push({ type, events: [...activity.values()] })
        break
      case 'sessions':
        out.push({ type, sessions: [...sessions.values()], removed: [...removed] })
        break
      case 'orca':
        out.push({ type, orca })
        break
      case 'orchestration': {
        const p = last.get('orchestration') as Extract<StreamPayload, { type: 'orchestration' }>
        out.push({ type, summary: p.summary, changedRunIds: [...runIds] })
        break
      }
      default:
        out.push(last.get(type)!)
    }
  }
  return out
}

export function createHub(options: HubOptions): Hub {
  const flushMs = options.flushMs ?? 250
  const replaySize = options.replaySize ?? 2000
  const maxBuffered = options.maxBufferedBytes ?? 4 * 1024 * 1024
  const bootId = randomUUID()
  const clients = new Set<HubClient>()
  let ring: Frame[] = []
  let seq = 0
  let queue: StreamPayload[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const drop = (c: HubClient) => {
    clients.delete(c)
    try {
      c.end()
    } catch {
      /* ignore */
    }
  }

  const send = (c: HubClient, text: string): boolean => {
    try {
      c.write(text)
      if (c.writableLength > maxBuffered) {
        options.log?.warn('sse client too slow; dropping')
        drop(c)
        return false
      }
      return true
    } catch {
      drop(c)
      return false
    }
  }

  const flush = () => {
    timer = null
    if (queue.length === 0 || closed) return
    const payloads = coalesce(queue)
    queue = []
    for (const p of payloads) {
      seq += 1
      const text = frame(seq, { ...p, seq } as StreamEvent)
      ring.push({ seq, text })
      if (ring.length > replaySize) ring = ring.slice(ring.length - replaySize)
      for (const c of [...clients]) send(c, text)
    }
  }

  return {
    get seq() {
      return seq
    },
    bootId,
    publish(payload) {
      if (closed) return
      queue.push(payload)
      if (!timer) {
        timer = setTimeout(flush, flushMs)
        timer.unref?.()
      }
    },
    subscribe(since, client) {
      let alive = send(client, frame(seq, { type: 'hello', seq, bootId, meta: options.meta() }))
      if (alive && since !== null && since !== seq) {
        const oldest = ring[0]?.seq
        if (since > seq) {
          alive = send(client, frame(seq, { type: 'resync', seq, reason: 'cursor-ahead' }))
        } else if (oldest !== undefined && since >= oldest - 1) {
          for (const f of ring) {
            if (f.seq > since && !(alive = send(client, f.text))) break
          }
        } else {
          alive = send(client, frame(seq, { type: 'resync', seq, reason: 'cursor-too-old' }))
        }
      }
      if (alive && !closed) clients.add(client)
      return () => void clients.delete(client)
    },
    clientCount: () => clients.size,
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      for (const c of [...clients]) drop(c)
      clients.clear()
    },
  }
}
