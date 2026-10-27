import { mkdirSync } from 'node:fs'
import { expect, test } from 'playwright/test'

// Integration test against the real server reading this machine's live data (OpenCode, Copilot,
// Orca). Live data changes constantly, so this asserts that the UI agrees with the server API
// rather than comparing pixels; screenshots are saved to test-results/live/ for manual review.
// Skips when the machine has no sessions in the window (e.g. CI).

const SHOTS = 'test-results/live'

interface Bootstrap { sessions?: Array<{ id: string; parentId?: string | null }> }
interface Meta { sources?: Array<{ id?: string; name?: string; status?: string }> }

test.describe('live data', () => {
  test('UI reflects live server state', async ({ page, request }) => {
    const meta = (await (await request.get('/api/meta')).json()) as Meta
    expect(meta).toBeTruthy()

    const boot = (await (await request.get('/api/bootstrap')).json()) as Bootstrap
    const sessions = boot.sessions ?? []
    test.skip(sessions.length === 0, 'no live sessions on this machine')

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    mkdirSync(SHOTS, { recursive: true })

    await page.goto('/')
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.getByTestId('status-bubble').hover()
    await expect(page.getByTestId('stream-pill')).toContainText(/Live/)

    // Rail shows sessions served by the API.
    const rows = page.getByTestId('rail-root-row')
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeGreaterThanOrEqual(1)
    await page.screenshot({ path: `${SHOTS}/fleet.png` })

    // Selecting a session loads its tree + transcript from the API.
    await rows.first().click()
    await expect(page).toHaveURL(/[?&]s=/)
    const id = new URL(page.url()).searchParams.get('s')!
    const tree = await request.get(`/api/sessions/${encodeURIComponent(id)}/tree`)
    expect(tree.ok()).toBe(true)
    const detail = await request.get(`/api/sessions/${encodeURIComponent(id)}`)
    expect(detail.ok()).toBe(true)

    await expect(page.getByTestId('inspector-header')).toBeVisible()
    await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 })

    for (const name of ['DAG', 'Timeline', 'Stream', 'Changes', 'Overview']) {
      await page.getByRole('tab', { name: new RegExp(`^(Run )?${name}$`) }).click()
      await expect(page.getByRole('tabpanel', { name: /view$/ })).toBeVisible()
      await expect(page.getByText('This view hit an error')).toHaveCount(0)
      await page.screenshot({ path: `${SHOTS}/session-${name.toLowerCase()}.png` })
    }

    // Read-only: mutating methods are rejected.
    const post = await request.post('/api/meta', { data: {} })
    expect(post.status()).toBeGreaterThanOrEqual(400)

    expect(errors, errors.join('\n')).toEqual([])
  })
})
