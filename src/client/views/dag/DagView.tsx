import {
  Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowDownWideNarrow, ArrowRightLeft, Network } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useOcc } from '../../state/store'
import { Button, EmptyState, Spinner, toneClasses } from '../../ui'
import { cn } from '../../lib/cn'
import { OverlayToggle, WorkflowPill } from './FlowOverlay'
import { edgeFlowFor, nodeShares, workflowBurn } from './overlay'
import { elkLayout } from './layout'
import {
  assigneeLabels, buildRunGraph, buildTreeGraph, edgeStyle, mergeTreeNodes, runCaption, SESSION_SIZE, structureKey, TASK_SIZE,
  taskInfo, treeCaption, type Direction, type Graph, type LayoutFn, type Positions,
} from './model'
import { edgeTypes, nodeTypes, type DagEdgeData, type SessionNodeData, type TaskNodeData } from './nodes'

const pill = 'panel pointer-events-auto rounded-full px-3 py-1 text-xs text-muted-foreground'

export function DagView({ layout = elkLayout }: { layout?: LayoutFn } = {}) {
  return (
    <ReactFlowProvider>
      <DagCanvas layout={layout} />
    </ReactFlowProvider>
  )
}

function useNow(live: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) { setNow(Date.now()); return }
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [live])
  return now
}

