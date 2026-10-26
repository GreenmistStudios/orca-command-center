import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { toneClasses, type Tone } from './tones'

/** Tone-colored pill; `tone` omitted → neutral pill. */
export function StatusPill({
  tone, icon, className, children, ...rest
}: { tone?: Tone; icon?: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn('status-pill', tone ? toneClasses(tone).surface : 'neutral-pill', className)} {...rest}>
      {icon}
      {children}
    </span>
  )
}

/** Blue selection chip (design-system §6 `chip`). */
export function Chip({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('chip', className)} {...rest} />
}

/** Small badge: outline (default), solid, or mono (`v43`). */
export function Badge({
  variant = 'outline', className, ...rest
}: { variant?: 'outline' | 'solid' | 'mono' } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-0 text-[10px]',
        variant === 'outline' && 'border border-panel-border text-muted-foreground',
        variant === 'solid' && 'bg-foreground text-background font-medium',
        variant === 'mono' && 'border border-panel-border font-mono text-muted-foreground',
        className,
      )}
      {...rest}
    />
  )
}

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn('rounded border border-panel-border bg-muted px-1 font-mono text-[10px] text-muted-foreground', className)}
      {...rest}
    />
  )
}
