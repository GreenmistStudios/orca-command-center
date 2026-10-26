import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

export class DeniedTableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeniedTableError'
  }
}

/** OpenCode tables that may hold credentials/permissions. Never queried, in any form. */
export const OPENCODE_DENIED_TABLES: readonly string[] = [
  'account',
  'account_state',
  'control_account',
  'credential',
  'permission',
]

export interface ReadOnlyDb {
  readonly path: string
  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[]
  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined
  dataVersion(): number
  userVersion(): number
  tables(): Set<string>
  columns(table: string): Set<string>
  explain(sql: string, ...params: SQLInputValue[]): string[]
  close(): void
}

const ALLOWED_PRAGMAS = new Set(['data_version', 'user_version', 'table_info', 'busy_timeout', 'query_only'])

/** Remove string literals and comments so the guard only sees identifiers/keywords. */
function stripLiteralsAndComments(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function openReadOnly(
  path: string,
  options: { deniedTables?: readonly string[]; busyTimeoutMs?: number } = {},
): ReadOnlyDb {
  const denied = (options.deniedTables ?? OPENCODE_DENIED_TABLES).map((t) => t.toLowerCase())
  const deniedRe =
    denied.length > 0
      ? new RegExp(`(?<![A-Za-z0-9_$])(?:${denied.map(escapeRegExp).join('|')})(?![A-Za-z0-9_$])`, 'i')
      : null

  const db = new DatabaseSync(path, { readOnly: true })
  const timeout = Math.max(0, Math.floor(options.busyTimeoutMs ?? 3000))
  db.exec(`PRAGMA busy_timeout = ${timeout}`)

  const cache = new Map<string, StatementSync>()

  function guard(sql: string): void {
    const clean = stripLiteralsAndComments(sql)
    const m = deniedRe?.exec(clean)
    if (m) throw new DeniedTableError(`Access to table "${m[0].toLowerCase()}" is denied`)
    const trimmed = clean.trim().replace(/;\s*$/, '')
    if (trimmed.includes(';')) throw new Error('Multiple statements are not allowed')
    const first = /^[A-Za-z]+/.exec(trimmed)?.[0].toUpperCase()
    if (first !== 'SELECT' && first !== 'WITH' && first !== 'PRAGMA') {
      throw new Error(`Only SELECT/WITH/PRAGMA statements are allowed (got ${first ?? 'empty'})`)
    }
    if (first === 'PRAGMA') {
      const name = /^PRAGMA\s+(?:\w+\.)?(\w+)/i.exec(trimmed)?.[1]?.toLowerCase()
      if (!name || !ALLOWED_PRAGMAS.has(name)) throw new Error(`PRAGMA ${name ?? ''} is not allowed`)
    }
  }

  function prepare(sql: string): StatementSync {
    let stmt = cache.get(sql)
    if (!stmt) {
      guard(sql)
      stmt = db.prepare(sql)
      cache.set(sql, stmt)
    }
    return stmt
  }

  const self: ReadOnlyDb = {
    path,
    all<T>(sql: string, ...params: SQLInputValue[]): T[] {
      return prepare(sql).all(...params) as T[]
    },
    get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
      return prepare(sql).get(...params) as T | undefined
    },
    dataVersion() {
      const row = self.get<{ data_version: number }>('PRAGMA data_version')
      return Number(row?.data_version ?? 0)
    },
    userVersion() {
      const row = self.get<{ user_version: number }>('PRAGMA user_version')
      return Number(row?.user_version ?? 0)
    },
    tables() {
      return new Set(
        self.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name),
      )
    },
    columns(table: string) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return new Set()
      return new Set(self.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name))
    },
    explain(sql: string, ...params: SQLInputValue[]) {
      guard(sql)
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>
      return rows.map((r) => String(r.detail))
    },
    close() {
      cache.clear()
      db.close()
    },
  }
  return self
}
