import {
  ACTIVITY_KINDS,
  LIMITS,
  type ActivityKind,
  type AgentState,
  type ApiError,
  type ApiResponses,
  type Harness,
  type UsageScopeKind,
} from '../../shared/contract.js'
import type { Logger, StoreReader } from '../types.js'

export class BadRequest extends Error {}
export class Unavailable extends Error {}

const HARNESSES: readonly Harness[] = ['opencode', 'copilot', 'claude', 'codex', 'unknown']
const USAGE_SCOPES: readonly UsageScopeKind[] = ['fleet', 'workflow', 'session', 'run']
const STATES: readonly AgentState[] = ['working', 'blocked', 'waiting', 'error', 'done', 'idle', 'unknown']

type Query = URLSearchParams

interface RouteDef {
  key: keyof ApiResponses
  /** Path pattern; `:id` matches one URI-encoded segment. */
  path: string
  query: readonly string[]
  handle(store: StoreReader, params: { id: string }, q: Query): unknown | null
}

function int(name: string, raw: string | null, min: number, max: number): number | undefined {
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) throw new BadRequest(`Invalid ${name}: expected an integer`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new BadRequest(`Invalid ${name}: must be ${min}-${max}`)
  return n
}

function windowMs(q: Query): number | undefined {
  const h = int('windowHours', q.get('windowHours'), 1, 720)
  return h === undefined ? undefined : h * 3_600_000
}

function oneOf<T extends string>(name: string, raw: string | null, allowed: readonly T[]): T | undefined {
  if (raw === null) return undefined
  if (!(allowed as readonly string[]).includes(raw)) throw new BadRequest(`Invalid ${name}: ${raw}`)
  return raw as T
}

function opt(q: Query, k: string): string | undefined {
  const v = q.get(k)
  return v === null || v === '' ? undefined : v
}

function usageScope(q: Query): { scope: UsageScopeKind; id: string | undefined } {
  const scope = oneOf('scope', q.get('scope'), USAGE_SCOPES)
  if (!scope) throw new BadRequest('Missing scope')
  const id = opt(q, 'id')
  if (scope !== 'fleet' && !id) throw new BadRequest('Missing id')
  return { scope, id }
}

