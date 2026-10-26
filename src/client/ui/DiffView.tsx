import { useMemo, useState } from 'react'
import type { FileDiff } from '../../shared/contract'
import { cn } from '../lib/cn'
import { parsePatchText, parseUnifiedDiff, type ParsedDiff } from '../lib/diff'
import { Button } from './Button'

const LINE_CLASS = {
  add: 'text-status-completed-ink bg-[color-mix(in_oklch,var(--status-completed)_14%,transparent)]',
  del: 'text-status-failed-ink bg-[color-mix(in_oklch,var(--status-failed)_14%,transparent)]',
  ctx: 'text-foreground/80',
  meta: 'text-muted-foreground/70 italic',
} as const
const MARK = { add: '+', del: '−', ctx: ' ', meta: ' ' } as const

/**
 * Renders a FileDiff: `unified` (hunks + gutters), `new-file` (all additions), `patch-text`
 * (apply_patch bodies) or a note for `none`. `maxLines` caps rendering with a "Show all" button.
 */
export function DiffView({ diff, maxLines = 400, className }: { diff: FileDiff; maxLines?: number; className?: string }) {
  const [all, setAll] = useState(false)
  const parsed: ParsedDiff | null = useMemo(() => {
    if (!diff.text) return null
    if (diff.format === 'unified') return parseUnifiedDiff(diff.text)
    if (diff.format === 'patch-text') return parsePatchText(diff.text)
    if (diff.format === 'new-file') {
      const lines = diff.text.replace(/\n$/, '').split('\n')
      return {
        files: [{ oldPath: '', newPath: diff.path, hunks: [{ header: 'New file', lines: lines.map((t, i) => ({ type: 'add' as const, text: t, oldNo: null, newNo: i + 1 })) }] }],
        additions: lines.length, deletions: 0,
      }
    }
    return null
  }, [diff])

  if (!parsed || parsed.files.length === 0) {
    return <div className={cn('text-muted-foreground p-2 text-[11px]', className)} data-testid="diff-empty">{diff.note ?? 'No diff available for this change.'}</div>
  }

  let budget = all ? Infinity : maxLines
  let hidden = 0
  return (
    <div className={cn('bg-muted/40 border-panel-border/60 overflow-auto rounded-lg border font-mono text-[11px] leading-relaxed', className)} data-testid="diff-view">
      {parsed.files.map((f, fi) => (
        <div key={fi}>
          {(parsed.files.length > 1 || diff.format === 'patch-text') && (
            <div className="bg-muted/60 text-muted-foreground/80 border-panel-border/60 border-b px-2 py-0.5 text-[10px]">{f.newPath || f.oldPath}</div>
          )}
          {f.hunks.map((h, hi) => {
            if (budget <= 0) { hidden += h.lines.length; return null }
            const shown = h.lines.slice(0, budget)
            hidden += h.lines.length - shown.length
            budget -= shown.length
            return (
              <div key={hi}>
                <div className="bg-muted/60 text-muted-foreground/70 px-2 py-0.5">{h.header}</div>
                {shown.map((l, li) => (
                  <div key={li} className={cn('flex whitespace-pre', LINE_CLASS[l.type])} data-line={l.type}>
                    <span className="text-muted-foreground/60 w-9 shrink-0 pr-1 text-right text-[10px] select-none">{l.oldNo ?? ''}</span>
                    <span className="text-muted-foreground/60 w-9 shrink-0 pr-1 text-right text-[10px] select-none">{l.newNo ?? ''}</span>
                    <span className="w-4 shrink-0 text-center select-none">{MARK[l.type]}</span>
                    <span>{l.text}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      ))}
      {hidden > 0 && (
        <div className="p-1.5">
          <Button variant="subtle" onClick={() => setAll(true)}>Show all ({hidden} more lines)</Button>
        </div>
      )}
      {diff.truncated && <div className="text-muted-foreground p-1.5 text-[10px]">Diff truncated by the server.</div>}
    </div>
  )
}
