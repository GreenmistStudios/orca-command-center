import { mkdirSync } from 'node:fs'
import { expect, test } from 'playwright/test'

// Live integration: Orca running, Copilot CLI as the agent harness. Runs against this machine's
// real data; asserts the UI agrees with the API for a Copilot root session and saves screenshots
// to test-results/live-copilot/. Skips unless Orca is running and a Copilot root session exists.

const SHOTS = 'test-results/live-copilot'

interface Session { id: string; harness: string; parentId: string | null; title: string }
interface Bootstrap {
  sessions?: Session[]
  orca?: { status?: { running?: boolean; reachable?: boolean; pid?: number | null } }
}

test.describe('live data: Orca + Copilot CLI', () => {
  test('Copilot sessions render with Orca connected', async ({ page, request }) => {
    const boot = (await (await request.get('/api/bootstrap')).json()) as Bootstrap
    const orca = boot.orca?.status
    test.skip(!orca?.running || !orca?.reachable, 'Orca is not running')

    const copilotRoots = (boot.sessions ?? []).filter((s) => s.harness === 'copilot' && !s.parentId)
    test.skip(copilotRoots.length === 0, 'no Copilot CLI root sessions in the window')

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    mkdirSync(SHOTS, { recursive: true })

    await page.goto('/')
    await expect(page.getByTestId('shell')).toBeVisible()

    // Orca is connected, with the pid the API reports.
    await page.getByTestId('status-bubble').hover()
    await expect(page.getByTestId('orca-pill')).toContainText(`pid ${orca!.pid}`)

    // Filter the rail to Copilot CLI: exactly the API's Copilot roots, nothing else.
    // (Filter is persisted in localStorage; each test gets a fresh context.)
    await page.getByTestId('harness-filter').and(page.locator('[data-harness="copilot"]')).click()
    const rows = page.getByTestId('rail-root-row')
    await expect(rows.first()).toBeVisible()
    const shown = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id')))
    expect(new Set(shown)).toEqual(new Set(copilotRoots.map((s) => s.id)))
    await page.screenshot({ path: `${SHOTS}/rail-copilot.png` })

    // Select the first Copilot session: inspector identifies the harness and loads its transcript.
    const id = shown[0]!
    await rows.first().click()
    await expect(page).toHaveURL(new RegExp(`[?&]s=${id}`))
    await expect(page.getByTestId('inspector-header')).toContainText('Copilot CLI')
    const detail = await request.get(`/api/sessions/${encodeURIComponent(id)}`)
    expect(detail.ok()).toBe(true)
    expect(((await detail.json()) as { session: Session }).session.harness).toBe('copilot')
    await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible({ timeout: 30_000 })

    for (const name of ['DAG', 'Timeline', 'Stream', 'Changes', 'Overview']) {
      await page.getByRole('tab', { name: new RegExp(`^(Run )?${name}$`) }).click()
      await expect(page.getByRole('tabpanel', { name: /view$/ })).toBeVisible()
      await expect(page.getByText('This view hit an error')).toHaveCount(0)
      await page.screenshot({ path: `${SHOTS}/session-${name.toLowerCase()}.png` })
    }

    expect(errors, errors.join('\n')).toEqual([])
  })
})
