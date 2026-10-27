import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { renderWithMockStore } from '../../../test/client/render'
import { useGlobalHotkeys } from '../hooks/useGlobalHotkeys'
import { resetOccStore, useOcc } from '../state/store'
import { CommandPalette } from './CommandPalette'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => {}
})
afterEach(() => resetOccStore())

function Harness() {
  useGlobalHotkeys()
  return <><CommandPalette /><input data-testid="inp" /><input id="rail-search" /></>
}
const key = (k: string, init: KeyboardEventInit = {}, target: Element | Document = document.body) => act(() => { fireEvent.keyDown(target, { key: k, ...init }) })

describe('palette', () => {
  it('opens with ⌘K, groups results, runs view and theme actions', async () => {
    renderWithMockStore(<Harness />)
    key('k', { metaKey: true })
    expect(useOcc.getState().ui.paletteOpen).toBe(true)
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument()
    for (const g of ['Live sessions', 'Sessions', 'Workspaces', 'Views', 'Actions']) expect(screen.getByText(g)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('palette-view-timeline'))
    expect(useOcc.getState().ui.view).toBe('timeline')
    expect(useOcc.getState().ui.paletteOpen).toBe(false)
    const before = useOcc.getState().ui.theme
    key('k', { ctrlKey: true })
    await userEvent.click(await screen.findByTestId('palette-action-theme'))
    expect(useOcc.getState().ui.theme).not.toBe(before)
  })

  it('selects a session found by search and shows "No matches"', async () => {
    renderWithMockStore(<Harness />)
    act(() => useOcc.getState().setPaletteOpen(true))
    const input = await screen.findByPlaceholderText(/Search sessions/)
    await userEvent.type(input, 'zzzzqqqq')
    expect(await screen.findByText('No matches')).toBeInTheDocument()
    await userEvent.clear(input)
    const target = Object.values(useOcc.getState().sessions).find((s) => s.parentId == null && s.id !== useOcc.getState().ui.selectedSessionId)!
    await userEvent.type(input, target.id.slice(0, 8))
    await userEvent.click((await screen.findAllByTestId(`palette-session-${target.id}`))[0])
    await waitFor(() => expect(useOcc.getState().ui.selectedSessionId).toBe(target.id))
  })
})

describe('hotkeys', () => {
  it('view keys, toggles, ignore-while-typing, Esc cascade', () => {
    renderWithMockStore(<Harness />)
    key('4'); expect(useOcc.getState().ui.view).toBe('stream')
    key(' '); expect(useOcc.getState().ui.streamFilters.paused).toBe(true)
    key('f'); expect(useOcc.getState().ui.streamFilters.follow).toBe(false)
    key('.'); expect(useOcc.getState().ui.liveOnly).toBe(true)
    const t = useOcc.getState().ui.theme
    key('t'); expect(useOcc.getState().ui.theme).not.toBe(t)
    key('?'); expect(useOcc.getState().ui.shortcutsOpen).toBe(true)
    key('Escape'); expect(useOcc.getState().ui.shortcutsOpen).toBe(false)
    key('/'); expect(document.activeElement?.id).toBe('rail-search')
    key('6', {}, screen.getByTestId('inp')); expect(useOcc.getState().ui.view).toBe('stream')
    key('3'); expect(useOcc.getState().ui.view).toBe('timeline')
    key(' '); expect(useOcc.getState().ui.streamFilters.paused).toBe(true)
    useOcc.getState().selectTask('task-x')
    key('Escape'); expect(useOcc.getState().ui.selectedTaskId).toBeNull(); expect(useOcc.getState().ui.selectedSessionId).not.toBeNull()
    key('Escape'); expect(useOcc.getState().ui.selectedSessionId).toBeNull()
  })

  it('j/k move the root selection', () => {
    renderWithMockStore(<Harness />)
    const a = useOcc.getState().ui.selectedRootId
    key('j')
    expect(useOcc.getState().ui.selectedRootId).not.toBe(a)
    key('k')
    expect(useOcc.getState().ui.selectedRootId).toBe(a)
  })
})
