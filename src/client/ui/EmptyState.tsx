import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

/** Centered empty/placeholder state (12px). `icon` is a ReactNode, e.g. `<Inbox size={20}/>`. */
export function EmptyState({
  icon, title, hint, className, children,
}: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <div data-testid="empty-state" className={cn('text-muted-foreground flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center text-xs', className)}>
      {icon && <div className="text-muted-foreground/70 mb-1">{icon}</div>}
      <div className="text-foreground font-medium">{title}</div>
      {hint && <div className="max-w-sm">{hint}</div>}
      {children}
    </div>
  )
}
