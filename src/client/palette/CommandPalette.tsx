import { Command } from 'cmdk'
import { Dialog } from 'radix-ui'
import { Activity, BellRing, Clipboard, FileDiff, FolderGit2, GitBranch, Keyboard, LayoutDashboard, LayoutGrid, Moon, Network, Radio, Search, SquareChartGantt, Waypoints, X, type LucideIcon } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { formatRelative } from '../lib/format'
import { selectWorkspaceGroups } from '../state/selectors'
import { useOcc, type ViewId } from '../state/store'
import { HarnessTile } from '../ui/Monogram'
import { StateDot } from '../ui/LiveDot'
import { Kbd } from '../ui/Pills'
import { ShortcutsDialog } from './ShortcutsDialog'
import { OversightDialog } from '../views/oversight/OversightDialog'

const VIEW_ITEMS: Array<{ id: ViewId; label: string; icon: LucideIcon; key: string }> = [
  { id: 'fleet', label: 'Fleet', icon: Network, key: '1' },
  { id: 'dag', label: 'DAG', icon: GitBranch, key: '2' },
  { id: 'timeline', label: 'Timeline', icon: SquareChartGantt, key: '3' },
  { id: 'stream', label: 'Stream', icon: Activity, key: '4' },
  { id: 'changes', label: 'Changes', icon: FileDiff, key: '5' },
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, key: '6' },
]

const itemCls = 'data-[selected=true]:bg-selection/15 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs outline-none'
const groupCls = '[&_[cmdk-group-heading]]:section-label [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5'

function Row({ value, keywords, icon, label, hint, onSelect, testId }: {
  value: string; keywords?: string[]; icon: ReactNode; label: ReactNode; hint?: ReactNode; onSelect: () => void; testId?: string
}) {
  return (
    <Command.Item value={keywords ? `${value} ${keywords.join(' ')}` : value} onSelect={onSelect} className={itemCls} data-testid={testId}>
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint != null && <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">{hint}</span>}
    </Command.Item>
  )
}

/** ⌘K command palette (Plan F11) plus the shortcuts and oversight overlays. */
export function CommandPalette() {
  return (
    <>
      <PaletteDialog />
      <ShortcutsDialog />
      <OversightDialog />
    </>
  )
}

