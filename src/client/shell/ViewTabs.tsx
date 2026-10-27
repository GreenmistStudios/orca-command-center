import { Activity, FileDiff, GitBranch, LayoutDashboard, SquareChartGantt } from 'lucide-react'
import { useOcc, type ViewId } from '../state/store'
import { TabList } from '../ui/Segmented'

/** The six center views. Exported for the palette/hotkeys (Task-16). */
export const VIEW_ORDER: ViewId[] = ['fleet', 'dag', 'timeline', 'stream', 'changes', 'overview']

/** View switcher (`role=tablist`); the DAG tab reads "Run DAG" while an orchestration run is selected. */
export function ViewTabs() {
  const view = useOcc((s) => s.ui.view)
  const runSelected = useOcc((s) => s.ui.selectedRunId != null)
  const setView = useOcc((s) => s.setView)
  return (
    <TabList<ViewId>
      aria-label="Views"
      idPrefix="view-tab"
      className="panel max-w-full gap-0.5 self-end overflow-x-auto p-0.5 max-lg:self-stretch"
      value={view === 'fleet' ? null : view}
      onChange={setView}
      tabs={[
        { value: 'dag', label: runSelected ? 'Run DAG' : 'DAG', icon: <GitBranch size={14} /> },
        { value: 'timeline', label: 'Timeline', icon: <SquareChartGantt size={14} /> },
        { value: 'stream', label: 'Stream', icon: <Activity size={14} /> },
        { value: 'changes', label: 'Changes', icon: <FileDiff size={14} /> },
        { value: 'overview', label: 'Overview', icon: <LayoutDashboard size={14} /> },
      ]}
    />
  )
}
