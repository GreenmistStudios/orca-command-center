import { beforeEach, describe, expect, it } from 'vitest'
import { mockBootstrap } from '../../../test/client/render'
import { MOCK_IDS } from '../api/mock-data'
import {
  selectActivityForScope, selectDescendants, selectFleetPulse, selectRootSessions, selectSelectedSession, selectSessionAncestors, selectWorkspaceGroups,
} from './selectors'
import { resetOccStore, useOcc } from './store'

const st = () => useOcc.getState()

describe('selectors', () => {
  beforeEach(() => {
    resetOccStore()
    st().applyBootstrap(mockBootstrap())
  })

  it('roots are sorted by state priority then recency', () => {
    const roots = selectRootSessions(st())
    expect(roots.map((r) => r.state)).toEqual(['blocked', 'waiting', 'working', 'working', 'done', 'idle'])
    expect(roots[0].id).toBe(MOCK_IDS.blocked)
    expect(roots).toBe(selectRootSessions(st())) // stable reference
  })

  it('applies liveOnly, harness filter and query', () => {
    st().setLiveOnly(true)
    expect(selectRootSessions(st()).every((r) => r.live)).toBe(true)
    expect(selectRootSessions(st())).toHaveLength(4)
    st().setLiveOnly(false)
    st().setHarnessFilter('copilot')
    expect(selectRootSessions(st()).map((r) => r.id)).toEqual([MOCK_IDS.copilot])
    st().setHarnessFilter('all')
    st().setRailQuery('paparazzi')
    expect(selectRootSessions(st())).toHaveLength(1)
  })

  it('groups by workspace', () => {
    const g = selectWorkspaceGroups(st())
    expect(g.map((x) => x.workspace.name).sort()).toEqual(['acme-android', 'insights-agent', 'orca-command-center'])
    const ipm = g.find((x) => x.workspace.name === 'insights-agent')!
    expect(ipm.needsYou).toBe(2)
  })

  it('descendants, ancestors, selected session, pulse', () => {
    const d = selectDescendants(st(), MOCK_IDS.rootBuild)
    expect(d).toHaveLength(6)
    expect(selectSessionAncestors(st(), MOCK_IDS.coderTests).map((a) => a.id)).toEqual([MOCK_IDS.rootBuild])
    st().selectSession(MOCK_IDS.coderTests)
    expect(selectSelectedSession(st())?.id).toBe(MOCK_IDS.coderTests)
    const p = selectFleetPulse(st())
    expect(p.needsYou).toBe(2)
    expect(p.working).toBeGreaterThanOrEqual(4)
    expect(p.total).toBe(Object.keys(st().sessions).length)
  })

  it('activity for scope', () => {
    const ids = selectActivityForScope(st(), { sessionId: MOCK_IDS.coderTests })
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => st().activity.byId[id].sessionId === MOCK_IDS.coderTests)).toBe(true)
    const mcp = selectActivityForScope(st(), { rootId: MOCK_IDS.rootBuild, kinds: ['mcp'] })
    expect(mcp.every((id) => st().activity.byId[id].kind === 'mcp')).toBe(true)
  })
})
