import {
  Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowDownWideNarrow, ArrowRightLeft, ChevronsDownUp, ChevronsUpDown, Maximize, Network } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HARNESS_META, type Harness } from '../../../shared/contract'
import { useOcc } from '../../state/store'
import { Button, EmptyState, IconButton, Segmented, Spinner, orchStatusTone, stateTone, toneClasses } from '../../ui'
import { edgeStyle, structureKey, type Direction, type LayoutFn, type Positions } from '../dag/model'
import { elkLayout } from '../dag/layout'
import { useClock } from '../timeline/useClock'
import { buildFleetGraph, type FleetGraph } from './model'
import { nodeTypes, type FleetRenderData } from './nodes'

type Scope = 'active' | 'all'
const SCOPE_KEY = 'occ.fleet.scope'
const readScope = (): Scope => {
  try { return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'active' } catch { return 'active' }
}

export function FleetView({ layout = elkLayout }: { layout?: LayoutFn } = {}) {
  return (
    <ReactFlowProvider>
      <FleetCanvas layout={layout} />
    </ReactFlowProvider>
  )
}

function FleetCanvas({ layout }: { layout: LayoutFn }) {
  const bootstrapped = useOcc((s) => s.bootstrapped)
  const sessions = useOcc((s) => s.sessions)
  const worktrees = useOcc((s) => s.orca?.worktrees)
  const runs = useOcc((s) => s.orchestration?.runs)
  const attention = useOcc((s) => s.attention)
  const windowMs = useOcc((s) => s.meta?.windowMs ?? 24 * 3600_000)
  const harnessFilter = useOcc((s) => s.ui.harnessFilter)
  const selectedSessionId = useOcc((s) => s.ui.selectedSessionId)
  const selectedRunId = useOcc((s) => s.ui.selectedRunId)
  const dagDirection = useOcc((s) => s.ui.dagDirection)
  const setHarnessFilter = useOcc((s) => s.setHarnessFilter)
  const setDagDirection = useOcc((s) => s.setDagDirection)
  const selectSession = useOcc((s) => s.selectSession)
  const selectRoot = useOcc((s) => s.selectRoot)
  const selectRun = useOcc((s) => s.selectRun)
  const setView = useOcc((s) => s.setView)

  const direction: Direction = dagDirection.session
  const now = useClock(15_000)
  const [scope, setScopeState] = useState<Scope>(readScope)
  const setScope = (v: Scope) => {
    setScopeState(v)
    try { localStorage.setItem(SCOPE_KEY, v) } catch { /* ignore */ }
  }
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  const graph: FleetGraph = useMemo(
    () => buildFleetGraph(
      { sessions, worktrees: worktrees ?? [], runs: runs ?? [], attention, now, windowMs },
      { scope, harness: harnessFilter === 'all' ? null : harnessFilter, collapsed },
    ),
    [sessions, worktrees, runs, attention, now, windowMs, scope, harnessFilter, collapsed],
  )

  /* layout only on structure change */
  const key = structureKey(graph, direction)
  const graphRef = useRef(graph)
  graphRef.current = graph
  const [laid, setLaid] = useState<{ key: string; pos: Positions } | null>(null)
  const [layoutError, setLayoutError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (graphRef.current.nodes.length === 0) { setLaid({ key, pos: {} }); return }
    let cancelled = false
    setLayoutError(null)
    layout(graphRef.current, direction).then(
      (pos) => { if (!cancelled) setLaid({ key, pos }) },
      (e: unknown) => { if (!cancelled) setLayoutError(e instanceof Error ? e.message : String(e)) },
    )
    return () => { cancelled = true }
  }, [key, retry, layout, direction])
  const pos = laid?.pos ?? null

  const [fitTick, setFitTick] = useState(0)

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])
  const rawId = (id: string) => id.slice(2)
  const activate = useCallback((id: string) => {
    if (id.startsWith('s:')) selectSession(rawId(id))
    else if (id.startsWith('r:')) selectRun(rawId(id))
    else if (id.startsWith('p:') || id.startsWith('w:')) toggle(id)
    else if (id.startsWith('o:')) setScope('all')
  }, [selectSession, selectRun, toggle])
  const open = useCallback((id: string) => {
    if (id.startsWith('s:')) { selectRoot(rawId(id)); setView('dag') }
    else if (id.startsWith('r:')) { selectRun(rawId(id)); setView('dag') }
  }, [selectRoot, selectRun, setView])

  const { nodes, edges } = useMemo(() => {
    if (!pos) return { nodes: [] as Node[], edges: [] as Edge[] }
    const nodes: Node[] = []
    for (const g of graph.nodes) {
      const p = pos[g.id]
      const d = graph.data[g.id]
      if (!p || !d) continue
      const selected = (d.kind === 'session' && d.session.id === selectedSessionId) || (d.kind === 'run' && d.run.id === selectedRunId)
      const data: FleetRenderData = { d, selected, direction, now, onActivate: activate, onOpen: open }
      nodes.push({ id: g.id, type: g.type, position: p, data, width: g.w, height: g.h, draggable: false, connectable: false })
    }
    const have = new Set(nodes.map((n) => n.id))
    const edges: Edge[] = graph.edges.filter((e) => have.has(e.source) && have.has(e.target)).map((e) => {
      const td = graph.data[e.target]
      const working = td?.kind === 'session' && td.session.state === 'working'
      const st = edgeStyle(td?.kind === 'session' ? td.session.state : null)
      const dashed = e.label === 'coordinates'
      return {
        id: e.id, source: e.source, target: e.target, type: 'smoothstep', animated: working,
        label: e.label ?? undefined,
        style: { stroke: st.stroke, strokeWidth: st.strokeWidth, strokeDasharray: dashed ? '6 4' : st.strokeDasharray, opacity: st.opacity },
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: st.stroke },
      }
    })
    return { nodes, edges }
  }, [graph, pos, selectedSessionId, selectedRunId, direction, now, activate, open])

  const summary = useMemo(() => {
    let projects = 0, wts = 0, working = 0, needs = 0, runCount = 0
    for (const d of Object.values(graph.data)) {
      if (d.kind === 'project') { projects++; working += d.counts.working; needs += d.counts.needsYou }
      else if (d.kind === 'worktree') wts++
      else if (d.kind === 'run') runCount++
    }
    return `${projects} projects · ${wts} worktrees · ${working} working · ${needs} needs you · ${runCount} runs`
  }, [graph])

  const allIds = useMemo(() => Object.values(graph.data).filter((d) => d.kind === 'project' || d.kind === 'worktree').map((d) => d.id), [graph])
  const anyCollapsible = allIds.length > 0
  const allCollapsed = collapsed.size > 0
  const toggleAll = () => setCollapsed(allCollapsed ? new Set() : new Set(Object.values(graph.data).filter((d) => d.kind === 'project').map((d) => d.id)))

  let body
  if (!bootstrapped) body = <EmptyState icon={<Spinner />} title="Loading…" />
  else if (layoutError) {
    body = <EmptyState title="Layout failed" hint={layoutError}><Button onClick={() => setRetry((n) => n + 1)}>Retry</Button></EmptyState>
  } else if (graph.nodes.length === 0 && scope === 'active') {
    body = <EmptyState icon={<Network size={20} />} title="Nothing running"><Button onClick={() => setScope('all')}>Show all</Button></EmptyState>
  } else if (graph.nodes.length === 0) {
    body = <EmptyState icon={<Network size={20} />} title="No projects found" />
  } else if (!pos) {
    body = <EmptyState icon={<Spinner />} title="Laying out…" />
  } else {
    body = (
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.05}
        maxZoom={1.5}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => activate(n.id)}
        onNodeDoubleClick={(_, n) => open(n.id)}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap className="!hidden lg:!block" pannable zoomable nodeColor={(n) => {
          const d = (n.data as Partial<FleetRenderData>).d
          if (!d) return 'gray'
          if (d.kind === 'session' || d.kind === 'project' || d.kind === 'worktree') return toneClasses(stateTone(d.kind === 'session' ? d.session.state : d.state)).accentVar
          if (d.kind === 'run') return toneClasses(orchStatusTone(d.run.hasBlockingGate ? 'blocked' : 'dispatched')).accentVar
          return 'gray'
        }} />
        <Fitter pos={pos} tick={fitTick} />
      </ReactFlow>
    )
  }

  return (
    <div data-testid="fleet-view" className="panel bg-panel-solid relative flex h-full w-full flex-col overflow-hidden">
      <div className="panel-header sticky top-0 z-10 flex flex-wrap items-center gap-2">
        <Segmented<Scope>
          aria-label="Scope"
          layoutId="fleet-scope"
          value={scope}
          onChange={setScope}
          options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]}
        />
        <select
          aria-label="Harness"
          className="bg-transparent rounded-md border px-1.5 py-0.5 text-xs"
          value={harnessFilter}
          onChange={(e) => setHarnessFilter(e.target.value as Harness | 'all')}
        >
          <option value="all">All harnesses</option>
          {(Object.keys(HARNESS_META) as Harness[]).map((h) => <option key={h} value={h}>{HARNESS_META[h].label}</option>)}
        </select>
        <span data-testid="fleet-summary" className="text-muted-foreground text-xs tabular-nums">{summary}</span>
        <div className="ml-auto flex gap-1">
          <IconButton aria-label={allCollapsed ? 'Expand all' : 'Collapse all'} disabled={!anyCollapsible && !allCollapsed} onClick={toggleAll}>
            {allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
          </IconButton>
          <IconButton aria-label="Toggle layout direction" onClick={() => setDagDirection('session', direction === 'RIGHT' ? 'DOWN' : 'RIGHT')}>
            {direction === 'RIGHT' ? <ArrowRightLeft size={14} /> : <ArrowDownWideNarrow size={14} />}
          </IconButton>
          <IconButton aria-label="Fit view" onClick={() => setFitTick((n) => n + 1)}><Maximize size={14} /></IconButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  )
}

/** Fits on first layout and whenever Fit is pressed. */
function Fitter({ pos, tick }: { pos: Positions; tick: number }) {
  const rf = useReactFlow()
  const first = useRef(true)
  const lastTick = useRef(tick)
  useEffect(() => {
    const want = first.current || lastTick.current !== tick
    if (!want || Object.keys(pos).length === 0) return
    first.current = false
    lastTick.current = tick
    const t = setTimeout(() => void rf.fitView({ padding: 0.2, maxZoom: 1 }), 0)
    return () => clearTimeout(t)
  }, [pos, tick, rf])
  return null
}
