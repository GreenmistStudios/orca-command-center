import { AlertTriangle, Coins } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SankeyNode, UsageSample } from '../../../shared/contract'
import { formatCount } from '../../lib/format'
import { selectAutoUsageScope } from '../../state/selectors'
import { usageCallsKey, useOcc } from '../../state/store'
import { useLiveUsage } from '../../state/usage-live'
import { Button, EmptyState, SectionLabel } from '../../ui'
import { CallsLedger } from './CallsLedger'
import { FlowPanel } from './FlowPanel'
import { KpiSkeleton, Kpis } from './Kpis'
import { Leaderboard } from './Leaderboard'
import { ScopeBar } from './ScopeBar'
import { StreamPanel } from './StreamPanel'
import { Yield } from './Yield'
import {
  CSV_MAX_CALLS, callsToCsv, csvFilename, effectiveWindow, mergeCalls, resolveTokensScope, type BoardFilter, type BoardTab,
} from './model'

/** Trigger a client-side download of `csv`. */
function download(filename: string, csv: string): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function TokensView() {
  const prefs = useOcc((s) => s.ui.tokens)
  const auto = useOcc(selectAutoUsageScope)
  const selectedRootId = useOcc((s) => s.ui.selectedRootId)
  const selectedSessionId = useOcc((s) => s.ui.selectedSessionId)
  const selectedRunId = useOcc((s) => s.ui.selectedRunId)
  const sessions = useOcc((s) => s.sessions)
  const runs = useOcc((s) => s.orchestration?.runs)
  const setTokensPrefs = useOcc((s) => s.setTokensPrefs)

  const resolved = useMemo(
    () => resolveTokensScope(prefs.scope, auto, { selectedRootId, selectedSessionId, selectedRunId }, sessions, runs),
    [prefs.scope, auto, selectedRootId, selectedSessionId, selectedRunId, sessions, runs],
  )
  const scope = resolved.scope
  const windowMs = effectiveWindow(prefs.windowMs, resolved.kind)
  const live = useLiveUsage(scope, { windowMs, middle: prefs.middle })
  const report = live.report && live.report.scope.kind === scope.kind && live.report.scope.id === scope.id ? live.report : null

  const [tab, setTab] = useState<BoardTab>('agent')
  const [filter, setFilter] = useState<BoardFilter | null>(null)
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const [exporting, setExporting] = useState(false)
  const scopeKey = `${scope.kind}:${scope.id ?? ''}:${windowMs ?? 'all'}:${prefs.middle}`
  useEffect(() => { setFilter(null); setZoom(null) }, [scopeKey])

  // calls ledger
  const callsKey = usageCallsKey(scope)
  const callsL = useOcc((s) => s.usageCalls[callsKey])
  useEffect(() => { if (prefs.showCalls) void useOcc.getState().fetchUsageCalls(scope) }, [prefs.showCalls, scope])
  const calls = useMemo(() => (prefs.showCalls ? mergeCalls(callsL?.data?.calls, report?.recentCalls) : []), [prefs.showCalls, callsL?.data?.calls, report?.recentCalls])
  const loadOlder = useCallback(() => { void useOcc.getState().fetchUsageCalls(scope, { older: true }) }, [scope])

  const selectSession = useCallback((id: string) => useOcc.getState().selectSession(id), [])
  const openChanges = useCallback(() => useOcc.getState().setView('changes'), [])
  const clearFilter = useCallback(() => setFilter(null), [])
  const resetZoom = useCallback(() => setZoom(null), [])
  const brush = useCallback((r: [number, number]) => setZoom(r), [])

  const onNodeClick = useCallback((node: SankeyNode) => {
    const middle = report?.sankey.middle
    if (middle === 'session') { if (node.sessionId) selectSession(node.sessionId); return }
    if (middle !== 'agent' && middle !== 'model') return
    const key = node.id.slice(4)
    setFilter((f) => (f && f.key === key && f.kind === middle ? null : { kind: middle, key, label: node.label }))
    setTab('session')
  }, [report?.sankey.middle, selectSession])

  const exportCsv = useCallback(async () => {
    setExporting(true)
    try {
      const st = useOcc.getState()
      await st.fetchUsageCalls(scope, { force: true })
      for (let i = 0; i < 100; i++) {
        const d = useOcc.getState().usageCalls[callsKey]?.data
        if (!d || !d.hasMore || d.calls.length >= CSV_MAX_CALLS) break
        await useOcc.getState().fetchUsageCalls(scope, { older: true })
        if (useOcc.getState().usageCalls[callsKey]?.data?.before === d.before) break
      }
      const all: UsageSample[] = mergeCalls(useOcc.getState().usageCalls[callsKey]?.data?.calls, report?.recentCalls).slice(0, CSV_MAX_CALLS)
      download(csvFilename(scope, Date.now()), callsToCsv(all))
    } finally { setExporting(false) }
  }, [scope, callsKey, report?.recentCalls])

  const selectedNodeId = filter ? `mid:${filter.key}` : report?.sankey.middle === 'session' && selectedSessionId ? `mid:${selectedSessionId}` : null

  const bar = (
    <ScopeBar
      resolved={resolved} prefs={prefs} windowMs={windowMs} lastSampleAt={Math.max(live.lastSampleAt ?? 0, report?.totals.lastTs ?? 0) || null}
      exporting={exporting} showsCost={prefs.units === 'cost' || (report?.totals.costedCalls ?? 0) > 0} onPrefs={setTokensPrefs} onExport={exportCsv}
    />
  )

  let body
  if (!report) {
    body = live.status === 'error'
      ? (
        <div className="panel bg-panel-solid flex items-center gap-3 p-4" role="alert" data-testid="tokens-error">
          <AlertTriangle size={16} className="text-destructive" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-xs"><div className="font-medium">Couldn’t load token usage</div><div className="text-muted-foreground truncate">{live.error}</div></div>
          <Button onClick={live.refresh}>Retry</Button>
        </div>
      )
      : <KpiSkeleton />
  } else if (resolved.kind === 'run' && report.coverage.sessions === 0) {
    body = <EmptyState icon={<Coins size={20} />} title="This run has no linked sessions" hint="Tokens appear once the run’s tasks are dispatched to sessions." className="panel bg-panel-solid h-auto" />
  } else if (report.totals.calls === 0 && report.inFlight.length === 0) {
    body = <EmptyState icon={<Coins size={20} />} title="No metered calls in this scope yet." hint="Usage appears as soon as a session completes an LLM call." className="panel bg-panel-solid h-auto" />
  } else {
    body = (
      <>
        <Kpis report={report} scope={scope} />
        <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <FlowPanel report={report} scope={scope} windowMs={windowMs} units={prefs.units} scale={prefs.scale} selectedNodeId={selectedNodeId} onNodeClick={onNodeClick} />
          <Leaderboard report={report} units={prefs.units} tab={tab} filter={filter} sessions={sessions} onTab={setTab} onClearFilter={clearFilter} onSelectSession={selectSession} />
        </div>
        <StreamPanel report={report} windowMs={windowMs} units={prefs.units} scale={prefs.scale} zoom={zoom} onBrush={brush} onResetZoom={resetZoom} />
        {(resolved.kind === 'workflow' || resolved.kind === 'session') && <Yield report={report} onOpen={openChanges} />}
        {prefs.showCalls && (
          <CallsLedger
            calls={calls} scope={scope} sessions={sessions} hasMore={callsL?.data?.hasMore ?? false}
            loading={callsL?.status === 'loading'} onLoadOlder={loadOlder} onSelectSession={selectSession}
          />
        )}
      </>
    )
  }

  return (
    <div data-testid="tokens-view" className="flex h-full min-h-0 flex-col gap-3">
      {bar}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {body}
        {report && report.coverage.notes.length > 0 && (
          <aside className="text-muted-foreground flex flex-col gap-0.5 text-[11px]" aria-label="Coverage notes" data-testid="tokens-coverage">
            <SectionLabel>COVERAGE · {formatCount(report.coverage.sessionsWithUsage)} of {formatCount(report.coverage.sessions)} sessions metered</SectionLabel>
            <ul className="list-disc pl-4">{report.coverage.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </aside>
        )}
      </div>
    </div>
  )
}
