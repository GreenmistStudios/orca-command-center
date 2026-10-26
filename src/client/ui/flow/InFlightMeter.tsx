import { Check } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { cn } from '../../lib/cn'
import { formatTokens } from '../../lib/format'
import { METER_FADE_MS, METER_TICK_MS, useFlowMotion } from './motion'

export interface InFlightMeterProps {
  /** Estimated output tokens so far (streamed chars / 4). */
  estTokens: number
  /** Epoch ms the call started (exposed as a tooltip). */
  startedAt: number
  /** Metered output tokens once the call completes; morphs the estimate into this value. */
  metered?: number | null
  className?: string
}

/** Shimmer bar + "≈ 1.2k out · streaming"; becomes the metered value with a check tick on completion. */
export function InFlightMeter({ estTokens, startedAt, metered, className }: InFlightMeterProps) {
  const { reduced } = useFlowMotion()
  const done = metered !== null && metered !== undefined
  const [tick, setTick] = useState(false)
  useEffect(() => {
    if (!done) { setTick(false); return }
    setTick(true)
    const t = setTimeout(() => setTick(false), METER_TICK_MS)
    return () => clearTimeout(t)
  }, [done])

  const title = `Started ${new Date(startedAt).toLocaleTimeString()}`
  if (reduced) {
    return (
      <div className={cn('flex flex-col gap-1', className)} data-inflight={done ? 'metered' : 'streaming'} title={title}>
        <span className="text-[11px]" style={{ color: done ? 'var(--flow-output)' : 'var(--flow-estimate)' }}>
          {done ? `${formatTokens(metered)} out` : 'streaming…'}
        </span>
      </div>
    )
  }
  return (
    <div className={cn('flex flex-col gap-1', className)} data-inflight={done ? 'metered' : 'streaming'} title={title}>
      {!done && <div className="flow-shimmer-bar" data-shimmer aria-hidden="true" />}
      <div className="relative flex items-center gap-1 text-[11px] tabular-nums">
        <AnimatePresence mode="wait" initial={false}>
          {done ? (
            <motion.span
              key="metered"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: METER_FADE_MS / 1000 }}
              className="inline-flex items-center gap-1 font-medium"
              style={{ color: 'var(--flow-output)' }}
              data-metered
            >
              {formatTokens(metered)} out
              {tick && (
                <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }} data-check>
                  <Check size={12} aria-label="metered" />
                </motion.span>
              )}
            </motion.span>
          ) : (
            <motion.span
              key="estimate"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: METER_FADE_MS / 1000 }}
              className="underline decoration-dashed underline-offset-2"
              style={{ color: 'var(--flow-estimate)' }}
              data-estimate
            >
              ≈ {formatTokens(estTokens)} out · streaming
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
