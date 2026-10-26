import { useOcc } from '../state/store'
import { toneClasses } from '../ui/tones'
import { cn } from '../lib/cn'
import type { SourceHealth } from '../../shared/contract'

/** One-sentence message for a source that is not healthy (null when ok/starting/disabled). */
export function sourceMessage(s: SourceHealth): string | null {
  if (s.status === 'ok' || s.status === 'starting' || s.status === 'disabled') return null
  const verb = s.status === 'missing' ? 'not found' : s.status === 'error' ? 'is failing' : 'is degraded'
  return s.detail ?? `${s.label} ${verb}${s.path ? ` (${s.path})` : ''}.`
}

/** Warnings above the shell: Orca stopped, unhealthy sources, orchestration degraded / newer schema. Hidden when empty. */
export function Banner() {
  const meta = useOcc((s) => s.meta)
  const orca = useOcc((s) => s.orca)
  const orch = useOcc((s) => s.orchestration)
  const lines: Array<{ key: string; node: React.ReactNode }> = []

  const status = orca?.status ?? meta?.orca
  if (status && !status.running) {
    lines.push({ key: 'orca', node: <>Orca isn’t running; showing last-known state.{status.error && <span className="opacity-70"> ({status.error})</span>}</> })
  }
  for (const s of meta?.sources ?? []) {
    const m = sourceMessage(s)
    if (m) lines.push({ key: `src-${s.id}`, node: <>{m}</> })
  }
  if (orch && orch.schemaVersion != null && orch.schemaVersion > orch.testedSchemaVersion) {
    lines.push({ key: 'schema', node: <>orchestration.db is from a newer Orca schema — some data may be missing or mislabeled. <span className="opacity-70">(schema v{orch.schemaVersion})</span></> })
  }
  if (orch && orch.degraded.length > 0) {
    lines.push({
      key: 'degraded',
      node: (
        <>
          Orchestration is running in a degraded mode:
          <ul className="mt-1 list-disc pl-5 opacity-90">{orch.degraded.map((d) => <li key={d}>{d}</li>)}</ul>
        </>
      ),
    })
  }
  if (lines.length === 0) return null
  return (
    <div role="alert" data-testid="banner" className={cn('shadow-lift-1 flex flex-col gap-px overflow-hidden rounded-xl border text-xs', toneClasses('gate').surface)}>
      {lines.map((l) => <div key={l.key} className="px-4 py-2" data-testid="banner-line">{l.node}</div>)}
    </div>
  )
}
