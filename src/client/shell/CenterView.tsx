import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useOcc, type ViewId } from '../state/store'
import { ChangesView } from '../views/changes/ChangesView'
import { DagView } from '../views/dag/DagView'
import { OverviewView } from '../views/overview/OverviewView'
import { StreamView } from '../views/stream/StreamView'
import { TimelineView } from '../views/timeline/TimelineView'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'

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

const VIEWS: Record<ViewId, () => ReactNode> = {
  dag: () => <DagView />,
  timeline: () => <TimelineView />,
  stream: () => <StreamView />,
  changes: () => <ChangesView />,
  overview: () => <OverviewView />,
}

/** The active view inside the view panel, wrapped in an error boundary. */
export function CenterView() {
  const view = useOcc((s) => s.ui.view)
  return (
    <div role="tabpanel" aria-label={`${view} view`} data-testid="center-view" className="panel bg-panel-solid min-h-0 flex-1 overflow-hidden">
      <ErrorBoundary resetKey={view}>{VIEWS[view]()}</ErrorBoundary>
    </div>
  )
}
