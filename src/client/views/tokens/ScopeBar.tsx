import { Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { UsageScopeKind } from '../../../shared/contract'
import type { TokensPrefs } from '../../state/store'
import { Button, LiveDot } from '../../ui'
import { CostDisclaimer } from '../../ui/flow'
import { Seg } from './Controls'
import { DAY_MS, LIVE_FRESH_MS, truncate, type ResolvedScope } from './model'

const WINDOWS: Array<{ value: string; label: string; ms: number | null }> = [
  { value: '900000', label: '15m', ms: 900_000 },
  { value: '3600000', label: '1h', ms: 3_600_000 },
  { value: String(DAY_MS), label: '24h', ms: DAY_MS },
  { value: 'all', label: 'All', ms: null },
]
const KINDS: Array<[UsageScopeKind, string]> = [['fleet', 'Fleet'], ['workflow', 'Workflow'], ['session', 'Session'], ['run', 'Run']]

export interface ScopeBarProps {
  resolved: ResolvedScope
  prefs: TokensPrefs
  windowMs: number | null
  lastSampleAt: number | null
  exporting: boolean
  onPrefs(p: Partial<TokensPrefs>): void
  onExport(): void
}

export function ScopeBar({ resolved, prefs, windowMs, lastSampleAt, exporting, onPrefs, onExport }: ScopeBarProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t) }, [])
  const live = lastSampleAt != null && now - lastSampleAt < LIVE_FRESH_MS
  const fleet = resolved.kind === 'fleet'
  return (
    <div className="panel panel-header flex-row flex-wrap items-center gap-2 px-3 py-2" data-testid="tokens-scope-bar" role="toolbar" aria-label="Token scope and display options">
      <Seg
        label="Scope" value={resolved.kind} onChange={(kind) => onPrefs({ scope: kind })}
        options={KINDS.map(([k, label]) => {
          const o = resolved.options[k]
          return {
            value: k, disabled: !o.enabled, title: o.enabled ? o.title ?? undefined : `Select a ${k} first`,
            label: o.title ? <span className="flex items-center gap-1">{label}<span className="text-muted-foreground max-w-24 truncate font-normal">· {truncate(o.title, 18)}</span></span> : label,
          }
        })}
      />
      <Seg
        label="Window" value={windowMs == null ? 'all' : String(windowMs)}
        onChange={(v) => onPrefs({ windowMs: WINDOWS.find((w) => w.value === v)?.ms ?? null })}
        options={WINDOWS.map((w) => ({ value: w.value, label: w.label, disabled: fleet && w.ms === null, title: fleet && w.ms === null ? 'Fleet view is limited to 24 h' : undefined }))}
      />
      <Seg label="Units" value={prefs.units} onChange={(units) => onPrefs({ units })} options={[{ value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' }]} />
      <Seg label="Scale" value={prefs.scale} onChange={(scale) => onPrefs({ scale })} options={[{ value: 'balanced', label: 'Balanced' }, { value: 'linear', label: 'Linear' }]} />
      <Seg
        label="Middle" value={prefs.middle} onChange={(middle) => onPrefs({ middle })}
        options={[{ value: 'auto', label: 'Auto' }, { value: 'agent', label: 'Agents' }, { value: 'session', label: 'Sessions' }, { value: 'model', label: 'Models' }]}
      />
      <div className="ml-auto flex items-center gap-2">
        {prefs.units === 'cost' && <CostDisclaimer />}
        <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]" data-testid="tokens-live" data-live={live}>
          <LiveDot live={live} />{live ? 'Live' : 'Idle'}
        </span>
        <Button variant="ghost" size="sm" onClick={() => onPrefs({ showCalls: !prefs.showCalls })} aria-pressed={prefs.showCalls}>Calls</Button>
        <Button variant="ghost" size="sm" onClick={onExport} disabled={exporting} aria-label="Export calls as CSV"><Download size={13} />CSV</Button>
      </div>
    </div>
  )
}
