import type { OccState, ViewId } from './store'

const VIEWS: readonly ViewId[] = ['dag', 'timeline', 'stream', 'changes', 'overview']

export interface UrlSelection { s: string | null; v: ViewId | null; r: string | null; t: string | null; mock: boolean }

/** Parse `?s=&v=&r=&t=&mock=`. */
export function readUrlSelection(search: string = location.search): UrlSelection {
  const p = new URLSearchParams(search)
  const v = p.get('v') as ViewId | null
  return {
    s: p.get('s'), v: v && VIEWS.includes(v) ? v : null, r: p.get('r'), t: p.get('t'),
    mock: p.has('mock') && p.get('mock') !== '0',
  }
}

/** Build the query string for the current ui selection (keeps `mock`/`degraded` when present). */
export function buildUrlSearch(ui: OccState['ui'], current: string = location.search): string {
  const cur = new URLSearchParams(current)
  const p = new URLSearchParams()
  if (cur.has('mock')) p.set('mock', cur.get('mock') ?? '1')
  if (cur.has('degraded')) p.set('degraded', cur.get('degraded') ?? '1')
  if (ui.selectedSessionId) p.set('s', ui.selectedSessionId)
  if (ui.view !== 'dag') p.set('v', ui.view)
  if (ui.selectedRunId) p.set('r', ui.selectedRunId)
  if (ui.selectedTaskId) p.set('t', ui.selectedTaskId)
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Mirror selection/view into the URL with `history.replaceState`. Returns an unsubscribe. */
export function startUrlSync(subscribe: (cb: (ui: OccState['ui']) => void) => () => void): () => void {
  return subscribe((ui) => {
    const next = buildUrlSearch(ui)
    if (next !== location.search) history.replaceState(null, '', `${location.pathname}${next}${location.hash}`)
  })
}
