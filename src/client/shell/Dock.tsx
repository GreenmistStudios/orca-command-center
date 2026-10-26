import { useCallback, useRef } from 'react'
import { motion } from 'motion/react'
import { AttentionPanel } from '../attention/AttentionPanel'
import { Inspector } from '../inspector/Inspector'
import { DOCK_MAX, DOCK_MIN, useOcc } from '../state/store'
import { ErrorBoundary } from './CenterView'

/**
 * Right dock: resizable (drag the left edge or use ←/→ on the handle; 320–640 px, persisted).
 * Shows the Inspector when a session or task is selected, otherwise the Attention panel.
 */
export function Dock() {
  const width = useOcc((s) => s.ui.dockWidth)
  const setWidth = useOcc((s) => s.setDockWidth)
  const hasSel = useOcc((s) => s.ui.selectedSessionId != null || s.ui.selectedTaskId != null)
  const drag = useRef<{ x: number; w: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { x: e.clientX, w: useOcc.getState().ui.dockWidth }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return
    setWidth(drag.current.w + (drag.current.x - e.clientX))
  }, [setWidth])
  const end = useCallback(() => { drag.current = null }, [])

  return (
    <motion.aside
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34, mass: 0.9 }}
      aria-label={hasSel ? 'Inspector' : 'Attention'}
      data-testid="dock"
      style={{ ['--dock-w' as string]: `${width}px` }}
      className="panel relative flex min-h-0 w-full shrink-0 flex-col overflow-hidden max-lg:max-h-[45vh] lg:w-[var(--dock-w)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize dock"
        aria-valuemin={DOCK_MIN}
        aria-valuemax={DOCK_MAX}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="dock-handle"
        className="focus-ring hover:bg-selection/30 absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize lg:block"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(width + 24) }
          if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(width - 24) }
        }}
      />
      <ErrorBoundary resetKey={String(hasSel)}>{hasSel ? <Inspector /> : <AttentionPanel />}</ErrorBoundary>
    </motion.aside>
  )
}
