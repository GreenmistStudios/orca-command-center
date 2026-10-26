import type { ApiError } from '../../shared/contract'

/** Thrown by `api.get` on a non-2xx response. */
export class ApiRequestError extends Error {
  readonly status: number
  readonly code: ApiError['code'] | 'network'
  constructor(status: number, code: ApiRequestError['code'], message: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

export interface GetOptions {
  /** Query-string parameters; `undefined` values are dropped. */
  params?: Record<string, string | number | boolean | undefined>
  /** Values for `:id`-style path segments (URI-encoded by the client). */
  path?: Record<string, string>
  signal?: AbortSignal
}

/** True when the URL asks for the in-browser mock backend (`?mock=1`). Kept here so the mock can be code-split. */
export function isMockMode(search: string = typeof location !== 'undefined' ? location.search : ''): boolean {
  return /[?&]mock=/.test(search) && !/[?&]mock=0\b/.test(search)
}
