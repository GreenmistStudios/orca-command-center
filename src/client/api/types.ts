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
