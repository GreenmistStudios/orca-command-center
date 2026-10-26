/** Tiny top-level `key: value` scalar parser for Copilot's workspace.yaml (no YAML library). */

export interface CopilotWorkspace {
  id: string | null
  name: string | null
  cwd: string | null
  createdAt: string | null
  updatedAt: string | null
  clientName: string | null
  summaryCount: number | null
  userNamed: boolean
}

const WANTED = new Set(['id', 'name', 'cwd', 'created_at', 'updated_at', 'client_name', 'summary_count', 'user_named'])

function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  // strip trailing comment on unquoted scalars
  return v.replace(/\s+#.*$/, '')
}

export function parseWorkspaceYaml(text: string): CopilotWorkspace {
  const kv = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^\s/.test(line) || line.startsWith('#') || line.startsWith('-')) continue
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line)
    if (!m || !WANTED.has(m[1]!)) continue
    const value = unquote(m[2] ?? '')
    if (value === '' || value === '|' || value === '>' || value === 'null' || value === '~') continue
    kv.set(m[1]!, value)
  }
  const num = kv.get('summary_count')
  return {
    id: kv.get('id') ?? null,
    name: kv.get('name') ?? null,
    cwd: kv.get('cwd') ?? null,
    createdAt: kv.get('created_at') ?? null,
    updatedAt: kv.get('updated_at') ?? null,
    clientName: kv.get('client_name') ?? null,
    summaryCount: num !== undefined && /^\d+$/.test(num) ? Number(num) : null,
    userNamed: kv.get('user_named') === 'true',
  }
}
