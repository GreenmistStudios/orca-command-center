import { motion, useSpring, useTransform } from 'motion/react'
import { useEffect } from 'react'
import { cn } from '../../lib/cn'
import { formatFlowValue, type FlowFormat } from './format'
import { COUNTER_SPRING, useFlowMotion } from './motion'

export interface OdometerProps {
  /** Raw value (`percent` takes 0..1). */
  value: number
  format: FlowFormat
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

const SIZE: Record<NonNullable<OdometerProps['size']>, string> = {
  sm: 'text-[11px]',
  md: 'text-[13px]',
  lg: 'text-[22px] font-semibold',
}

/** Split `113.5k` into display chars, tagging digits. Exported for tests. */
export function splitDisplay(text: string): Array<{ ch: string; digit: number | null }> {
  return [...text].map((ch) => ({ ch, digit: /[0-9]/.test(ch) ? Number(ch) : null }))
}

function DigitColumn({ digit }: { digit: number }) {
  const spring = useSpring(digit, COUNTER_SPRING)
  useEffect(() => { spring.set(digit) }, [digit, spring])
  const y = useTransform(spring, (v) => `${-v * 10}%`)
  return (
    <span className="relative inline-block h-[1em] overflow-hidden leading-none" style={{ width: '0.62em' }} data-digit={digit}>
      <motion.span className="absolute inset-x-0 top-0 flex flex-col" style={{ y }}>
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="block h-[1em] text-center leading-none">{i}</span>
        ))}
      </motion.span>
    </span>
  )
}

/** Rolling-digit counter. Digit columns spring; separators and suffix are static; reduced motion → plain text. */
export function Odometer({ value, format, className, size = 'md' }: OdometerProps) {
  const { reduced } = useFlowMotion()
  const { text, aria } = formatFlowValue(value, format)
  const base = cn('inline-flex items-baseline font-mono tabular-nums', SIZE[size], className)
  if (reduced) {
    return <span className={base} role="text" aria-label={aria} data-odometer>{text}</span>
  }
  const chars = splitDisplay(text)
  return (
    <span className={base} role="text" aria-label={aria} data-odometer>
      <span aria-hidden="true" className="inline-flex items-baseline">
        {chars.map((c, i) => {
          const fromRight = chars.length - i
          return c.digit === null
            ? <span key={`s${fromRight}`}>{c.ch}</span>
            : <DigitColumn key={`d${fromRight}`} digit={c.digit} />
        })}
      </span>
      <span className="flow-sr-only">{text}</span>
    </span>
  )
}
