import { useEffect, useRef, useState } from 'react'
import { useOcc } from '../state/store'
import { cn } from '../lib/cn'
import { Chip, RelativeTime } from '../ui'
import { ATTENTION_ICON, openAttention, openAttentionPanel, sortAttention } from './shared'

export const STRIP_MAX_ROWS = 3

/** Ids that appeared after mount (used for the one-shot pulse of new high-severity items). */
function useNewIds(ids: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const key = ids.join('|')
  useEffect(() => {
    if (seen.current === null) { seen.current = new Set(ids); return }
    const added = ids.filter((i) => !seen.current!.has(i))
    ids.forEach((i) => seen.current!.add(i))
    if (!added.length) return
    setFresh(new Set(added))
    const t = setTimeout(() => setFresh(new Set()), 1800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return fresh
}

/** Gate-colored strip above the canvas listing everything that needs a human. Hidden when empty. */
export function AttentionStrip() {
  const attention = useOcc((s) => s.attention)
  const sorted = sortAttention(attention)
  const fresh = useNewIds(sorted.map((i) => i.id))
  if (sorted.length === 0) return null
  const shown = sorted.slice(0, STRIP_MAX_ROWS)
  const more = sorted.length - shown.length
  const blob = 'pointer-events-none absolute size-40 rounded-full blur-3xl opacity-20 motion-reduce:animate-none'
  return (
    <section
      data-testid="attention-strip"
      aria-label="Needs attention"
      className="relative max-h-40 shrink-0 overflow-y-auto overflow-x-hidden rounded-xl border border-status-gate bg-status-gate-soft px-4 py-2.5 text-status-gate-ink"
      style={{ boxShadow: '0 0 0 1px color-mix(in oklch, var(--status-gate) 35%, transparent), var(--lift-2, 0 4px 12px #0002)' }}
    >
      <span aria-hidden className={blob} style={{ left: '-2rem', top: '-3rem', background: 'radial-gradient(circle, var(--status-gate), transparent 70%)', animation: 'orca-drift 19s ease-in-out infinite' }} />
      <span aria-hidden className={blob} style={{ left: '45%', bottom: '-4rem', background: 'radial-gradient(circle, var(--status-gate), transparent 70%)', animation: 'orca-drift 25s ease-in-out infinite' }} />
      <span aria-hidden className={blob} style={{ right: '-2rem', top: '-2rem', background: 'radial-gradient(circle, var(--status-gate), transparent 70%)', animation: 'orca-drift 22s ease-in-out infinite' }} />
      <ul className="relative flex flex-col gap-1.5">
        {shown.map((item) => {
          const Icon = ATTENTION_ICON[item.kind]
          return (
            <li
              key={item.id}
              data-testid="attention-row"
              data-kind={item.kind}
              data-severity={item.severity}
              data-fresh={fresh.has(item.id) && item.severity === 'high' ? 'true' : undefined}
              className={cn('flex items-center gap-3 rounded-lg', fresh.has(item.id) && item.severity === 'high' && 'motion-safe:[animation:orca-pulse_1.2s_ease-out_2]')}
              style={{ ['--orca-pulse' as string]: 'var(--status-gate)' }}
            >
              <Icon size={16} className="shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[13px] font-semibold">{item.title}</div>
                {item.detail && <div className="line-clamp-1 text-[11px] opacity-80">{item.detail}</div>}
              </div>
              <RelativeTime ts={item.since} className="shrink-0 text-[11px] tabular-nums opacity-80" />
              <button type="button" onClick={() => openAttention(item)} aria-label={`Open ${item.title}`} className="focus-ring shrink-0 rounded-full">
                <Chip>Open</Chip>
              </button>
            </li>
          )
        })}
      </ul>
      {more > 0 && (
        <button type="button" data-testid="attention-more" onClick={openAttentionPanel} className="focus-ring relative mt-1.5 text-[11px] font-medium underline-offset-2 hover:underline">
          +{more} more
        </button>
      )}
    </section>
  )
}
