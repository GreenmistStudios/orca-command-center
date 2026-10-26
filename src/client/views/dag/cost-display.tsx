import type { SessionSummary } from '../../../shared/contract'
import { Odometer } from '../../ui/flow'

export const NO_COST_TIP = 'Cost not reported by this harness'

export type CostDisplay = { kind: 'cost'; cost: number } | { kind: 'aiu'; aiu: number } | { kind: 'none' }

/** What to show for a session's spend: a reported cost, Copilot AI units, or nothing (never a fake $0). */
export function costDisplay(s: SessionSummary, tree: boolean): CostDisplay {
  const t = tree ? s.usage?.tree ?? null : null
  const costed = t ? t.costedCalls > 0 : s.harness !== 'copilot' || (s.cost ?? 0) > 0
  if (costed) return { kind: 'cost', cost: t ? t.cost : s.cost ?? 0 }
  const aiu = t ? t.aiu : s.usage?.aiu ?? 0
  return aiu > 0 ? { kind: 'aiu', aiu } : { kind: 'none' }
}

/** Cost odometer, AIU text, or an em dash with tooltip. */
export function CostOrAiu({ d }: { d: CostDisplay }) {
  if (d.kind === 'cost') return <Odometer value={d.cost} format="cost" size="sm" />
  if (d.kind === 'aiu') return <span title="Copilot AI units; cost not reported">{d.aiu.toFixed(1)} AIU</span>
  return <span title={NO_COST_TIP}>—</span>
}
