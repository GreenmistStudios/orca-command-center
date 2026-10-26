import type { Artifact, ArtifactKind, FileChange } from '../../../shared/contract'

export interface FileEntry {
  path: string
  name: string
  workspaceRoot: string | null
  changes: FileChange[] // newest first
  additions: number
  deletions: number
  lastTs: number
  agents: string[] // session ids, most recent first
  created: boolean
  deleted: boolean
}

export type SortKey = 'recent' | 'changed' | 'path'

export type TreeNode =
  | { type: 'dir'; id: string; name: string; children: TreeNode[]; count: number }
  | { type: 'file'; id: string; name: string; file: FileEntry }

export interface RootGroup { key: string; name: string; nodes: TreeNode[]; fileCount: number }

export type Row =
  | { type: 'root'; key: string; name: string; count: number }
  | { type: 'dir'; id: string; name: string; depth: number; count: number; open: boolean }
  | { type: 'file'; id: string; depth: number; file: FileEntry }

const lastSeg = (p: string) => p.split('/').filter(Boolean).pop() ?? p

/** Aggregate raw changes into one entry per path (changes newest first). */
export function groupByFile(changes: FileChange[]): FileEntry[] {
  const map = new Map<string, FileChange[]>()
  for (const c of changes) {
    const l = map.get(c.path)
    if (l) l.push(c)
    else map.set(c.path, [c])
  }
  return [...map.entries()].map(([path, list]) => {
    list.sort((a, b) => b.ts - a.ts)
    const agents: string[] = []
    for (const c of list) if (!agents.includes(c.sessionId)) agents.push(c.sessionId)
    const oldest = list[list.length - 1]
    return {
      path,
      name: lastSeg(list[0].relPath ?? path),
      workspaceRoot: list[0].workspaceRoot,
      changes: list,
      additions: list.reduce((n, c) => n + (c.additions ?? 0), 0),
      deletions: list.reduce((n, c) => n + (c.deletions ?? 0), 0),
      lastTs: list[0].ts,
      agents,
      created: oldest.kind === 'create',
      deleted: list[0].kind === 'delete',
    }
  })
}

export function sortFiles(files: FileEntry[], sort: SortKey): FileEntry[] {
  const f = [...files]
  if (sort === 'recent') f.sort((a, b) => b.lastTs - a.lastTs || a.path.localeCompare(b.path))
  else if (sort === 'changed') f.sort((a, b) => b.changes.length - a.changes.length || b.lastTs - a.lastTs)
  else f.sort((a, b) => a.path.localeCompare(b.path))
  return f
}

interface Trie { name: string; dirs: Map<string, Trie>; files: FileEntry[] }

function compact(t: Trie, id: string, sort: SortKey, order: Map<string, number>): TreeNode[] {
  const dirs: TreeNode[] = []
  for (const d of t.dirs.values()) {
    let cur = d
    let name = d.name
    let did = `${id}/${d.name}`
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      cur = [...cur.dirs.values()][0]
      name += `/${cur.name}`
      did += `/${cur.name}`
    }
    const children = compact(cur, did, sort, order)
    dirs.push({ type: 'dir', id: did, name, children, count: countFiles(children) })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  const files: TreeNode[] = t.files
    .sort((a, b) => (order.get(a.path)! - order.get(b.path)!))
    .map((file) => ({ type: 'file' as const, id: file.path, name: file.name, file }))
  return [...dirs, ...files]
}

const countFiles = (nodes: TreeNode[]): number => nodes.reduce((n, x) => n + (x.type === 'file' ? 1 : x.count), 0)

/** Group by workspace root → compacted directories → files. */
export function buildTree(files: FileEntry[], sort: SortKey = 'path'): RootGroup[] {
  const sorted = sortFiles(files, sort)
  const order = new Map(sorted.map((f, i) => [f.path, i]))
  const roots = new Map<string, { name: string; trie: Trie }>()
  for (const f of sorted) {
    const key = f.workspaceRoot ?? ''
    let r = roots.get(key)
    if (!r) roots.set(key, (r = { name: key ? lastSeg(key) : 'Other files', trie: { name: '', dirs: new Map(), files: [] } }))
    const rel = f.workspaceRoot && f.path.startsWith(f.workspaceRoot) ? f.path.slice(f.workspaceRoot.length) : f.changes[0].relPath ?? f.path
    const segs = rel.split('/').filter(Boolean)
    let t = r.trie
    for (const s of segs.slice(0, -1)) {
      let n = t.dirs.get(s)
      if (!n) t.dirs.set(s, (n = { name: s, dirs: new Map(), files: [] }))
      t = n
    }
    t.files.push(f)
  }
  return [...roots.entries()]
    .map(([key, r]) => {
      const nodes = compact(r.trie, key, sort, order)
      return { key, name: r.name, nodes, fileCount: countFiles(nodes) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function flattenRows(groups: RootGroup[], collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = []
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      if (n.type === 'file') rows.push({ type: 'file', id: n.id, depth, file: n.file })
      else {
        const open = !collapsed.has(n.id)
        rows.push({ type: 'dir', id: n.id, name: n.name, depth, count: n.count, open })
        if (open) walk(n.children, depth + 1)
      }
    }
  }
  for (const g of groups) {
    rows.push({ type: 'root', key: g.key, name: g.name, count: g.fileCount })
    if (!collapsed.has(`root:${g.key}`)) walk(g.nodes, 0)
  }
  return rows
}

export const ARTIFACT_ORDER: { kind: ArtifactKind; title: string }[] = [
  { kind: 'pull-request', title: 'Pull requests' },
  { kind: 'document', title: 'Documents' },
  { kind: 'new-file', title: 'New files' },
  { kind: 'url', title: 'Links' },
  { kind: 'image', title: 'Images' },
  { kind: 'report', title: 'Reports' },
]

export function groupArtifacts(list: Artifact[]): { kind: ArtifactKind; title: string; items: Artifact[] }[] {
  return ARTIFACT_ORDER.map((g) => ({ ...g, items: list.filter((a) => a.kind === g.kind).sort((a, b) => b.ts - a.ts) })).filter((g) => g.items.length)
}
