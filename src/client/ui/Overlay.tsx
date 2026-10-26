import { Popover as RPopover, ScrollArea as RScroll, Tooltip as RTooltip } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'
import { cn } from '../lib/cn'

/** Radix tooltip with a 300 ms delay. Wrap the trigger element (must accept a ref). */
export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (content == null || content === '') return children
  return (
    <RTooltip.Root delayDuration={300}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="bg-panel-solid border-panel-border shadow-lift-2 z-50 max-w-xs rounded-lg border px-2 py-1 text-[11px] text-foreground"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

/** Radix popover: `trigger` is the (ref-forwarding) element that toggles it. */
export function Popover({
  trigger, children, className, align = 'start', open, onOpenChange,
}: {
  trigger: ReactElement
  children: ReactNode
  className?: string
  align?: 'start' | 'center' | 'end'
  open?: boolean
  onOpenChange?: (o: boolean) => void
}) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align={align}
          sideOffset={6}
          className={cn('bg-panel-solid border-panel-border shadow-lift-2 z-50 w-80 rounded-xl border p-3 text-[11px] text-foreground', className)}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}

/** Radix scroll area with thin scrollbars. */
export function ScrollArea({ className, children, viewportRef }: { className?: string; children: ReactNode; viewportRef?: React.Ref<HTMLDivElement> }) {
  return (
    <RScroll.Root className={cn('relative overflow-hidden', className)}>
      <RScroll.Viewport ref={viewportRef} className="size-full">{children}</RScroll.Viewport>
      <RScroll.Scrollbar orientation="vertical" className="flex w-2 touch-none p-px select-none">
        <RScroll.Thumb className="bg-border relative flex-1 rounded-full" />
      </RScroll.Scrollbar>
      <RScroll.Corner />
    </RScroll.Root>
  )
}
