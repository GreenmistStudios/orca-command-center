import { useOcc } from '../state/store'
import { EmptyState } from '../ui/EmptyState'

/** PLACEHOLDER — Task-15 replaces this with the full Attention panel (+ "Live now"). Fills the dock. */
export function AttentionPanel() {
  const count = useOcc((s) => s.attention.length)
  return <EmptyState title="Attention panel — Task-15" hint={`${count} attention item${count === 1 ? '' : 's'}`} />
}
