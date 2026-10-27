import { motion } from 'motion/react'
import { useId, type ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface SegmentedOption<T extends string> { value: T; label: ReactNode; count?: number; title?: string }

const MICRO = { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const }

/** Segmented control with a sliding `layoutId` pill. Generic over the option value. */
export function Segmented<T extends string>({
  options, value, onChange, layoutId, className, 'aria-label': ariaLabel,
}: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (v: T) => void
  layoutId?: string
  className?: string
  'aria-label'?: string
}) {
  const auto = useId()
  const lid = layoutId ?? `seg-${auto}`
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('seg-track', className)}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className="seg-item"
          >
            {active && (
              <motion.span layoutId={lid} transition={MICRO} className="bg-panel-solid shadow-lift-1 absolute inset-0 rounded-md" />
            )}
            <span className="relative flex items-center justify-center gap-1">
              {o.label}
              {o.count != null && <span className="text-muted-foreground/70 tabular-nums">{o.count}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** View-tab pattern (`role=tablist`) used by the center view switcher and inspector tabs. */
export function TabList<T extends string>({
  tabs, value, onChange, className, 'aria-label': ariaLabel, idPrefix = 'tab',
}: {
  tabs: Array<{ value: T; label: ReactNode; icon?: ReactNode; count?: number }>
  /** `null` when no tab is active (e.g. a view opened from elsewhere); the first tab stays focusable. */
  value: T | null
  onChange: (v: T) => void
  className?: string
  'aria-label'?: string
  idPrefix?: string
}) {
  const focusable = tabs.some((t) => t.value === value) ? value : tabs[0]?.value
  const move = (i: number, d: number) => {
    const n = tabs[(i + d + tabs.length) % tabs.length]
    onChange(n.value)
    requestAnimationFrame(() => document.getElementById(`${idPrefix}-${n.value}`)?.focus())
  }
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('flex gap-0.5', className)}>
      {tabs.map((t, i) => (
        <button
          key={t.value}
          id={`${idPrefix}-${t.value}`}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          tabIndex={t.value === focusable ? 0 : -1}
          className="view-tab"
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); move(i, 1) }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); move(i, -1) }
          }}
        >
          {t.icon}
          {t.label}
          {t.count != null && <span className="text-muted-foreground/70 tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}
