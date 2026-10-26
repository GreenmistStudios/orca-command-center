import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Button, CopyButton } from '../ui'

/** Shimmering placeholder lines. */
export function Skeleton({ lines = 5, className }: { lines?: number; className?: string }) {
  return (
    <div data-testid="inspector-skeleton" className={cn('flex flex-col gap-2 p-3', className)} aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="bg-muted h-3 animate-pulse rounded" style={{ width: `${95 - ((i * 17) % 45)}%` }} />
      ))}
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="border-status-failed bg-status-failed-soft text-status-failed-ink m-3 flex items-center justify-between gap-2 rounded-lg border p-2 text-[11px]">
      <span className="min-w-0 break-words">{message}</span>
      {onRetry && <Button variant="subtle" onClick={onRetry}>Retry</Button>}
    </div>
  )
}

export function Section({ title, children, right }: { title: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-panel-border/60 border-b px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}

export function KV({ k, children, copy }: { k: string; children: ReactNode; copy?: string }) {
  return (
    <>
      <dt className="text-muted-foreground text-[11px]">{k}</dt>
      <dd className="flex min-w-0 items-center gap-1 font-mono text-[11px] break-all">
        <span className="min-w-0">{children}</span>
        {copy && <CopyButton text={copy} label={`Copy ${k}`} className="size-5" />}
      </dd>
    </>
  )
}

export function PreBlock({ text, copy = true, className }: { text: string; copy?: boolean; className?: string }) {
  return (
    <div className="relative">
      <pre className={cn('pre-block m-0 max-h-64 overflow-auto', className)}>{text}</pre>
      {copy && <CopyButton text={text} label="Copy output" className="absolute top-1 right-1 size-5" />}
    </div>
  )
}
