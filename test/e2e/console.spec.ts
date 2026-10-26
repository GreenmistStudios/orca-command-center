import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from 'playwright/test'

const VIEWS = ['DAG', 'Timeline', 'Stream', 'Changes', 'Overview', 'Tokens'] as const

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

  test('token flow: Tokens view, controls, overlay, usage tab, burn pill', async ({ page }, testInfo) => {
    const project = testInfo.project.name
    const mock = project === 'mock'
    const consoleErrors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
    await page.goto(mock ? '/?mock=1' : '/')
    await expect(page.getByTestId('shell')).toBeVisible()
    await expect(page.getByTestId('rail-root-row').first()).toBeVisible()

    // Header burn pill opens the Tokens view (fleet scope).
    await page.getByTestId('burn-pill').click()
    const view = page.getByTestId('tokens-view')
    await expect(view).toBeVisible()
    await expect(page.getByTestId('tokens-error')).toHaveCount(0)

    // KPI tiles with non-empty values.
    const kpis = page.getByTestId('tokens-kpis')
    await expect(kpis).toBeVisible({ timeout: 30_000 })
    const tiles = kpis.locator('[role="region"]')
    expect(await tiles.count()).toBeGreaterThanOrEqual(4)
    for (const t of await tiles.all()) expect((await t.innerText()).trim().length).toBeGreaterThan(0)
    await expect(kpis.locator('[data-odometer]').first()).toBeVisible()

    // Sankey: ≥ 3 labelled nodes + hidden table summary.
    const flow = page.getByTestId('tokens-flow')
    await expect(flow).toBeVisible()
    await expect.poll(async () => flow.locator('[data-node][aria-label]').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3)
    expect((await page.getByTestId('tokens-flow-summary').textContent())?.trim().length).toBeGreaterThan(0)
    await expect(page.getByTestId('tokens-stream')).toBeVisible()
    await expect(page.getByTestId('tokens-leaderboard')).toBeVisible()

    // Units / Scope / Window controls.
    const bar = page.getByTestId('tokens-scope-bar')
    const radio = (group: string, name: RegExp | string) => bar.getByRole('radiogroup', { name: group }).getByRole('radio', { name })
    await radio('Units', 'Cost').click()
    await expect(radio('Units', 'Cost')).toHaveAttribute('aria-checked', 'true')
    await radio('Units', 'Tokens').click()
    await expect(radio('Units', 'Tokens')).toHaveAttribute('aria-checked', 'true')
    await radio('Window', '1h').click()
    await expect(radio('Window', '1h')).toHaveAttribute('aria-checked', 'true')
    await radio('Scope', /^Fleet/).click()
    await expect(radio('Scope', /^Fleet/)).toHaveAttribute('aria-checked', 'true')
    const sessionScope = radio('Scope', /^Session/)
    if (await sessionScope.isEnabled()) {
      await sessionScope.click()
      await expect(sessionScope).toHaveAttribute('aria-checked', 'true')
    }
    await expect(page.getByText('This view hit an error')).toHaveCount(0)
    await snap(page, project, 'view-tokens', '#center-view')

    // DAG overlay toggle shows / hides edge flow.
    await page.getByRole('tab', { name: /^(Run )?DAG$/ }).click()
    await page.getByTestId('rail-root-row').first().click()
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 })
    const toggle = page.getByTestId('flow-toggle')
    const edgeFlow = page.locator('[data-testid="edge-flow"], [data-testid="edge-flow-static"]')
    await expect(toggle).toBeVisible()
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
    await expect(edgeFlow).toHaveCount(0)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    if (mock && (await page.locator('.react-flow__edge').count()) > 0) await expect.poll(async () => edgeFlow.count(), { timeout: 15_000 }).toBeGreaterThan(0)
    await toggle.click()
    await expect(edgeFlow).toHaveCount(0)

    // Inspector Usage tab renders.
    await page.getByRole('radio', { name: /^Usage/ }).click()
    await expect(page.getByTestId('usage-tab')).toBeVisible()
    await expect(page.getByTestId('usage-kpis').or(page.getByTestId('usage-empty'))).toBeVisible({ timeout: 30_000 })
    if (await page.getByTestId('usage-kpis').count()) await expect(page.getByTestId('calls-table').or(page.getByTestId('usage-empty'))).toBeVisible()
    await snap(page, project, 'inspector-usage', '[data-testid="usage-tab"]')

    // Hotkey 6 opens Tokens.
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('6')
    await expect(page.getByTestId('tokens-view')).toBeVisible()

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('token flow: reduced motion renders static flow and final values', async ({ page }, testInfo) => {
    const mock = testInfo.project.name === 'mock'
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(mock ? '/?mock=1' : '/')
    await expect(page.getByTestId('rail-root-row').first()).toBeVisible()
    await page.getByTestId('rail-root-row').first().click()
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 })
    const toggle = page.getByTestId('flow-toggle')
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await page.waitForTimeout(800)
    // No animated particles; only the static dual-tone strokes.
    await expect(page.locator('[data-testid="edge-flow"]')).toHaveCount(0)
    await expect(page.locator('circle[data-particle]')).toHaveCount(0)
    await expect(page.locator('animateMotion')).toHaveCount(0)

    await page.getByRole('tab', { name: 'Tokens' }).click()
    await expect(page.getByTestId('tokens-kpis')).toBeVisible({ timeout: 30_000 })
    // Counters render their final values immediately (aria-label holds the exact number and text matches).
    const odo = page.getByTestId('tokens-kpis').locator('[data-odometer]').first()
    await expect(odo).toBeVisible()
    expect(((await odo.getAttribute('aria-label')) ?? '').length).toBeGreaterThan(0)
    expect(((await odo.innerText()) ?? '').trim().length).toBeGreaterThan(0)
    await snap(page, testInfo.project.name, 'view-tokens-reduced', '#center-view')
  })

  test('token flow: animation performance probe (mock, 6 s live traffic)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mock', 'deterministic mock traffic only')
    await page.addInitScript(() => {
      const w = window as unknown as { __long: { t: number; d: number }[] }
      w.__long = []
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push({ t: e.startTime, d: e.duration }) }).observe({ entryTypes: ['longtask'] }) } catch { /* unsupported */ }
    })
    await page.goto('/?mock=1&perf=1')
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.getByRole('tab', { name: 'Tokens' }).click()
    await expect(page.getByTestId('tokens-kpis')).toBeVisible({ timeout: 30_000 })
    // Fleet + rolling 15m window → live sliding stream chart + live mock traffic.
    const bar = page.getByTestId('tokens-scope-bar')
    await bar.getByRole('radiogroup', { name: 'Scope' }).getByRole('radio', { name: /^Fleet/ }).click()
    await bar.getByRole('radiogroup', { name: 'Window' }).getByRole('radio', { name: '15m' }).click()
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __occFrameStats?: unknown }).__occFrameStats))).toBe(true)
    const heap = () => page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)
    const h0 = await heap()
    const t0 = await page.evaluate(() => performance.now())
    const fps: number[] = []
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(500)
      fps.push(await page.evaluate(() => (window as unknown as { __occFrameStats: { fps: number } }).__occFrameStats.fps))
    }
    const h1 = await heap()
    const long = await page.evaluate((start) => (window as unknown as { __long: { t: number; d: number }[] }).__long.filter((e) => e.t > start + 1000 - 0 && e.d > 50), t0)
    fps.sort((a, b) => a - b)
    const median = fps[Math.floor(fps.length / 2)]
    const heapMb = (h1 - h0) / 1048576
    const line = `PERF fps median=${median.toFixed(1)} min=${fps[0].toFixed(1)} longtasks>50ms(after 1s)=${long.length} heapDelta=${heapMb.toFixed(1)}MB`
    console.log(line)
    testInfo.annotations.push({ type: 'perf', description: line })
    expect(median, line).toBeGreaterThanOrEqual(45)
    expect(long, line).toEqual([])
    expect(heapMb, line).toBeLessThan(20)
  })
})
