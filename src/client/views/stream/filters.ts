import type { ActivityEvent, ActivityKind, Harness } from '../../../shared/contract'

/** Kinds shown by default (everything except `step`). An empty persisted `kinds` list means "defaults". */
export const DEFAULT_KINDS: readonly ActivityKind[] = [
  'prompt', 'thinking', 'text', 'tool', 'mcp', 'file-change', 'subagent', 'todo', 'state', 'permission', 'error', 'orchestration',
]

export const KIND_CHIPS: ReadonlyArray<{ kind: ActivityKind; label: string }> = [
  { kind: 'prompt', label: 'Prompts' }, { kind: 'thinking', label: 'Thinking' }, { kind: 'text', label: 'Text' },
  { kind: 'tool', label: 'Tools' }, { kind: 'mcp', label: 'MCP' }, { kind: 'file-change', label: 'Files' },
  { kind: 'subagent', label: 'Subagents' }, { kind: 'todo', label: 'Todos' }, { kind: 'state', label: 'State' },
  { kind: 'permission', label: 'Permission' }, { kind: 'error', label: 'Errors' }, { kind: 'orchestration', label: 'Orchestration' },
  { kind: 'step', label: 'Steps' },
]

export function effectiveKinds(kinds: readonly ActivityKind[]): Set<ActivityKind> {
  return new Set(kinds.length ? kinds : DEFAULT_KINDS)
}

export interface RowFilter {
  kinds: ReadonlySet<ActivityKind> | null
  harness: Harness | 'all'
  errorsOnly: boolean
  query: string
}

export function isErrorEvent(e: ActivityEvent): boolean {
  return e.status === 'error' || e.kind === 'error'
}

/** Case-insensitive match over title, summary, tool name, MCP server, files and session title. */
export function matchesQuery(e: ActivityEvent, query: string, sessionTitle?: string | null): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [e.title, e.summary, e.tool?.name, e.tool?.displayName, e.tool?.mcpServer, sessionTitle, ...e.files]
  return hay.some((h) => h != null && h.toLowerCase().includes(q))
}

/** All filters except kinds (used for live per-kind counts). */
export function matchesBase(e: ActivityEvent, f: RowFilter, sessionTitle?: string | null): boolean {
  if (f.harness !== 'all' && e.harness !== f.harness) return false
  if (f.errorsOnly && !isErrorEvent(e)) return false
  return matchesQuery(e, f.query, sessionTitle)
}

export function matchesFilter(e: ActivityEvent, f: RowFilter, sessionTitle?: string | null): boolean {
  if (f.kinds && !f.kinds.has(e.kind)) return false
  return matchesBase(e, f, sessionTitle)
}

/** Merge event lists: dedupe by id keeping the highest `rev`, sort by ts asc (id tiebreak). */
export function mergeEvents(...lists: ReadonlyArray<readonly ActivityEvent[]>): ActivityEvent[] {
  const byId = new Map<string, ActivityEvent>()
  for (const list of lists) {
    for (const e of list) {
      const cur = byId.get(e.id)
      if (!cur || e.rev >= cur.rev) byId.set(e.id, e)
    }
  }
  return [...byId.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
