import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { Shell } from '../../src/client/shell/Shell'
import { ViewTabs, VIEW_ORDER } from '../../src/client/shell/ViewTabs'
import { CenterView } from '../../src/client/shell/CenterView'
import { useGlobalHotkeys } from '../../src/client/hooks/useGlobalHotkeys'
import { applyUrlSelection, buildUrlSearch, readUrlSelection } from '../../src/client/state/url'
import { resetOccStore, useOcc } from '../../src/client/state/store'
import { resetMockBackend } from '../../src/client/api/mock'
import { renderWithMockStore } from './render'

afterEach(() => { history.replaceState(null, '', '/'); resetMockBackend(); resetOccStore() })

function Hotkeys() { useGlobalHotkeys(); return null }

describe('Tokens view registration', () => {
  it('is the 6th tab and selecting it renders the placeholder', async () => {
    expect(VIEW_ORDER).toEqual(['dag', 'timeline', 'stream', 'changes', 'overview', 'tokens'])
    renderWithMockStore(<><ViewTabs /><CenterView /></>)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(6)
    expect(tabs[5]).toHaveTextContent('Tokens')
    await userEvent.click(screen.getByRole('tab', { name: /Tokens/ }))
    expect(useOcc.getState().ui.view).toBe('tokens')
    expect(await screen.findByText('Tokens view — Task-24')).toBeInTheDocument()
  })

  it('hotkey 6 switches to the Tokens view', async () => {
    renderWithMockStore(<Hotkeys />)
    await userEvent.keyboard('6')
    expect(useOcc.getState().ui.view).toBe('tokens')
    await userEvent.keyboard('1')
    expect(useOcc.getState().ui.view).toBe('dag')
  })

  it('URL v=tokens round-trips', () => {
    expect(readUrlSelection('?v=tokens').v).toBe('tokens')
    renderWithMockStore(<Hotkeys />)
    act(() => useOcc.getState().setView('tokens'))
    expect(buildUrlSearch(useOcc.getState().ui, '')).toContain('v=tokens')
    act(() => applyUrlSelection(useOcc, readUrlSelection('?v=tokens')))
    expect(useOcc.getState().ui.view).toBe('tokens')
  })

  it('the shell renders the Tokens view when v=tokens', async () => {
    renderWithMockStore(<Shell />, { uiState: { view: 'tokens' } })
    expect(await screen.findByText('Tokens view — Task-24')).toBeInTheDocument()
  })
})
