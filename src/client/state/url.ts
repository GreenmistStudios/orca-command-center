import type { OccState, ViewId } from './store'

const VIEWS: readonly ViewId[] = ['dag', 'timeline', 'stream', 'changes', 'overview']
const MAX_ID = 256

export interface UrlSelection { s: string | null; v: ViewId | null; r: string | null; t: string | null; mock: boolean }

const clean = (v: string | null): string | null => {
  if (v == null) return null
  const t = v.trim()
  return t && t.length <= MAX_ID ? t : null
}

/** Parse `?s=&v=&r=&t=&mock=`. Empty/oversized ids and unknown views are ignored. */
export function readUrlSelection(search: string = location.search): UrlSelection {
  const p = new URLSearchParams(search)
  const v = p.get('v')?.trim() as ViewId | undefined
  return {
    s: clean(p.get('s')), v: v && VIEWS.includes(v) ? v : null, r: clean(p.get('r')), t: clean(p.get('t')),
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

/**
 * Mirror selection/view into the URL. Changing the selected session or run pushes a history entry
 * (so back/forward walks selections); view/task changes replace. Returns an unsubscribe.
 */
export function startUrlSync(subscribe: (cb: (ui: OccState['ui']) => void) => () => void): () => void {
  return subscribe((ui) => {
    const next = buildUrlSearch(ui)
    if (next === location.search) return
    const prev = readUrlSelection()
    const navigated = (prev.s ?? null) !== (ui.selectedSessionId ?? null) || (prev.r ?? null) !== (ui.selectedRunId ?? null)
    const url = `${location.pathname}${next}${location.hash}`
    if (navigated) history.pushState(null, '', url)
    else history.replaceState(null, '', url)
  })
}

/** Minimal store surface used by `applyUrlSelection` (avoids a runtime import cycle with the store). */
export interface UrlTarget {
  getState(): Pick<OccState, 'sessions' | 'selectSession' | 'selectRun' | 'selectTask' | 'setView' | 'ui'>
}

/** Apply a parsed URL to the store (popstate). Unknown session ids clear the selection. */
export function applyUrlSelection(store: UrlTarget, sel: UrlSelection): void {
  const st = store.getState()
  st.setView(sel.v ?? 'dag')
  if (sel.s && st.sessions[sel.s]) st.selectSession(sel.s)
  else if (sel.r) st.selectRun(sel.r)
  else st.selectSession(null)
  if (sel.t) store.getState().selectTask(sel.t)
}
