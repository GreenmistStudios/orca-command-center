import { LoaderCircle } from 'lucide-react'
import { cn } from '../lib/cn'

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} className={cn('animate-spin', className)} aria-label="Loading" role="status" />
}
