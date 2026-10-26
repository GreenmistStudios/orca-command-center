import { motion } from 'motion/react'
import { useId, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface SegOption<T extends string> { value: T; label: ReactNode; title?: string; disabled?: boolean }

/** Segmented radio group (same look as ui/Segmented) with per-option `disabled`. */
export function Seg<T extends string>({ options, value, onChange, label, className }: {
  options: SegOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string
}) {
  const lid = `tokseg-${useId()}`
  return (
    <div role="radiogroup" aria-label={label} className={cn('seg-track', className)}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value} type="button" role="radio" aria-checked={active} disabled={o.disabled} title={o.title}
            onClick={() => onChange(o.value)} className="seg-item disabled:cursor-not-allowed disabled:opacity-40"
          >
            {active && <motion.span layoutId={lid} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="bg-panel-solid shadow-lift-1 absolute inset-0 rounded-md" />}
            <span className="relative flex items-center justify-center gap-1">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