function PaletteDialog() {
  const open = useOcc((s) => s.ui.paletteOpen)
  const setOpen = useOcc((s) => s.setPaletteOpen)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="command-palette"
          className="panel bg-panel-solid fixed top-[14vh] left-1/2 z-50 w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden outline-none"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <PaletteBody />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function PaletteBody() {
  const sessions = useOcc((s) => s.sessions)
  const attention = useOcc((s) => s.attention)
  const orchestration = useOcc((s) => s.orchestration)
  const state = useOcc.getState
  const [now] = useState(() => Date.now()) // snapshot at open; the palette is short-lived
  const groups = useMemo(() => selectWorkspaceGroups(useOcc.getState()), [sessions]) // eslint-disable-line react-hooks/exhaustive-deps

  const all = useMemo(
    () => Object.values(sessions).sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt)),
    [sessions],
  )
  const close = () => state().setPaletteOpen(false)
  const run = (fn: () => void) => () => { close(); fn() }
  const sessionKw = (s: (typeof all)[number]) => [s.title, s.agent ?? '', s.workspace?.name ?? '', s.directory ?? '', s.id.slice(0, 8), s.id]
  const sessionRow = (prefix: string, s: (typeof all)[number]) => (
    <Row
      key={`${prefix}:${s.id}`}
      testId={`palette-session-${s.id}`}
      value={`${prefix}:${s.id}`}
      keywords={sessionKw(s)}
      icon={<StateDot state={s.state} />}
      label={<span className="flex items-center gap-2"><HarnessTile harness={s.harness} />{s.title || s.id}{s.agent && <span className="text-muted-foreground">· {s.agent}</span>}</span>}
      hint={<>{s.workspace?.name}<span className="opacity-60">{formatRelative(s.lastActivityAt ?? s.updatedAt, now)}</span></>}
      onSelect={run(() => state().selectSession(s.id))}
    />
  )
  const runs = orchestration?.runs ?? []
  const toggleTheme = () => state().toggleTheme()

  return (
    <Command label="Command palette" loop className="flex max-h-[min(32rem,70dvh)] flex-col">
      <div className="border-panel-border flex items-center gap-2 border-b px-3">
        <Search size={14} className="text-muted-foreground shrink-0" />
        <Command.Input autoFocus placeholder="Search sessions, runs, views, actions…" className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        <Kbd>esc</Kbd>
      </div>
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <Command.Empty className="text-muted-foreground px-3 py-6 text-center text-xs">No matches</Command.Empty>

        {attention.length > 0 && (
          <Command.Group heading="Needs you" className={groupCls}>
            {attention.map((a) => (
              <Row
                key={a.id}
                testId={`palette-attention-${a.id}`}
                value={`attention:${a.id}`}
                keywords={[a.title, a.detail ?? '', a.kind, a.source]}
                icon={<BellRing size={13} className={a.severity === 'high' ? 'text-status-gate-ink' : 'text-muted-foreground'} />}
                label={a.title}
                hint={<>{a.kind}<span className="opacity-60">{formatRelative(a.since, now)}</span></>}
                onSelect={run(() => {
                  if (a.sessionId) state().selectSession(a.sessionId)
                  else if (a.runId) { state().selectRun(a.runId); state().setView('dag') }
                })}
              />
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Live sessions" className={groupCls}>
          {all.filter((s) => s.live).map((s) => sessionRow('live', s))}
        </Command.Group>
        <Command.Group heading="Sessions" className={groupCls}>
          {all.slice(0, 300).map((s) => sessionRow('session', s))}
        </Command.Group>

        <Command.Group heading="Workspaces" className={groupCls}>
          {groups.map((g) => (
            <Row
              key={g.workspace.key}
              value={`workspace:${g.workspace.key}`}
              keywords={[g.workspace.name, g.workspace.path ?? '', g.workspace.repo ?? '', g.workspace.branch ?? '']}
              icon={<FolderGit2 size={13} className="text-muted-foreground" />}
              label={g.workspace.name}
              hint={g.liveCount > 0 ? `${g.liveCount} live` : g.workspace.branch ?? undefined}
              onSelect={run(() => state().setRailQuery(g.workspace.name))}
            />
          ))}
        </Command.Group>

        {runs.length > 0 && (
          <Command.Group heading="Orchestration runs" className={groupCls}>
            {runs.map((r) => (
              <Row
                key={r.id}
                testId={`palette-run-${r.id}`}
                value={`run:${r.id}`}
                keywords={[r.objective, r.coordinatorHandle ?? '', r.id]}
                icon={<Waypoints size={13} className="text-muted-foreground" />}
                label={r.objective || r.id}
                hint={<>{r.taskCount} tasks{r.lastActivityAt != null && <span className="opacity-60">{formatRelative(r.lastActivityAt, now)}</span>}</>}
                onSelect={run(() => { state().selectRun(r.id); state().setView('dag') })}
              />
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Views" className={groupCls}>
          {VIEW_ITEMS.map((v) => (
            <Row
              key={v.id}
              testId={`palette-view-${v.id}`}
              value={`view:${v.id}`}
              keywords={[v.label, 'view', 'go to']}
              icon={<v.icon size={13} className="text-muted-foreground" />}
              label={v.label}
              hint={<Kbd>{v.key}</Kbd>}
              onSelect={run(() => state().setView(v.id))}
            />
          ))}
        </Command.Group>

        <Command.Group heading="Actions" className={groupCls}>
          <Row testId="palette-action-theme" value="action:theme" keywords={['dark', 'light', 'toggle theme']} icon={<Moon size={13} className="text-muted-foreground" />} label="Toggle theme" hint={<Kbd>t</Kbd>} onSelect={run(toggleTheme)} />
          <Row testId="palette-action-live" value="action:live" keywords={['live only', 'filter']} icon={<Radio size={13} className="text-muted-foreground" />} label="Toggle Live only" hint={<Kbd>.</Kbd>} onSelect={run(() => state().setLiveOnly(!state().ui.liveOnly))} />
          <Row testId="palette-action-follow" value="action:follow" keywords={['stream', 'follow', 'tail']} icon={<Activity size={13} className="text-muted-foreground" />} label="Toggle stream follow" hint={<Kbd>f</Kbd>} onSelect={run(() => state().setStreamFilters({ follow: !state().ui.streamFilters.follow }))} />
          <Row testId="palette-action-clear" value="action:clear" keywords={['deselect', 'selection']} icon={<X size={13} className="text-muted-foreground" />} label="Clear selection" hint={<Kbd>esc</Kbd>} onSelect={run(() => { const s = state(); s.selectTask(null); s.selectSession(null); s.selectRun(null) })} />
          <Row testId="palette-action-oversight" value="action:oversight" keywords={['birds eye', 'overview', 'all repos', 'all agents', 'board']} icon={<LayoutGrid size={13} className="text-muted-foreground" />} label="Open oversight" hint={<Kbd>o</Kbd>} onSelect={run(() => state().setOversightOpen(true))} />
          <Row testId="palette-action-shortcuts" value="action:shortcuts" keywords={['keyboard', 'help', 'keys']} icon={<Keyboard size={13} className="text-muted-foreground" />} label="Show shortcuts" hint={<Kbd>?</Kbd>} onSelect={run(() => state().setShortcutsOpen(true))} />
          <Row testId="palette-action-copy" value="action:copy-link" keywords={['url', 'share', 'copy link']} icon={<Clipboard size={13} className="text-muted-foreground" />} label="Copy link to current view" onSelect={run(() => { void navigator.clipboard?.writeText(location.href) })} />
        </Command.Group>
      </Command.List>
    </Command>
  )
}

