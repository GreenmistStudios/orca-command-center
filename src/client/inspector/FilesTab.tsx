import { ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { FileChange } from '../../shared/contract'
import { shortPath } from '../lib/format'
import { selectDescendants } from '../state/selectors'
import { useOcc } from '../state/store'
import { DiffView, EmptyState, Spinner, StatusPill, activityStatusTone } from '../ui'
import { ErrorBox } from './common'

function Delta({ c }: { c: Pick<FileChange, 'additions' | 'deletions'> }) {
  if (c.additions == null && c.deletions == null) return null
  return (
    <span className="font-mono text-[10px] tabular-nums">
      <span className="text-status-completed-ink">+{c.additions ?? 0}</span>{' '}
      <span className="text-status-failed-ink">−{c.deletions ?? 0}</span>
    </span>
  )
}

export function ChangeDiff({ id }: { id: string }) {
  const entry = useOcc((s) => s.diffs[id])
  const fetchDiff = useOcc((s) => s.fetchDiff)
  useEffect(() => { void fetchDiff(id) }, [id, fetchDiff])
  if (entry?.data) return <DiffView diff={entry.data} />
  if (entry?.status === 'error') return <ErrorBox message={entry.error ?? 'Failed to load diff'} />
  return <div className="p-2"><Spinner /></div>
}

function ChangeRow({ c }: { c: FileChange }) {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="focus-ring hover:bg-accent flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px]">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="text-muted-foreground">{c.kind}</span>
        <Delta c={c} />
        <StatusPill tone={activityStatusTone(c.status)} className="ml-auto">{c.status}</StatusPill>
      </button>
      {open && <div className="py-1 pl-4"><ChangeDiff id={c.id} /></div>}
    </li>
  )
}

export function FilesTab({ sessionId }: { sessionId: string }) {
  const detail = useOcc((s) => s.details[sessionId]?.data)
  const session = useOcc((s) => s.sessions[sessionId])
  const descendants = useOcc((s) => selectDescendants(s, sessionId))
  const [withSubs, setWithSubs] = useState(false)
  const rootId = session?.rootId ?? detail?.session.rootId
  const rootChanges = useOcc((s) => (rootId ? s.fileChanges[`root:${rootId}`] : undefined))
  const fetchFileChanges = useOcc((s) => s.fetchFileChanges)
  useEffect(() => { if (withSubs && rootId) void fetchFileChanges({ rootId }) }, [withSubs, rootId, fetchFileChanges])

  const changes = useMemo(() => {
    if (!withSubs) return detail?.fileChanges ?? []
    const ids = new Set([sessionId, ...descendants.map((d) => d.id)])
    return (rootChanges?.data ?? []).filter((c) => ids.has(c.sessionId))
  }, [withSubs, detail, rootChanges, descendants, sessionId])

  const groups = useMemo(() => {
    const m = new Map<string, FileChange[]>()
    for (const c of changes) { const a = m.get(c.path); if (a) a.push(c); else m.set(c.path, [c]) }
    return [...m.entries()]
  }, [changes])

  return (
    <div className="flex flex-col gap-2 p-3">
      <label className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        <input type="checkbox" checked={withSubs} onChange={(e) => setWithSubs(e.target.checked)} /> Include subagents
      </label>
      {withSubs && rootChanges?.status === 'loading' && !rootChanges.data && <Spinner />}
      {withSubs && rootChanges?.status === 'error' && <ErrorBox message={rootChanges.error ?? 'Failed to load changes'} onRetry={() => rootId && void fetchFileChanges({ rootId }, { force: true })} />}
      {groups.length === 0 ? <EmptyState icon={<FileText size={20} />} title="No file changes" className="p-4" /> : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="file-groups">
          {groups.map(([path, list]) => (
            <li key={path} className="border-panel-border/60 rounded-lg border p-1.5">
              <div className="flex items-center gap-1.5 px-1 text-[11px]">
                <FileText size={12} className="text-muted-foreground shrink-0" />
                <span className="min-w-0 truncate font-mono" title={path}>{shortPath(path, list[0].workspaceRoot)}</span>
                <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">×{list.length}</span>
              </div>
              <ul className="m-0 mt-1 list-none p-0">{list.map((c) => <ChangeRow key={c.id} c={c} />)}</ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
