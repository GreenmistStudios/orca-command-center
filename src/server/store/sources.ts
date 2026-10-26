import type { SourceHealth, SourceId } from '../../shared/contract.js'
import { createCopilotSource } from '../sources/copilot/index.js'
import { createOpenCodeSource } from '../sources/opencode/index.js'
import { createOrcaCliSource, createOrcaHooksSource } from '../sources/orca/index.js'
import { createOrchestrationSource } from '../sources/orchestration/index.js'
import type {
  HarnessSource,
  OrcaCliSource,
  OrcaHooksSource,
  OrchestrationSource,
  SourceBase,
  SourceDeps,
} from '../types.js'

export interface SourceSet {
  harnesses: HarnessSource[]
  cli: OrcaCliSource | null
  hooks: OrcaHooksSource | null
  orch: OrchestrationSource | null
  /** Every constructed source, in display order. */
  all: SourceBase[]
  /** Placeholders for sources that are not configured. */
  disabled: SourceHealth[]
}

const LABELS: Record<SourceId, string> = {
  opencode: 'OpenCode',
  copilot: 'Copilot CLI',
  'orca-cli': 'Orca CLI',
  'orca-hooks': 'Orca hooks',
  'orca-orchestration': 'Orca orchestration',
}

function disabled(id: SourceId, reason: string): SourceHealth {
  return { id, label: LABELS[id], status: 'disabled', path: null, version: null, detail: reason, lastReadAt: null, lastChangeAt: null }
}

/** Construct sources from config (Task-8 §A). Unconfigured sources become `disabled` placeholders. */
export function buildSources(deps: SourceDeps): SourceSet {
  const { config } = deps
  const set: SourceSet = { harnesses: [], cli: null, hooks: null, orch: null, all: [], disabled: [] }
  const order: SourceId[] = ['opencode', 'copilot', 'orca-cli', 'orca-hooks', 'orca-orchestration']
  const placeholders = new Map<SourceId, SourceHealth>()

  if (config.opencodeDb) {
    const s = createOpenCodeSource(deps)
    set.harnesses.push(s)
    set.all.push(s)
  } else placeholders.set('opencode', disabled('opencode', 'OpenCode database not found (use --opencode-db)'))

  if (config.copilotDir) {
    const s = createCopilotSource(deps)
    set.harnesses.push(s)
    set.all.push(s)
  } else placeholders.set('copilot', disabled('copilot', 'Copilot directory not found (~/.copilot)'))

  if (config.orcaCli) {
    set.cli = createOrcaCliSource(deps)
    set.all.push(set.cli)
  } else placeholders.set('orca-cli', disabled('orca-cli', 'Orca CLI not found'))

  if (config.hooksFile) {
    set.hooks = createOrcaHooksSource(deps)
    set.all.push(set.hooks)
  } else placeholders.set('orca-hooks', disabled('orca-hooks', 'Orca hooks file not found'))

  if (config.orchestrationDb) {
    set.orch = createOrchestrationSource(deps)
    set.all.push(set.orch)
  } else placeholders.set('orca-orchestration', disabled('orca-orchestration', 'orchestration.db not found'))

  set.disabled = order.flatMap((id) => (placeholders.has(id) ? [placeholders.get(id)!] : []))
  return set
}

/** Health of every source, constructed or disabled, in canonical order. */
export function allHealth(set: SourceSet): SourceHealth[] {
  const order: SourceId[] = ['opencode', 'copilot', 'orca-cli', 'orca-hooks', 'orca-orchestration']
  const byId = new Map<SourceId, SourceHealth>()
  for (const d of set.disabled) byId.set(d.id, d)
  for (const s of set.all) {
    try {
      byId.set(s.id, s.health())
    } catch (e) {
      byId.set(s.id, { id: s.id, label: LABELS[s.id], status: 'error', path: null, version: null, detail: e instanceof Error ? e.message : String(e), lastReadAt: null, lastChangeAt: null })
    }
  }
  return order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
}