function DagCanvas({ layout }: { layout: LayoutFn }) {
  const rootId = useOcc((s) => s.ui.selectedRootId)
  const runId = useOcc((s) => s.ui.selectedRunId)
  const selectedSessionId = useOcc((s) => s.ui.selectedSessionId)
  const selectedTaskId = useOcc((s) => s.ui.selectedTaskId)
  const dagDirection = useOcc((s) => s.ui.dagDirection)
  const harnessFilter = useOcc((s) => s.ui.harnessFilter)
  const sessions = useOcc((s) => s.sessions)
  const overlay = useOcc((s) => s.ui.tokens.overlay)
  const setTokensPrefs = useOcc((s) => s.setTokensPrefs)
  const setView = useOcc((s) => s.setView)
  const tree = useOcc((s) => (rootId ? s.trees[rootId] : undefined))
  const run = useOcc((s) => (runId ? s.runs[runId] : undefined))
  const fetchTree = useOcc((s) => s.fetchTree)
  const fetchRun = useOcc((s) => s.fetchRun)
  const setDagDirection = useOcc((s) => s.setDagDirection)
  const selectSession = useOcc((s) => s.selectSession)
  const selectTask = useOcc((s) => s.selectTask)

  const focusSubtree = useRef<((id: string) => void) | null>(null)
  const mode: 'run' | 'tree' | 'none' = runId ? 'run' : rootId ? 'tree' : 'none'
  const direction: Direction = mode === 'run' ? dagDirection.orchestration : dagDirection.session
  const loadable = mode === 'run' ? run : tree

  useEffect(() => { if (mode === 'tree' && rootId) void fetchTree(rootId) }, [mode, rootId, fetchTree])
  useEffect(() => { if (mode === 'run' && runId) void fetchRun(runId) }, [mode, runId, fetchRun])

  const treeNodes = useMemo(() => (tree?.data ? mergeTreeNodes(tree.data, sessions) : []), [tree?.data, sessions])
  const anyLive = mode === 'tree' && treeNodes.some((n) => n.live)
  useEffect(() => {
    if (!anyLive || !rootId) return
    const t = setInterval(() => void fetchTree(rootId, { force: true }), 15_000)
    return () => clearInterval(t)
  }, [anyLive, rootId, fetchTree])
  const now = useNow(anyLive)

  const graph: Graph | null = useMemo(() => {
    if (mode === 'tree' && tree?.data) return buildTreeGraph(tree.data)
    if (mode === 'run' && run?.data) return buildRunGraph(run.data)
    return null
  }, [mode, tree?.data, run?.data])

  /* layout, keyed by structure */
  const key = graph ? structureKey(graph, direction) : null
  const scope = `${mode}:${mode === 'run' ? runId : rootId}`
  const [laid, setLaid] = useState<{ key: string; scope: string; pos: Positions } | null>(null)
  const [layoutError, setLayoutError] = useState<string | null>(null)
  const graphRef = useRef(graph)
  graphRef.current = graph
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!key || !graphRef.current) return
    let cancelled = false
    setLayoutError(null)
    layout(graphRef.current, direction).then(
      (pos) => { if (!cancelled) setLaid({ key, scope, pos }) },
      (e: unknown) => { if (!cancelled) setLayoutError(e instanceof Error ? e.message : String(e)) },
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry, layout, direction, scope])

  const [isolatedOpen, setIsolatedOpen] = useState(true)
  const [follow, setFollow] = useState(false)
  const pos = laid && laid.key === key ? laid.pos : null

  const { nodes, edges } = useMemo(() => {
    if (!graph || !pos) return { nodes: [] as Node[], edges: [] as Edge[] }
    const stateOf = new Map<string, string>()
    const nodes: Node[] = []
    const rootTree = mode === 'tree' && tree?.data ? sessions[tree.data.rootId]?.usage?.tree ?? null : null
    if (mode === 'tree') {
      const byId = new Map(treeNodes.map((n) => [n.id, n]))
      for (const g of graph.nodes) {
        const s = byId.get(g.id)
        if (!s || !pos[g.id]) continue
        stateOf.set(g.id, s.state)
        const data: SessionNodeData = { s, selected: s.id === selectedSessionId, dimmed: harnessFilter !== 'all' && s.harness !== harnessFilter, direction, now, ...(overlay ? { flow: nodeShares(s, rootTree) } : {}) }
        nodes.push({ id: g.id, type: 'session', position: pos[g.id], data, width: SESSION_SIZE.w, height: SESSION_SIZE.h, draggable: false, connectable: false })
      }
    } else if (run?.data) {
      const d = run.data
      const who = assigneeLabels(d.tasks, d.dispatches, sessions)
      const isolated = new Set(graph.nodes.filter((n) => n.isolated).map((n) => n.id))
      const sessionOf = (taskId: string, latest: string | null) => {
        const ds = d.dispatches.filter((x) => x.taskId === taskId)
        return (ds.find((x) => x.id === latest) ?? ds[ds.length - 1])?.assigneeSessionId ?? null
      }
      for (const t of d.tasks) {
        if (!pos[t.id]) continue
        const info = taskInfo(t, d)
        stateOf.set(t.id, info.status)
        const data: TaskNodeData = { task: t, info, assignee: who[t.id] ?? null, selected: t.id === selectedTaskId, direction, now }
        if (overlay) {
          const sid = sessionOf(t.id, t.latestDispatchId)
          const sess = sid ? sessions[sid] : undefined
          if (sess?.usage) data.cost = sess.cost ?? 0
        }
        nodes.push({
          id: t.id, type: 'task', position: pos[t.id], data, width: TASK_SIZE.w, height: TASK_SIZE.h,
          hidden: isolated.has(t.id) && !isolatedOpen, draggable: false, connectable: false,
        })
      }
    }
    const edges: Edge[] = graph.edges.map((e) => {
      const st = edgeStyle(stateOf.get(e.target) ?? null)
      const flow = overlay && mode === 'tree' ? edgeFlowFor(sessions[e.target]) : null
      const data: DagEdgeData = { label: e.label, ...(flow ? { flow } : {}), style: { stroke: st.stroke, strokeWidth: st.strokeWidth, strokeDasharray: st.strokeDasharray, opacity: st.opacity } }
      return { id: e.id, source: e.source, target: e.target, type: 'dag', animated: st.animated, data, markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: st.stroke } }
    })
    return { nodes, edges }
  }, [graph, pos, mode, treeNodes, run?.data, sessions, selectedSessionId, selectedTaskId, harnessFilter, direction, now, isolatedOpen, overlay, tree?.data])

  const caption = useMemo(() => {
    if (mode === 'tree' && tree?.data) return treeCaption(sessions[tree.data.rootId]?.title ?? treeNodes[0]?.title ?? '', treeNodes)
    if (mode === 'run' && run?.data && graph) return runCaption(run.data.tasks, graph.edges.length)
    return null
  }, [mode, tree?.data, run?.data, graph, sessions, treeNodes])

  const wfTree = mode === 'tree' && tree?.data ? sessions[tree.data.rootId]?.usage?.tree ?? null : null
  const burn = useMemo(() => workflowBurn(treeNodes), [treeNodes])
  const showPill = overlay && mode === 'tree' && wfTree !== null

  const isolatedCount = graph ? graph.nodes.filter((n) => n.isolated).length : 0

  let body: ReactNode
  if (mode === 'none') body = <EmptyState icon={<Network size={20} />} title="Select an agent session or orchestration run." />
  else if (loadable?.status === 'error' && !loadable.data) {
    body = (
      <EmptyState title="Could not load the graph" hint={loadable.error}>
        <Button onClick={() => (mode === 'run' && runId ? void fetchRun(runId, { force: true }) : rootId && void fetchTree(rootId, { force: true }))}>Retry</Button>
      </EmptyState>
    )
  } else if (layoutError) {
    body = <EmptyState title="Layout failed" hint={layoutError}><Button onClick={() => setRetry((n) => n + 1)}>Retry</Button></EmptyState>
  } else if (!graph || !pos) {
    body = (
      <EmptyState icon={<Spinner />} title={mode === 'tree' && tree?.data ? `Laying out ${tree.data.nodes.length} agents…` : 'Loading…'} />
    )
  } else {
    body = (
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.05}
        maxZoom={1.5}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => (n.type === 'task' ? selectTask(n.id) : selectSession(n.id))}
        onNodeDoubleClick={(_, n) => {
          if (n.type === 'session') focusSubtree.current?.(n.id)
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap className="!hidden lg:!block" pannable zoomable nodeColor={(n) => {
          const d = n.data as Partial<SessionNodeData & TaskNodeData>
          return d.s ? toneClasses(d.s.state === 'working' ? 'dispatched' : d.s.state === 'error' ? 'failed' : d.s.state === 'done' ? 'completed' : 'pending').accentVar : d.info ? toneClasses(d.info.tone).accentVar : 'gray'
        }} />
        <Viewport scope={scope} nodes={nodes} follow={follow} treeEdges={graph.edges} register={(fn) => { focusSubtree.current = fn }} />
      </ReactFlow>
    )
  }
  const toggleDir = () => setDagDirection(mode === 'run' ? 'orchestration' : 'session', direction === 'RIGHT' ? 'DOWN' : 'RIGHT')

  return (
    <div data-testid="dag-view" className="panel bg-panel-solid relative h-full w-full overflow-hidden">
      {mode !== 'none' && (
        <>
          <div className="pointer-events-none absolute top-3 left-3 z-10 flex gap-2">
            <button type="button" className={cn(pill, 'flex items-center gap-1.5')} onClick={toggleDir} aria-label="Toggle layout direction">
              {direction === 'RIGHT' ? <ArrowRightLeft size={13} /> : <ArrowDownWideNarrow size={13} />}
              {direction === 'RIGHT' ? 'Left → right' : 'Top → bottom'}
            </button>
            {mode === 'run' && isolatedCount > 0 && (
              <button type="button" className={pill} aria-pressed={isolatedOpen} onClick={() => setIsolatedOpen((v) => !v)}>
                Isolated tasks ({isolatedCount})
              </button>
            )}
            <OverlayToggle on={overlay} onToggle={() => setTokensPrefs({ overlay: !overlay })} />
            {mode === 'tree' && (
              <button type="button" className={pill} aria-pressed={follow} onClick={() => setFollow((v) => !v)}>
                Follow live{follow ? ' ✓' : ''}
              </button>
            )}
          </div>
          {showPill && wfTree && (
            <WorkflowPill tree={wfTree} burn={burn} onOpen={() => { setTokensPrefs({ scope: 'workflow' }); setView('tokens') }} />
          )}
          {caption && !showPill && <div data-testid="dag-caption" className={cn(pill, 'absolute top-12 left-1/2 z-10 max-w-[80%] -translate-x-1/2 truncate')}>{caption}</div>}
          <div className={cn(pill, 'absolute bottom-3 left-1/2 z-10 -translate-x-1/2')}>fill = state · stripe = agent</div>
        </>
      )}
      {body}
    </div>
  )
}