export const ROUTES: readonly RouteDef[] = [
  { key: 'GET /api/meta', path: '/api/meta', query: [], handle: (s) => s.meta() },
  { key: 'GET /api/bootstrap', path: '/api/bootstrap', query: [], handle: (s) => s.bootstrap() },
  {
    key: 'GET /api/sessions',
    path: '/api/sessions',
    query: ['windowHours', 'harness', 'state', 'live', 'q', 'limit'],
    handle: (s, _p, q) => ({
      sessions: s.listSessions({
        windowMs: windowMs(q),
        harness: oneOf('harness', q.get('harness'), HARNESSES),
        state: oneOf('state', q.get('state'), STATES),
        liveOnly: q.get('live') === '1' ? true : undefined,
        q: opt(q, 'q'),
        limit: int('limit', q.get('limit'), 1, 2000),
      }),
    }),
  },
  { key: 'GET /api/sessions/:id', path: '/api/sessions/:id', query: [], handle: (s, p) => s.sessionDetail(p.id) },
  { key: 'GET /api/sessions/:id/tree', path: '/api/sessions/:id/tree', query: [], handle: (s, p) => s.sessionTree(p.id) },
  {
    key: 'GET /api/sessions/:id/transcript',
    path: '/api/sessions/:id/transcript',
    query: ['before', 'limit'],
    handle: (s, p, q) =>
      s.transcript(p.id, {
        before: opt(q, 'before'),
        limit: int('limit', q.get('limit'), 1, LIMITS.transcriptPageMax) ?? LIMITS.transcriptPageDefault,
      }),
  },
  {
    key: 'GET /api/activity',
    path: '/api/activity',
    query: ['sessionId', 'rootId', 'kinds', 'before', 'sinceMs', 'limit'],
    handle: (s, _p, q) => {
      if (q.has('sessionId') && q.has('rootId')) throw new BadRequest('Use either sessionId or rootId, not both')
      let kinds: ActivityKind[] | undefined
      const csv = opt(q, 'kinds')
      if (csv) {
        kinds = csv.split(',').map((k) => {
          if (!(ACTIVITY_KINDS as readonly string[]).includes(k)) throw new BadRequest(`Invalid kinds: ${k}`)
          return k as ActivityKind
        })
      }
      return s.activity({
        sessionId: opt(q, 'sessionId'),
        rootId: opt(q, 'rootId'),
        kinds,
        before: opt(q, 'before'),
        sinceMs: int('sinceMs', q.get('sinceMs'), 0, Number.MAX_SAFE_INTEGER),
        limit: int('limit', q.get('limit'), 1, LIMITS.activityPageMax) ?? 200,
      })
    },
  },
  { key: 'GET /api/parts/:id', path: '/api/parts/:id', query: [], handle: (s, p) => s.part(p.id) },
  {
    key: 'GET /api/file-changes',
    path: '/api/file-changes',
    query: ['rootId', 'sessionId', 'windowHours'],
    handle: (s, _p, q) => ({
      changes: s.fileChanges({ rootId: opt(q, 'rootId'), sessionId: opt(q, 'sessionId'), windowMs: windowMs(q) }),
    }),
  },
  { key: 'GET /api/file-changes/:id/diff', path: '/api/file-changes/:id/diff', query: [], handle: (s, p) => s.fileDiff(p.id) },
  {
    key: 'GET /api/artifacts',
    path: '/api/artifacts',
    query: ['rootId', 'windowHours'],
    handle: (s, _p, q) => ({ artifacts: s.artifacts({ rootId: opt(q, 'rootId'), windowMs: windowMs(q) }) }),
  },
  {
    key: 'GET /api/usage',
    path: '/api/usage',
    query: ['scope', 'id', 'windowHours', 'bucketMs', 'middle'],
    handle: (s, _p, q) => {
      const { scope, id } = usageScope(q)
      const query = {
        scope: { kind: scope, id: scope === 'fleet' ? null : id! },
        windowMs: windowMs(q),
        bucketMs: int('bucketMs', q.get('bucketMs'), 1000, 86_400_000),
        middle: oneOf('middle', q.get('middle'), ['agent', 'session', 'model'] as const),
      }
      if (!s.usage) throw new Unavailable('Usage is not available')
      return s.usage(query)
    },
  },
  {
    key: 'GET /api/usage/calls',
    path: '/api/usage/calls',
    query: ['scope', 'id', 'before', 'limit'],
    handle: (s, _p, q) => {
      const { scope, id } = usageScope(q)
      const query = {
        scope: { kind: scope, id: scope === 'fleet' ? null : id! },
        before: opt(q, 'before'),
        limit: int('limit', q.get('limit'), 1, LIMITS.usageCallsPageMax) ?? 200,
      }
      if (!s.usageCalls) throw new Unavailable('Usage is not available')
      return s.usageCalls(query)
    },
  },
  { key: 'GET /api/attention', path: '/api/attention', query: [], handle: (s) => ({ items: s.attention() }) },
  { key: 'GET /api/stats', path: '/api/stats', query: ['windowHours'], handle: (s, _p, q) => s.stats(windowMs(q)) },
  { key: 'GET /api/orca', path: '/api/orca', query: [], handle: (s) => s.orca() },
  { key: 'GET /api/orchestration', path: '/api/orchestration', query: [], handle: (s) => s.orchestration() },
  {
    key: 'GET /api/orchestration/runs/:id',
    path: '/api/orchestration/runs/:id',
    query: [],
    handle: (s, p) => s.orchestrationRun(p.id),
  },
  {
    key: 'GET /api/orchestration/tasks/:id',
    path: '/api/orchestration/tasks/:id',
    query: [],
    handle: (s, p) => s.orchestrationTask(p.id),
  },
]

function match(pattern: string, pathname: string): { id: string } | null {
  const a = pattern.split('/')
  const b = pathname.split('/')
  if (a.length !== b.length) return null
  let id = ''
  for (let i = 0; i < a.length; i++) {
    if (a[i] === ':id') {
      if (!b[i]) return null
      try {
        id = decodeURIComponent(b[i]!)
      } catch {
        throw new BadRequest('Malformed id')
      }
    } else if (a[i] !== b[i]) return null
  }
  return { id }
}

export interface ApiResult {
  status: number
  body: unknown
}

const err = (status: number, code: ApiError['code'], error: string): ApiResult => ({
  status,
  body: { error, code } satisfies ApiError,
})

export function handleApi(store: StoreReader, pathname: string, query: URLSearchParams, log?: Logger): ApiResult {
  try {
    for (const route of ROUTES) {
      const params = match(route.path, pathname)
      if (!params) continue
      for (const k of query.keys()) {
        if (!route.query.includes(k)) throw new BadRequest(`Unknown query parameter: ${k}`)
      }
      const body = route.handle(store, params, query)
      if (body === null || body === undefined) return err(404, 'not_found', 'Not found')
      return { status: 200, body }
    }
    return err(404, 'not_found', 'Unknown API route')
  } catch (e) {
    if (e instanceof Unavailable) return err(503, 'unavailable', e.message)
    if (e instanceof BadRequest) return err(400, 'bad_request', e.message)
    log?.error('route %s failed: %s', pathname, e instanceof Error ? (e.stack ?? e.message) : String(e))
    return err(500, 'internal', 'Internal server error')
  }
}
