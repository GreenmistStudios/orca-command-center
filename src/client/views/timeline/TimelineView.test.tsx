import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { MOCK_IDS } from '../../api/mock'
import { useOcc } from '../../state/store'
import { renderWithMockStore } from '../../../../test/client/render'
import { TimelineView } from './TimelineView'

beforeEach(() => { document.body.innerHTML = '' })

describe('TimelineView', () => {
  it('shows an empty state without a selection', () => {
    renderWithMockStore(<TimelineView />, { bootstrap: null })
    expect(screen.getByText(/Select a session/)).toBeTruthy()
  })

  it('renders a lane per session of the mock tree and selects an activity on click', async () => {
    renderWithMockStore(<TimelineView />)
    useOcc.getState().selectSession(MOCK_IDS.rootBuild)
    await waitFor(() => expect(screen.getAllByTestId('timeline-block').length).toBeGreaterThan(0), { timeout: 4000 })
    const expected = Object.values(useOcc.getState().sessions).filter((s) => s.rootId === MOCK_IDS.rootBuild).length
    expect(expected).toBeGreaterThan(3)
    expect(screen.getAllByTestId('timeline-lane')).toHaveLength(expected)
    const block = screen.getAllByTestId('timeline-block')[0]
    fireEvent.click(block)
    expect(useOcc.getState().ui.selectedActivityId).toBe(block.getAttribute('data-activity-id'))
  })

  it('clicking a lane label selects that session', async () => {
    renderWithMockStore(<TimelineView />)
    useOcc.getState().selectSession(MOCK_IDS.rootBuild)
    await waitFor(() => expect(screen.getAllByTestId('timeline-lane').length).toBeGreaterThan(1))
    fireEvent.click(screen.getAllByTestId('timeline-lane')[1].querySelector('button')!)
    expect(useOcc.getState().ui.selectedSessionId).not.toBe(MOCK_IDS.rootBuild)
  })

  it('switches range presets', async () => {
    renderWithMockStore(<TimelineView />)
    useOcc.getState().selectSession(MOCK_IDS.rootBuild)
    await waitFor(() => expect(screen.getAllByTestId('timeline-lane').length).toBeGreaterThan(1))
    fireEvent.click(screen.getByRole('radio', { name: '5m' }))
    expect(screen.getByRole('radio', { name: '5m' }).getAttribute('aria-checked')).toBe('true')
  })
})