/** Handles fitView / follow-live inside the ReactFlow context. */
function Viewport({ scope, nodes, follow, treeEdges, register }: {
  scope: string; nodes: Node[]; follow: boolean; treeEdges: { source: string; target: string }[]
  register: (fn: (id: string) => void) => void
}) {
  const rf = useReactFlow()
  const fitted = useRef<string | null>(null)
  const known = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (fitted.current === scope || nodes.length === 0) return
    fitted.current = scope
    known.current = new Set(nodes.map((n) => n.id))
    const t = setTimeout(() => void rf.fitView({ padding: 0.2, maxZoom: 1 }), 0)
    return () => clearTimeout(t)
  }, [scope, nodes, rf])

  useEffect(() => {
    if (fitted.current !== scope) return
    const fresh = nodes.filter((n) => !known.current.has(n.id))
    fresh.forEach((n) => known.current.add(n.id))
    const target = fresh.find((n) => (n.data as Partial<SessionNodeData>).s?.state === 'working')
    if (follow && target) {
      void rf.setCenter(target.position.x + SESSION_SIZE.w / 2, target.position.y + SESSION_SIZE.h / 2, { duration: 400, zoom: rf.getZoom() })
    }
  }, [nodes, follow, scope, rf])

  const edgesRef = useRef(treeEdges)
  edgesRef.current = treeEdges
  useEffect(() => {
    register((id) => {
      const sub = new Set([id])
      for (let grew = true; grew;) {
        grew = false
        for (const e of edgesRef.current) if (sub.has(e.source) && !sub.has(e.target)) { sub.add(e.target); grew = true }
      }
      void rf.fitView({ nodes: [...sub].map((i) => ({ id: i })), padding: 0.2, maxZoom: 1, duration: 400 })
    })
  }, [register, rf])
  return null
}
