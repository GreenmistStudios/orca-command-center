import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMockStore } from '../../../test/client/render'
import { useCompact } from '../hooks/useCompact'
import { applyUrlSelection, buildUrlSearch, readUrlSelection } from '../state/url'
import { resetOccStore, useOcc } from '../state/store'
import { faviconHref, useAttentionBadge } from './useAppEffects'

afterEach(() => { history.replaceState(null, '', '/'); resetOccStore(); vi.unstubAllGlobals() })

describe('url state', () => {
  it('round-trips and rejects junk', () => {
    const sel = readUrlSelection('?mock=1&s=ses_1&v=stream&r=run_1&t=tsk_1')
    expect(sel).toEqual({ s: 'ses_1', v: 'stream', r: 'run_1', t: 'tsk_1', mock: true })
    expect(readUrlSelection('?v=nope&s=%20')).toMatchObject({ v: null, s: null })
    const ui = { ...useOcc.getState().ui, selectedSessionId: 'ses_1', view: 'stream' as const, selectedRunId: 'run_1', selectedTaskId: 'tsk_1' }
    expect(readUrlSelection(buildUrlSearch(ui, '?mock=1'))).toEqual(sel)
  })
  it('fleet is the default view; deep links default to dag', () => {
    expect(readUrlSelection('?v=fleet').v).toBe('fleet')
    const base = useOcc.getState().ui
    expect(buildUrlSearch({ ...base, view: 'fleet', selectedSessionId: null, selectedRunId: null }, '')).toBe('')
    expect(buildUrlSearch({ ...base, view: 'fleet', selectedSessionId: 'ses_1', selectedRunId: null }, '')).toBe('?s=ses_1&v=fleet')
    expect(buildUrlSearch({ ...base, view: 'dag', selectedSessionId: 'ses_1', selectedRunId: null }, '')).toBe('?s=ses_1')
    expect(buildUrlSearch({ ...base, view: 'dag', selectedSessionId: null, selectedRunId: null }, '')).toBe('?v=dag')
  })
  it('applyUrlSelection restores selection and view', () => {
    renderWithMockStore(<div />)
    const id = Object.values(useOcc.getState().sessions)[3].id
    applyUrlSelection(useOcc, { s: id, v: 'changes', r: null, t: null, mock: false })
    expect(useOcc.getState().ui).toMatchObject({ selectedSessionId: id, view: 'changes' })
    applyUrlSelection(useOcc, { s: 'ghost', v: null, r: null, t: null, mock: false })
    expect(useOcc.getState().ui.selectedSessionId).toBeNull()
  })
})

describe('compact + badge', () => {
  it('useCompact follows matchMedia', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    function P() { return <span data-testid="c">{String(useCompact())}</span> }
    render(<P />)
    expect(screen.getByTestId('c')).toHaveTextContent('true')
  })
  it('title and favicon reflect attention', () => {
    function B() { useAttentionBadge(); return null }
    renderWithMockStore(<B />)
    const n = useOcc.getState().attention.length
    expect(n).toBeGreaterThan(0)
    expect(document.title).toBe(`(${n}) Orca Command Center`)
    const href = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')!.href
    expect(href).toBe(faviconHref(useOcc.getState().attention.some((a) => a.severity === 'high')))
    act(() => useOcc.setState({ attention: [] }))
    expect(document.title).toBe('Orca Command Center')
  })
})
