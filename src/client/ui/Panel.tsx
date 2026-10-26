import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/cn'

/** Translucent bordered surface (design-system §6 `panel`). */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('panel', className)} {...rest} />
}

export function PanelHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('panel-header', className)} {...rest} />
}

/** 11px uppercase muted section label ("FLEET"). */
export function SectionLabel({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement> & { children?: ReactNode }) {
  return <span className={cn('section-label', className)} {...rest}>{children}</span>
}
