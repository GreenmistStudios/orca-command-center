import type { ReactNode, Ref } from 'react'
import { cn } from '../../lib/cn'
import { DeltaChips, type DeltaChipsHandle } from './DeltaChips'
import { Odometer, type OdometerProps } from './Odometer'
import { Sparkline } from './Sparkline'

export interface KpiTileProps {
  label: string
  value: number
  format: OdometerProps['format']
  /** 11px muted sub-line (breakdown with flow-color dots etc.). */
  sub?: ReactNode
  /** Sparkline values (24px tall at the bottom). */
  spark?: number[]
  sparkColor?: string
  /** Imperative handle for the top-right delta chips: `chipsRef.current?.push(...)`. */
  chipsRef?: Ref<DeltaChipsHandle>
  /** Cost disclaimer etc., rendered next to the label. */
  info?: ReactNode
  className?: string
}

/** KPI tile (design-system §15.3): label, odometer, sub-line, delta chips, sparkline. */
export function KpiTile({ label, value, format, sub, spark, sparkColor, chipsRef, info, className }: KpiTileProps) {
  return (
    <div className={cn('panel bg-panel-solid relative flex min-w-0 flex-col gap-1 px-4 py-3', className)} data-kpi={label}>
      <div className="text-muted-foreground flex items-center gap-1 text-[10px] font-medium tracking-[0.1em] uppercase">
        <span>{label}</span>
        {info}
      </div>
      <Odometer value={value} format={format} size="lg" />
      {sub && <div className="text-muted-foreground text-[11px]">{sub}</div>}
      {chipsRef && <DeltaChips ref={chipsRef} className="absolute top-2 right-3" />}
      {spark && spark.length > 1 && <Sparkline values={spark} color={sparkColor} height={24} className="mt-1" />}
    </div>
  )
}
