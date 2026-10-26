import { useEffect } from 'react'
import { applyUrlSelection, readUrlSelection, type UrlSelection } from '../state/url'
import { useOcc } from '../state/store'
import { addNotice } from './notices'

const TITLE = 'Orca Command Center'

/** Radar favicon, with an orange dot when something high-severity needs you. */
export function faviconHref(alert: boolean): string {
  const dot = alert ? "%3Ccircle cx='19' cy='5' r='4.5' fill='%23f97316' stroke='white' stroke-width='1'/%3E" : ''
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%233b82f6' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M19.07 4.93A10 10 0 0 0 6.99 3.34'/%3E%3Cpath d='M4 6h.01'/%3E%3Cpath d='M2.29 9.62A10 10 0 1 0 21.31 8.35'/%3E%3Cpath d='M16.24 7.76A6 6 0 1 0 8.23 16.67'/%3E%3Cpath d='M12 18h.01'/%3E%3Cpath d='M17.99 11.66A6 6 0 0 1 15.77 16.67'/%3E%3Ccircle cx='12' cy='12' r='2'/%3E%3Cpath d='m13.41 10.59 5.66-5.66'/%3E${dot}%3C/svg%3E`
}

/** `(N) Orca Command Center` title and attention favicon. */
export function useAttentionBadge(): void {
  const n = useOcc((s) => s.attention.length)
  const high = useOcc((s) => s.attention.some((a) => a.severity === 'high'))
  useEffect(() => { document.title = n > 0 ? `(${n}) ${TITLE}` : TITLE }, [n])
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
    link.type = 'image/svg+xml'
    link.href = faviconHref(high)
  }, [high])
}

/**
 * Back/forward restores selection; unknown ids from the initial URL produce an inline notice
 * after bootstrap (a session id still gets a `fetchSessionDetail` attempt).
 */
export function useUrlRestore(initial: UrlSelection): void {
  const ready = useOcc((s) => s.bootstrapped)
  useEffect(() => {
    if (!ready) return
    const st = useOcc.getState()
    if (initial.s && !st.sessions[initial.s]) {
      addNotice(`s:${initial.s}`, `Session ${initial.s} is outside the 24 h window.`)
      void st.fetchSessionDetail(initial.s)
    }
    if (initial.r && !st.orchestration?.runs.some((r) => r.id === initial.r)) addNotice(`r:${initial.r}`, `Run ${initial.r} was not found.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
  useEffect(() => {
    const onPop = () => { if (useOcc.getState().bootstrapped) applyUrlSelection(useOcc, readUrlSelection()) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
}
