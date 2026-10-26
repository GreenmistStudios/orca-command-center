import type { Harness, ToolCategory } from '../../shared/contract.js'

export interface ToolClassification {
  category: ToolCategory
  mcpServer: string | null
  displayName: string
}

export interface ToolClassifier {
  classify(harness: Harness, name: string): ToolClassification
  /** Record a tool name so shared prefixes (≥ 2 distinct names) can be recognized as MCP servers. */
  observe(name: string): void
}

const group = (category: ToolCategory, names: string[]): Array<[string, ToolCategory]> => names.map((n) => [n, category])

const OPENCODE_BUILTIN = new Map<string, ToolCategory>([
  ...group('shell', ['bash']),
  ...group('read', ['read', 'list', 'ls', 'lsp_hover', 'lsp_diagnostics']),
  ...group('search', ['grep', 'glob', 'codesearch']),
  ...group('edit', ['edit', 'multiedit']),
  ...group('write', ['write']),
  ...group('patch', ['patch', 'apply_patch']),
  ...group('web', ['webfetch', 'websearch']),
  ...group('subagent', ['task']),
  ...group('todo', ['todowrite', 'todoread']),
  ...group('question', ['question']),
  ...group('skill', ['skill']),
])

const COPILOT_BUILTIN = new Map<string, ToolCategory>([
  ...group('shell', ['bash', 'read_bash', 'stop_bash', 'write_bash']),
  ...group('read', ['view']),
  ...group('search', ['rg', 'glob', 'grep']),
  ...group('write', ['create']),
  ...group('edit', ['edit', 'str_replace', 'str_replace_editor']),
  ...group('patch', ['apply_patch']),
  ...group('web', ['web_fetch', 'web_search']),
  ...group('subagent', ['task']),
])

export const DEFAULT_MCP_SERVERS: readonly string[] = [
  'atlassian', 'github', 'bitrise', 'figma', 'playwright', 'slack', 'jira', 'confluence', 'linear',
  'sentry', 'notion', 'context7', 'sharepoint', 'satori', 'gitlab', 'datadog', 'grafana',
  'chrome-devtools', 'filesystem', 'memory', 'fetch',
]

export const VERB_STOPLIST: ReadonlySet<string> = new Set([
  'get', 'set', 'create', 'update', 'list', 'clear', 'delete', 'add', 'remove', 'read', 'write',
  'search', 'fetch', 'run', 'start', 'stop', 'open', 'close', 'find', 'check', 'make', 'send',
  'show', 'toggle', 'apply',
])

const UNDERSCORE_RE = /^([a-z0-9-]+)_(.+)$/
const HYPHEN_RE = /^([a-z0-9]+)-(.+)$/

export function createToolClassifier(options: { knownServers?: string[] } = {}): ToolClassifier {
  const known = new Set([...DEFAULT_MCP_SERVERS, ...(options.knownServers ?? [])].map((s) => s.toLowerCase()))
  const observed = new Set<string>()
  /** prefix → distinct names, split on the first "_" (opencode style) and first "-" (copilot style). */
  const byUnderscore = new Map<string, Set<string>>()
  const byHyphen = new Map<string, Set<string>>()

  const add = (map: Map<string, Set<string>>, prefix: string, name: string) => {
    let s = map.get(prefix)
    if (!s) map.set(prefix, (s = new Set()))
    s.add(name)
  }

  function candidates(harness: Harness, name: string): Array<{ prefix: string; rest: string; map: Map<string, Set<string>> }> {
    const out: Array<{ prefix: string; rest: string; map: Map<string, Set<string>> }> = []
    const u = UNDERSCORE_RE.exec(name)
    if (u) out.push({ prefix: u[1]!, rest: u[2]!, map: byUnderscore })
    if (harness === 'copilot') {
      const h = HYPHEN_RE.exec(name)
      if (h) out.push({ prefix: h[1]!, rest: h[2]!, map: byHyphen })
    }
    return out
  }

  function isMcpPrefix(prefix: string, name: string, map: Map<string, Set<string>>): boolean {
    if (known.has(prefix)) return true
    if (VERB_STOPLIST.has(prefix)) return false
    const names = map.get(prefix)
    const count = (names?.size ?? 0) + (names?.has(name) ? 0 : 1)
    return count >= 2
  }

  return {
    observe(name: string) {
      if (observed.has(name)) return
      observed.add(name)
      const u = UNDERSCORE_RE.exec(name)
      if (u) add(byUnderscore, u[1]!, name)
      const h = HYPHEN_RE.exec(name)
      if (h) add(byHyphen, h[1]!, name)
    },

    classify(harness: Harness, name: string): ToolClassification {
      const lower = name.toLowerCase()
      const builtin =
        harness === 'opencode'
          ? OPENCODE_BUILTIN.get(lower)
          : harness === 'copilot'
            ? COPILOT_BUILTIN.get(lower)
            : (OPENCODE_BUILTIN.get(lower) ?? COPILOT_BUILTIN.get(lower))
      if (builtin) return { category: builtin, mcpServer: null, displayName: name }

      // A known server with a hyphenated name (e.g. chrome-devtools) always wins in either style.
      for (const server of known) {
        if (lower.startsWith(`${server}_`) || (harness === 'copilot' && lower.startsWith(`${server}-`))) {
          const rest = name.slice(server.length + 1)
          if (rest) return { category: 'mcp', mcpServer: server, displayName: rest }
        }
      }
      for (const c of candidates(harness, lower)) {
        if (isMcpPrefix(c.prefix, lower, c.map)) {
          return { category: 'mcp', mcpServer: c.prefix, displayName: name.slice(c.prefix.length + 1) }
        }
      }
      return { category: 'plugin', mcpServer: null, displayName: name }
    },
  }
}
