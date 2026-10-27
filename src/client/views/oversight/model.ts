import type { AgentState, OrchRun, SessionSummary } from '../../../shared/contract'
import { AGENT_STATE_PRIORITY } from '../../../shared/contract'
import { buildFleetGraph, type FleetCounts, type FleetInput } from '../fleet/model'

/** Birds-eye oversight: every repo → worktree → root agents / runs, derived from the fleet model. */
export interface OversightAgent { session: SessionSummary; needsYou: boolean; workingDescendants: number }
export interface OversightRun { run: OrchRun; needsYou: boolean }
export interface OversightWorktree {
  id: string
  name: string
  branch: string | null
  terminals: number
  state: AgentState
  counts: FleetCounts
  agents: OversightAgent[]
  runs: OversightRun[]
}
export interface OversightRepo { id: string; name: string; state: AgentState; counts: FleetCounts; worktrees: OversightWorktree[] }
export interface Oversight { repos: OversightRepo[]; totals: FleetCounts & { repos: number; worktrees: number; agents: number } }

/**
 * Same grouping as the Fleet view (Orca worktrees, path matching, synthetic "Unattached"), but
 * uncapped (no overflow) so every agent is shown. Repos are ordered by urgency: needs-you first,
 * then working, then by name.
 */
export function buildOversight(input: FleetInput, opts: { scope: 'active' | 'all'; harness: string | null }): Oversight {
  const g = buildFleetGraph(input, { ...opts, collapsed: new Set(), maxNodes: Number.POSITIVE_INFINITY })
  const children = new Map<string, string[]>()
  for (const e of g.edges) {
    if (e.label) continue // run → coordinator link, not containment
    const list = children.get(e.source)
    if (list) list.push(e.target)
    else children.set(e.source, [e.target])
  }

  const repos: OversightRepo[] = []
  for (const n of g.nodes) {
    const p = g.data[n.id]
    if (p?.kind !== 'project') continue
    const worktrees: OversightWorktree[] = []
    for (const wid of children.get(n.id) ?? []) {
      const w = g.data[wid]
      if (w?.kind !== 'worktree') continue
      const agents: OversightAgent[] = []
      const runs: OversightRun[] = []
      for (const cid of children.get(wid) ?? []) {
        const c = g.data[cid]
        if (c?.kind === 'session') agents.push({ session: c.session, needsYou: c.needsYou, workingDescendants: c.workingDescendants })
        else if (c?.kind === 'run') runs.push({ run: c.run, needsYou: c.needsYou })
      }
      worktrees.push({ id: w.id, name: w.name, branch: w.branch, terminals: w.terminals, state: w.state, counts: w.counts, agents, runs })
    }
    repos.push({ id: p.id, name: p.name, state: p.state, counts: p.counts, worktrees })
  }

  repos.sort((a, b) =>
    Number(b.counts.needsYou > 0) - Number(a.counts.needsYou > 0) ||
    Number(b.counts.working > 0) - Number(a.counts.working > 0) ||
    AGENT_STATE_PRIORITY[a.state] - AGENT_STATE_PRIORITY[b.state] ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const totals = { repos: repos.length, worktrees: 0, agents: 0, live: 0, working: 0, needsYou: 0, idle: 0, error: 0 }
  for (const r of repos) {
    totals.worktrees += r.worktrees.length
    for (const w of r.worktrees) totals.agents += w.agents.length
    totals.live += r.counts.live; totals.working += r.counts.working; totals.needsYou += r.counts.needsYou
    totals.idle += r.counts.idle; totals.error += r.counts.error
  }
  return { repos, totals }
}
