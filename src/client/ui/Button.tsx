import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

const button = cva(
  'focus-ring inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        outline: 'border border-input bg-background hover:bg-accent',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        subtle: 'bg-muted text-foreground hover:bg-accent',
      },
      size: { sm: 'h-7 px-2', icon: 'size-7' },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>

export function Button({ variant, size, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={cn(button({ variant, size }), className)} {...rest} />
}

/** Icon-only button: `aria-label` is required. */
export function IconButton({
  'aria-label': label, variant = 'ghost', className, ...rest
}: Omit<ButtonProps, 'size' | 'aria-label'> & { 'aria-label': string }) {
  return <Button aria-label={label} title={label} variant={variant} size="icon" className={className} {...rest} />
}
