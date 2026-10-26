import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useOcc, type ViewId } from '../state/store'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Spinner } from '../ui/Spinner'

interface BoundaryState { error: Error | null }

/** Catches render errors in a view and offers a retry. Reusable around any panel. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, BoundaryState> {
  override state: BoundaryState = { error: null }
  static getDerivedStateFromError(error: Error): BoundaryState { return { error } }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error('[occ] view crashed', error, info.componentStack) }
  override componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }
  override render() {
    if (!this.state.error) return this.props.children
    return (
      <EmptyState icon={<TriangleAlert size={20} />} title="This view hit an error" hint={this.state.error.message}>
        <Button className="mt-2" onClick={() => this.setState({ error: null })}>Retry</Button>
      </EmptyState>
    )
  }
}

const ChangesView = lazy(() => import('../views/changes/ChangesView').then((m) => ({ default: m.ChangesView })))
const DagView = lazy(() => import('../views/dag/DagView').then((m) => ({ default: m.DagView })))
const OverviewView = lazy(() => import('../views/overview/OverviewView').then((m) => ({ default: m.OverviewView })))
const StreamView = lazy(() => import('../views/stream/StreamView').then((m) => ({ default: m.StreamView })))
const TimelineView = lazy(() => import('../views/timeline/TimelineView').then((m) => ({ default: m.TimelineView })))

const TokensView = lazy(() => import('../views/tokens/TokensView').then((m) => ({ default: m.TokensView })))

const VIEWS: Record<ViewId, () => ReactNode> = {
  dag: () => <DagView />,
  timeline: () => <TimelineView />,
  stream: () => <StreamView />,
  changes: () => <ChangesView />,
  overview: () => <OverviewView />,
  tokens: () => <TokensView />,
}

/** The active view inside the view panel, wrapped in an error boundary. */
export function CenterView() {
  const view = useOcc((s) => s.ui.view)
  return (
    <div role="tabpanel" aria-label={`${view} view`} id="center-view" data-testid="center-view" className="panel bg-panel-solid min-h-0 flex-1 overflow-hidden">
      <ErrorBoundary resetKey={view}>
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>{VIEWS[view]()}</Suspense>
      </ErrorBoundary>
    </div>
  )
}
