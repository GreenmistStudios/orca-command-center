import { useEffect } from 'react'
import { useOcc, type ViewId } from '../state/store'

const VIEW_KEYS: Record<string, ViewId> = { '1': 'fleet', '2': 'dag', '3': 'timeline', '4': 'stream', '5': 'changes', '6': 'overview' }

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || el.getAttribute?.('contenteditable') === 'true' || el.getAttribute?.('contenteditable') === ''
}

/** Global keyboard shortcuts (Plan §7.6). Ignored while typing, except Esc and ⌘/Ctrl+K. */
export function useGlobalHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useOcc.getState()
      const ui = st.ui
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        st.setPaletteOpen(!ui.paletteOpen)
        return
      }
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return // a dialog already handled it
        if (ui.paletteOpen) st.setPaletteOpen(false)
        else if (ui.shortcutsOpen) st.setShortcutsOpen(false)
        else if (ui.oversightOpen) st.setOversightOpen(false)
        else if (ui.selectedTaskId) st.selectTask(null)
        else if (ui.selectedSessionId) st.selectSession(null)
        else if (ui.selectedRunId) st.selectRun(null)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (ui.paletteOpen || ui.shortcutsOpen || isTyping(e.target)) return
      if (e.key === 'o') { st.setOversightOpen(!ui.oversightOpen); return }
      if (ui.oversightOpen) return
      const k = e.key
      if (VIEW_KEYS[k]) { st.setView(VIEW_KEYS[k]); return }
      switch (k) {
        case 'j': st.selectAdjacentRoot(1); break
        case 'k': st.selectAdjacentRoot(-1); break
        case 'J': st.selectAdjacentCast(1); break
        case 'K': st.selectAdjacentCast(-1); break
        case '/': {
          const el = document.getElementById('rail-search')
          if (!el) return
          e.preventDefault()
          el.focus()
          break
        }
        case '.': st.setLiveOnly(!ui.liveOnly); break
        case 'f': st.setStreamFilters({ follow: !ui.streamFilters.follow }); break
        case ' ': {
          if (ui.view !== 'stream') return
          if ((e.target as HTMLElement | null)?.closest?.('button,a,[role=tab],[role=separator],[role=button]')) return
          e.preventDefault()
          st.setStreamFilters({ paused: !ui.streamFilters.paused })
          break
        }
        case 't': st.toggleTheme(); break
        case '?': st.setShortcutsOpen(true); break
        default: return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
