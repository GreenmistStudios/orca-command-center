import { CheckCircle2 } from 'lucide-react'
import { useMemo } from 'react'
import type { AttentionItem, SessionSummary, Severity } from '../../shared/contract'
import { useNow } from '../hooks/useNow'
import { cn } from '../lib/cn'
import { useOcc } from '../state/store'
import { AgentMonogram, EmptyState, RelativeTime, SectionLabel, StateDot, kindColorVar } from '../ui'
import { ATTENTION_ICON, openAttention, sortAttention } from './shared'

const RECENT_MS = 30 * 60_000
const SEV_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' }

/** Dock content when nothing is selected: needs-you list, live sessions, recently finished. */
export function AttentionPanel() {
  const attention = useOcc((s) => s.attention)
  const sessions = useOcc((s) => s.sessions)
  const selectSession = useOcc((s) => s.selectSession)
  const now = useNow(30_000)

  const groups = useMemo(() => {
    const sorted = sortAttention(attention)
    return (['high', 'medium', 'low'] as Severity[]).map((sev) => ({ sev, items: sorted.filter((i) => i.severity === sev) })).filter((g) => g.items.length)
  }, [attention])

  const { live, recent } = useMemo(() => {
    const all = Object.values(sessions)
    const live = all.filter((s) => s.state === 'working').sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt))
    const at = (s: SessionSummary) => s.stateSince ?? s.updatedAt
    const recent = all.filter((s) => s.state === 'done' && now - at(s) <= RECENT_MS).sort((a, b) => at(b) - at(a)).slice(0, 6)
    return { live, recent }
  }, [sessions, now])

  return (
    <div data-testid="attention-panel" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="panel-header px-3 py-2"><SectionLabel>NEEDS YOU</SectionLabel>
        {attention.length > 0 && <span className="text-muted-foreground/70 ml-2 text-[11px] tabular-nums">{attention.length}</span>}
      </div>
      {attention.length === 0 ? (
        <EmptyState className="h-auto py-6" icon={<CheckCircle2 size={22} className="text-status-completed" />} title="Nothing needs you right now." />
      ) : (
        <div className="flex flex-col gap-2 p-2">
          {groups.map((g) => (
            <div key={g.sev} data-testid={`attention-group-${g.sev}`} className="flex flex-col gap-1">
              <div className="text-muted-foreground/60 px-1 text-[10px] font-medium uppercase tracking-wide">{SEV_LABEL[g.sev]}</div>
              {g.items.map((i) => <Row key={i.id} item={i} />)}
            </div>
          ))}
        </div>
      )}

      <div className="panel-header px-3 py-2"><SectionLabel>LIVE NOW</SectionLabel>
        {live.length > 0 && <span className="text-muted-foreground/70 ml-2 text-[11px] tabular-nums">{live.length}</span>}
      </div>
      {live.length === 0 ? (
        <div className="text-muted-foreground px-3 py-3 text-xs">No agents are working.</div>
      ) : (
        <ul className="flex flex-col gap-0.5 p-1.5">
          {live.map((s) => (
            <li key={s.id}>
              <button type="button" data-testid="live-row" onClick={() => selectSession(s.id)} className="focus-ring hover:bg-accent/60 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left">
                <StateDot state={s.state} />
                <AgentMonogram agent={s.agent} size={17} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold">{s.title}</span>
                  <span className="text-muted-foreground block truncate font-mono text-[10.5px]">
                    {s.current ? (
                      <><span style={{ color: kindColorVar(s.current.kind) }}>{s.current.label}</span>{s.current.detail ? ` · ${s.current.detail}` : ''}</>
                    ) : 'working'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {recent.length > 0 && (
        <>
          <div className="panel-header px-3 py-2"><SectionLabel>Recently finished</SectionLabel></div>
          <ul className="flex flex-col gap-0.5 p-1.5">
            {recent.map((s) => (
              <li key={s.id}>
                <button type="button" data-testid="recent-row" onClick={() => selectSession(s.id)} className="focus-ring hover:bg-accent/60 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left">
                  <StateDot state="done" />
                  <span className="min-w-0 flex-1 truncate text-[12px]">{s.title}</span>
                  <RelativeTime ts={s.stateSince ?? s.updatedAt} className="text-muted-foreground shrink-0 text-[10.5px]" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function Row({ item }: { item: AttentionItem }) {
  const Icon = ATTENTION_ICON[item.kind]
  return (
    <button
      type="button"
      data-testid="attention-panel-row"
      data-kind={item.kind}
      onClick={() => openAttention(item)}
      className={cn('focus-ring border-status-gate bg-status-gate-soft text-status-gate-ink flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left')}
    >
      <Icon size={15} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 block text-[12px] font-semibold">{item.title}</span>
        {item.detail && <span className="line-clamp-2 block text-[11px] opacity-80">{item.detail}</span>}
      </span>
      <RelativeTime ts={item.since} className="shrink-0 text-[10.5px] tabular-nums opacity-80" />
    </button>
  )
}
