import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, File, FileCode, FileText, GitPullRequest, Image as ImageIcon, Link as LinkIcon, FileBarChart } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Artifact, FileChange } from '../../../shared/contract'
import { useOcc } from '../../state/store'
import { AgentMonogram, CopyButton, DiffView, EmptyState, RelativeTime, Segmented } from '../../ui'
import { cn } from '../../lib/cn'
import { buildTree, flattenRows, groupArtifacts, groupByFile, type FileEntry, type SortKey } from './model'

type Scope = 'tree' | 'all'
type Tab = 'files' | 'artifacts'
const VIRTUALIZE_AT = 2000
const REFRESH_MS = 10_000

function fileIcon(name: string) {
  if (/\.(tsx?|jsx?|kt|py|go|rs|java|json|css|html|sh)$/.test(name)) return FileCode
  if (/\.(md|txt|mdx)$/.test(name)) return FileText
  return File
}

function Delta({ a, d }: { a: number; d: number }) {
  return (
    <span className="shrink-0 tabular-nums text-[10px]">
      <span className="text-status-completed-ink">+{a}</span> <span className="text-status-failed-ink">−{d}</span>
    </span>
  )
}

function Monograms({ ids }: { ids: string[] }) {
  const sessions = useOcc((s) => s.sessions)
  return (
    <span className="flex shrink-0 items-center -space-x-1">
      {ids.slice(0, 3).map((id) => <AgentMonogram key={id} agent={sessions[id]?.agent ?? null} size={17} />)}
      {ids.length > 3 && <span className="text-muted-foreground pl-1.5 text-[10px]">+{ids.length - 3}</span>}
    </span>
  )
}

export function ChangesView() {
  const selectedRootId = useOcc((s) => s.ui.selectedRootId)
  const sessions = useOcc((s) => s.sessions)
  const fetchFileChanges = useOcc((s) => s.fetchFileChanges)
  const fetchArtifacts = useOcc((s) => s.fetchArtifacts)
  const [scope, setScope] = useState<Scope>(selectedRootId ? 'tree' : 'all')
  const [tab, setTab] = useState<Tab>('files')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const effScope: Scope = scope === 'tree' && selectedRootId ? 'tree' : 'all'
  const key = effScope === 'tree' ? `root:${selectedRootId}` : 'all'
  const rootId = effScope === 'tree' ? selectedRootId ?? undefined : undefined

  const changesL = useOcc((s) => s.fileChanges[key])
  const artifactsL = useOcc((s) => s.artifacts[key])
  const changes = changesL?.data ?? null
  const artifacts = artifactsL?.data ?? null

  const hasLive = useMemo(
    () => Object.values(sessions).some((s) => s.live && (!rootId || s.rootId === rootId)),
    [sessions, rootId],
  )

  useEffect(() => {
    void fetchFileChanges({ rootId })
    void fetchArtifacts({ rootId })
    if (!hasLive) return
    const t = setInterval(() => {
      void fetchFileChanges({ rootId }, { force: true })
      void fetchArtifacts({ rootId }, { force: true })
    }, REFRESH_MS)
    return () => clearInterval(t)
  }, [rootId, hasLive, fetchFileChanges, fetchArtifacts])

  const files = useMemo(() => groupByFile(changes ?? []), [changes])

  const showInChanges = (path: string) => { setSelectedPath(path); setTab('files') }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-view">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Segmented<Scope>
          aria-label="Scope"
          layoutId="changes-scope"
          value={effScope}
          onChange={setScope}
          options={[
            { value: 'tree', label: 'This tree', title: selectedRootId ? undefined : 'Select a session tree first' },
            { value: 'all', label: 'All agents' },
          ]}
        />
        <Segmented<Tab>
          aria-label="Tab"
          layoutId="changes-tab"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'files', label: 'Files', count: files.length },
            { value: 'artifacts', label: 'Artifacts', count: artifacts?.length ?? 0 },
          ]}
        />
        {!selectedRootId && <span className="text-muted-foreground text-[11px]">Select a tree to scope</span>}
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'files' ? (
          <FilesTab files={files} loaded={changesL?.status === 'ready' || changes !== null} selectedPath={selectedPath} onSelect={setSelectedPath} count={changes?.length ?? 0} />
        ) : (
          <ArtifactsTab artifacts={artifacts ?? []} onShow={showInChanges} />
        )}
      </div>
    </div>
  )
}

