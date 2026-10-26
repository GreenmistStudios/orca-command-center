import type { ApiError, ApiResponses, ApiRoute } from '../../shared/contract'
import { getMockBackend, isMockMode } from './mock'
import { ApiRequestError, type GetOptions } from './types'

export { ApiRequestError } from './types'
export type { GetOptions } from './types'

/** Build the request URL: substitute `:name` segments (URI-encoded) and append query params. */
export function buildUrl(route: string, opts: GetOptions = {}): string {
  const raw = route.replace(/^GET\s+/, '')
  const path = raw.replace(/:(\w+)/g, (_m, name: string) => {
    const v = opts.path?.[name]
    if (v == null) throw new Error(`Missing path param :${name} for ${route}`)
    return encodeURIComponent(v)
  })
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined) qs.set(k, String(v))
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

async function realGet<R extends ApiRoute>(route: R, opts: GetOptions = {}): Promise<ApiResponses[R]> {
  let res: Response
  try {
    res = await fetch(buildUrl(route, opts), { signal: opts.signal, headers: { accept: 'application/json' } })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiRequestError(0, 'network', e instanceof Error ? e.message : 'Network error')
  }
  if (!res.ok) {
    let body: Partial<ApiError> = {}
    try { body = (await res.json()) as Partial<ApiError> } catch { /* non-JSON error */ }
    throw new ApiRequestError(res.status, body.code ?? (res.status === 404 ? 'not_found' : res.status === 400 ? 'bad_request' : 'internal'), body.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as ApiResponses[R]
}

/** Typed API. In `?mock=1` mode requests are served by the in-browser mock backend. */
export const api = {
  get<R extends ApiRoute>(route: R, opts?: GetOptions): Promise<ApiResponses[R]> {
    return isMockMode() ? getMockBackend().get(route, opts) : realGet(route, opts)
  },
}
