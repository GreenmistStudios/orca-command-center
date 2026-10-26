import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from 'playwright/test'

const VIEWS = ['DAG', 'Timeline', 'Stream', 'Changes', 'Overview'] as const

async function snap(page: Page, project: string, name: string, selector: string) {
  const dir = `test-results/aria-${project}`
  mkdirSync(dir, { recursive: true })
  const yaml = await page.locator(selector).first().ariaSnapshot()
  writeFileSync(`${dir}/${name}.yml`, yaml + '\n')
  return yaml
}

test.describe('console', () => {
  test('loads, is live, and every surface renders', async ({ page }, testInfo) => {
    const project = testInfo.project.name
    const mock = project === 'mock'
    const consoleErrors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

    await page.goto(mock ? '/?mock=1' : '/')

    // Splash disappears → shell visible.
    await expect(page.getByTestId('shell')).toBeVisible()
    await expect(page.getByTestId('stream-pill')).toHaveText(/Live/)

    // Orca pid in header.
    const orca = page.getByTestId('orca-pill')
    if (mock) await expect(orca).toContainText(/Orca/)
    else await expect(orca).toContainText(/Connected to a running Orca \(pid \d+\)/)

    // Rail lists ≥ 1 session.
    const rows = page.getByTestId('rail-root-row')
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeGreaterThanOrEqual(1)

    // DAG renders ≥ 1 node.
    await expect(page.getByTestId('dag-view')).toBeVisible()
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 })

    // Select a session → inspector header + a transcript item.
    await rows.first().click()
    await expect(page.getByTestId('inspector-header')).toBeVisible()
    await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible({ timeout: 30_000 })

    // Every view tab renders without the error boundary.
    for (const name of VIEWS) {
      await page.getByRole('tab', { name: new RegExp(`^(Run )?${name}$`) }).click()
      await expect(page.getByRole('tabpanel', { name: /view$/ })).toBeVisible()
      await expect(page.getByText('This view hit an error')).toHaveCount(0)
      await page.waitForTimeout(400)
      await expect(page.getByText('This view hit an error')).toHaveCount(0)
      await snap(page, project, `view-${name.toLowerCase()}`, '#center-view')
    }

    // Back to the DAG for the standard snapshots.
    await page.getByRole('tab', { name: /^(Run )?DAG$/ }).click()
    await snap(page, project, 'header', 'header')
    await snap(page, project, 'rail', 'nav[aria-label="Fleet"]')
    await snap(page, project, 'view', '#center-view')
    await snap(page, project, 'dock', '[data-testid="dock"]')

    // ⌘K / Ctrl+K opens the palette.
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByTestId('command-palette')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-palette')).toHaveCount(0)

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
