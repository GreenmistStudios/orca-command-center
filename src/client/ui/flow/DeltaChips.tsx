import { AnimatePresence, motion } from 'motion/react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { FlowKind } from '../../../shared/contract'
import { cn } from '../../lib/cn'
import { formatDelta } from './format'
import { FLOW_SHORT, FLOW_VAR } from './flows'
import { CHIP_ENTER_MS, CHIP_EXIT_MS, CHIP_HOLD_MS, CHIP_MERGE_MS, MAX_CHIPS, useFlowMotion } from './motion'

export interface DeltaPush {
  /** Signed token amount, or pre-formatted text (e.g. `+$0.21`). */
  label: number | string
  flow: FlowKind | 'cost'
}

export interface DeltaChipsHandle {
  push(d: DeltaPush): void
}

export interface DeltaChipsProps {
  className?: string
}

export interface Chip { id: number; flow: FlowKind | 'cost'; amount: number | null; text: string; at: number }

/** Pure merge: same flow within `mergeMs` adds numeric amounts; list capped to `max` (newest kept). */
export function mergeChip(chips: Chip[], push: DeltaPush, now: number, nextId: number, mergeMs = CHIP_MERGE_MS, max = MAX_CHIPS): { chips: Chip[]; touchedId: number } {
  const amount = typeof push.label === 'number' ? push.label : null
  const suffix = push.flow === 'cost' ? '' : ` ${FLOW_SHORT[push.flow]}`
  const idx = amount !== null ? chips.findIndex((c) => c.flow === push.flow && c.amount !== null && now - c.at <= mergeMs) : -1
  if (idx >= 0) {
    const c = chips[idx]
    const sum = (c.amount ?? 0) + (amount ?? 0)
    const next = chips.slice()
    next[idx] = { ...c, amount: sum, text: `${formatDelta(sum)}${suffix}`, at: now }
    return { chips: next, touchedId: c.id }
  }
  const chip: Chip = { id: nextId, flow: push.flow, amount, at: now, text: amount !== null ? `${formatDelta(amount)}${suffix}` : String(push.label) }
  return { chips: [...chips, chip].slice(-max), touchedId: nextId }
}

/** Floating "+12.4k in" chips. Use via ref: `ref.current.push({ label: 12400, flow: 'input' })`. Reduced motion → renders nothing. */
export const DeltaChips = forwardRef<DeltaChipsHandle, DeltaChipsProps>(function DeltaChips({ className }, ref) {
  const { reduced } = useFlowMotion()
  const [chips, setChips] = useState<Chip[]>([])
  const idRef = useRef(1)
  const chipsRef = useRef<Chip[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const expire = useCallback((id: number) => {
    const t = timers.current.get(id)
    if (t) clearTimeout(t)
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id)
      chipsRef.current = chipsRef.current.filter((c) => c.id !== id)
      setChips(chipsRef.current)
    }, CHIP_ENTER_MS + CHIP_HOLD_MS))
  }, [])

  useImperativeHandle(ref, () => ({
    push(d) {
      if (reduced) return
      const r = mergeChip(chipsRef.current, d, Date.now(), idRef.current)
      if (r.touchedId === idRef.current) idRef.current++
      const live = new Set(r.chips.map((c) => c.id))
      for (const id of [...timers.current.keys()]) if (!live.has(id)) { clearTimeout(timers.current.get(id)); timers.current.delete(id) }
      chipsRef.current = r.chips
      setChips(r.chips)
      expire(r.touchedId)
    },
  }), [reduced, expire])

  useEffect(() => {
    const t = timers.current
    return () => { for (const x of t.values()) clearTimeout(x); t.clear() }
  }, [])

  if (reduced) return null
  return (
    <div className={cn('pointer-events-none flex flex-col items-end gap-0.5', className)} aria-hidden="true" data-delta-chips>
      <AnimatePresence initial={false}>
        {chips.map((c) => (
          <motion.span
            key={c.id}
            data-chip
            initial={{ y: 6, opacity: 0 }}
            animate={{ y: -10, opacity: 1, transition: { duration: CHIP_ENTER_MS / 1000 } }}
            exit={{ y: -22, opacity: 0, transition: { duration: CHIP_EXIT_MS / 1000, ease: 'easeOut' } }}
            className="rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums"
            style={{ color: FLOW_VAR[c.flow], background: `color-mix(in oklch, ${FLOW_VAR[c.flow]} 18%, transparent)` }}
          >
            {c.text}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  )
})