function FilesTab({ files, loaded, selectedPath, onSelect, count }: { files: FileEntry[]; loaded: boolean; selectedPath: string | null; onSelect: (p: string) => void; count: number }) {
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortKey>('recent')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
  }, [files, filter])
  const rows = useMemo(() => flattenRows(buildTree(shown, sort), collapsed), [shown, sort, collapsed])
  const selected = files.find((f) => f.path === selectedPath) ?? null

  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n })

  if (loaded && files.length === 0) return <EmptyState title="No file changes in this scope yet." />

  const virtual = count >= VIRTUALIZE_AT
  const renderRow = (r: (typeof rows)[number]): ReactNode => {
    if (r.type === 'root') {
      const id = `root:${r.key}`
      return (
        <button type="button" onClick={() => toggle(id)} className="text-muted-foreground flex w-full items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide">
          {collapsed.has(id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="truncate">{r.name}</span><span className="tabular-nums">{r.count}</span>
        </button>
      )
    }
    if (r.type === 'dir') {
      return (
        <button type="button" onClick={() => toggle(r.id)} style={{ paddingLeft: 8 + r.depth * 12 }} className="hover:bg-accent flex w-full items-center gap-1 py-1 pr-2 text-[11px]">
          {r.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="truncate">{r.name}</span><span className="text-muted-foreground tabular-nums">{r.count}</span>
        </button>
      )
    }
    const f = r.file
    const Icon = fileIcon(f.name)
    return (
      <button
        type="button"
        data-testid="file-row"
        aria-pressed={f.path === selectedPath}
        onClick={() => onSelect(f.path)}
        style={{ paddingLeft: 8 + r.depth * 12 }}
        className={cn('hover:bg-accent flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[11px]', f.path === selectedPath && 'bg-accent')}
      >
        <Icon size={13} className="text-muted-foreground shrink-0" />
        <span className={cn('min-w-0 flex-1 truncate', f.deleted && 'line-through')}>{f.name}</span>
        {f.created && <span className="text-status-completed-ink text-[10px]">new</span>}
        {f.deleted && <span className="text-status-failed-ink text-[10px]">deleted</span>}
        <span className="text-muted-foreground tabular-nums text-[10px]">{f.changes.length}×</span>
        <Delta a={f.additions} d={f.deletions} />
        <Monograms ids={f.agents} />
        <RelativeTime ts={f.lastTs} className="text-muted-foreground w-14 shrink-0 text-right text-[10px]" />
      </button>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="border-border flex w-[40%] min-w-0 flex-col border-r">
        <div className="border-border flex items-center gap-1.5 border-b p-2">
          <input
            aria-label="Filter files"
            placeholder="Filter by path…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="border-input bg-background focus-ring h-7 min-w-0 flex-1 rounded-md border px-2 text-[11px]"
          />
          <select aria-label="Sort files" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="border-input bg-background h-7 rounded-md border text-[11px]">
            <option value="recent">Recent</option>
            <option value="changed">Most changed</option>
            <option value="path">Path</option>
          </select>
        </div>
        {virtual ? <VirtualList rows={rows} render={renderRow} /> : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((r) => <div key={r.type === 'root' ? `root:${r.key}` : r.id}>{renderRow(r)}</div>)}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected ? <History file={selected} /> : <EmptyState title="Select a file" hint="Pick a file to see its change history." />}
      </div>
    </div>
  )
}

function VirtualList<R>({ rows, render }: { rows: R[]; render: (r: R) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => ref.current, estimateSize: () => 26, overscan: 12 })
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto" data-testid="virtual-list">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((it) => (
          <div key={it.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${it.start}px)`, height: it.size }}>
            {render(rows[it.index])}
          </div>
        ))}
      </div>
    </div>
  )
}

function History({ file }: { file: FileEntry }) {
  return (
    <div className="p-3" data-testid="file-history">
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={file.path}>{file.path}</span>
        <CopyButton text={file.path} label="Copy path" />
      </div>
      <ol className="flex flex-col gap-2">
        {file.changes.map((c, i) => <ChangeItem key={c.id} change={c} defaultOpen={i === 0} />)}
      </ol>
    </div>
  )
}

function ChangeItem({ change: c, defaultOpen }: { change: FileChange; defaultOpen: boolean }) {
  const session = useOcc((s) => s.sessions[c.sessionId])
  const selectSession = useOcc((s) => s.selectSession)
  const fetchDiff = useOcc((s) => s.fetchDiff)
  const diffL = useOcc((s) => s.diffs[c.id])
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => { if (open) void fetchDiff(c.id) }, [open, c.id, fetchDiff])
  const diff = diffL?.data
  return (
    <li className="border-border rounded-md border" data-testid="change-item">
      <div className="flex items-center gap-1.5 p-2 text-[11px]">
        <button type="button" aria-expanded={open} aria-label={open ? 'Collapse diff' : 'Expand diff'} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <AgentMonogram agent={session?.agent ?? null} size={17} />
        <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => selectSession(c.sessionId, { activityId: c.id })}>
          {session?.title ?? c.sessionId}
        </button>
        {c.tool && <span className="text-muted-foreground font-mono text-[10px]">{c.tool}</span>}
        <span className="bg-muted rounded px-1 text-[10px]">{c.kind}</span>
        <span className="text-muted-foreground text-[10px]">{c.status}</span>
        <RelativeTime ts={c.ts} className="text-muted-foreground text-[10px]" />
        <Delta a={c.additions ?? 0} d={c.deletions ?? 0} />
      </div>
      {open && (
        <div className="border-border border-t">
          {c.kind === 'patch' && (!diff || diff.format === 'none') ? (
            <div className="text-muted-foreground p-2 text-[11px]">changed during a step (e.g. via shell) — diff not recorded</div>
          ) : diff ? (
            <DiffView diff={diff} />
          ) : diffL?.status === 'error' ? (
            <div className="text-status-failed-ink p-2 text-[11px]">{diffL.error}</div>
          ) : (
            <div className="text-muted-foreground p-2 text-[11px]">Loading diff…</div>
          )}
        </div>
      )}
    </li>
  )
}

const ART_ICON = { 'pull-request': GitPullRequest, document: FileText, 'new-file': File, url: LinkIcon, image: ImageIcon, report: FileBarChart } as const

function ArtifactsTab({ artifacts, onShow }: { artifacts: Artifact[]; onShow: (path: string) => void }) {
  const sessions = useOcc((s) => s.sessions)
  const selectSession = useOcc((s) => s.selectSession)
  const groups = useMemo(() => groupArtifacts(artifacts), [artifacts])
  if (groups.length === 0) return <EmptyState title="No artifacts yet." />
  return (
    <div className="h-full space-y-4 overflow-y-auto p-3">
      {groups.map((g) => (
        <section key={g.kind} aria-label={g.title}>
          <h3 className="text-muted-foreground mb-1.5 text-[11px] font-semibold uppercase tracking-wide">{g.title} <span className="tabular-nums">{g.items.length}</span></h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
            {g.items.map((a) => {
              const Icon = ART_ICON[a.kind]
              const s = sessions[a.sessionId]
              return (
                <div key={a.id} data-testid="artifact-card" className="border-border flex flex-col gap-1 rounded-md border p-2 text-[11px]">
                  <div className="flex items-center gap-1.5"><Icon size={13} className="shrink-0" /><span className="truncate font-medium">{a.label}</span></div>
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noreferrer" className="text-primary truncate hover:underline">{a.url}</a>
                  ) : a.path ? <span className="text-muted-foreground truncate font-mono text-[10px]" title={a.path}>{a.path}</span> : null}
                  <div className="text-muted-foreground flex items-center gap-1.5">
                    <AgentMonogram agent={s?.agent ?? null} size={17} />
                    <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => selectSession(a.sessionId)}>{s?.title ?? a.sessionId}</button>
                    <RelativeTime ts={a.ts} className="text-[10px]" />
                  </div>
                  {a.path && (a.kind === 'document' || a.kind === 'new-file') && (
                    <button type="button" className="text-primary self-start hover:underline" onClick={() => onShow(a.path!)}>Show in Changes</button>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
