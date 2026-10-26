import { useOcc } from '../state/store'

/** PLACEHOLDER — Task-15 replaces this with the attention strip. Returns null when there are no items. */
export function AttentionStrip() {
  const items = useOcc((s) => s.attention)
  if (items.length === 0) return null
  return (
    <div data-testid="attention-strip" className="rounded-xl border border-status-gate bg-status-gate-soft px-4 py-2.5 text-xs text-status-gate-ink">
      {items.length} item{items.length === 1 ? '' : 's'} need attention — Attention strip — Task-15
    </div>
  )
}
