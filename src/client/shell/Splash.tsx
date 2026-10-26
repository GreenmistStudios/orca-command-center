import { Radar } from 'lucide-react'
import { useOcc } from '../state/store'

/** Full-screen "Connecting to Orca…" splash; shows the bootstrap error (retrying every 3 s). */
export function Splash() {
  const error = useOcc((s) => s.bootstrapError)
  return (
    <div role="status" data-testid="splash" className="bg-field field-bg flex h-full flex-col items-center justify-center gap-4">
      <div className="bg-primary text-primary-foreground flex size-14 items-center justify-center rounded-2xl" style={{ boxShadow: '0 0 36px -8px var(--selection)' }}>
        <Radar size={28} />
      </div>
      <p className="orca-shimmer-text text-sm font-medium">Connecting to Orca…</p>
      {error && (
        <p className="text-status-failed-ink bg-status-failed-soft border-status-failed max-w-md rounded-xl border px-4 py-2 text-center text-xs">
          Couldn’t load the fleet: {error}. Retrying in a few seconds…
        </p>
      )}
    </div>
  )
}
