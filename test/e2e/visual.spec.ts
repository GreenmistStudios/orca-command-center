import { expect, test, type Page } from 'playwright/test'

// Pixel screenshot tests of the core surfaces against the deterministic in-browser mock fleet
// (?mock=1, seeded). The browser clock is faked and advanced by fixed amounts so the mock's
// timers, relative ages ("3m ago") and live ticks render identically on every run.
//
// Update baselines: npm run test:visual -- --update-snapshots

const FIXED_NOW = new Date('2026-01-15T12:00:00Z')

async function openMock(page: Page, query = '') {
  await page.clock.install({ time: new Date(FIXED_NOW.getTime() - 60_000) })
  // Freeze time at exactly FIXED_NOW so the mock's live ticks only fire via explicit runFor().
  await page.clock.pauseAt(FIXED_NOW)
  await page.goto(`/?mock=1${query}`)
  // The mock backend is created lazily and reads Date.now(); wait for the UI to bootstrap from it
  // (on real I/O, with fake time frozen) before advancing fake time, so every run starts from
  // the same fake instant.
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('rail-root-row').first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await page.clock.runFor(1_000)
}

async function selectFirstSession(page: Page) {
  await page.getByTestId('rail-root-row').first().click()
  await expect(page.getByTestId('inspector-header')).toBeVisible()
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible()
}

async function showView(page: Page, name: string) {
  await page.getByRole('tab', { name: new RegExp(`^(Run )?${name}$`) }).click()
  await expect(page.getByRole('tabpanel', { name: /view$/ })).toBeVisible()
  // ELK layout and view effects chain timers and promises; advance a fixed total in steps so the
  // async work between timers can settle (one large runFor fires them all in a single batch).
  for (let i = 0; i < 4; i++) await page.clock.runFor(500)
}

async function settle(page: Page) {
  // Let layout (ELK), virtualizers and CSS transitions finish before capture.
  await page.clock.runFor(1_000)
  await page.evaluate(() => document.fonts.ready)
}

test.describe('visual (mock)', () => {
  test.use({ colorScheme: 'dark' })

  test('fleet overview: no selection', async ({ page }) => {
    await openMock(page)
    await settle(page)
    await expect(page).toHaveScreenshot('fleet.png')
  })

  for (const view of ['DAG', 'Timeline', 'Stream', 'Changes', 'Overview']) {
    test(`session selected: ${view} view`, async ({ page }) => {
      await openMock(page)
      await selectFirstSession(page)
      await showView(page, view)
      if (view === 'DAG') await expect(page.locator('.react-flow__node').first()).toBeVisible()
      await settle(page)
      await expect(page).toHaveScreenshot(`session-${view.toLowerCase()}.png`)
    })
  }

  test('command palette', async ({ page }) => {
    await openMock(page)
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByTestId('command-palette')).toBeVisible()
    await settle(page)
    await expect(page).toHaveScreenshot('command-palette.png')
  })

  test('shortcuts help', async ({ page }) => {
    await openMock(page)
    await page.keyboard.press('?')
    await expect(page.getByTestId('shortcuts-dialog')).toBeVisible()
    await settle(page)
    await expect(page).toHaveScreenshot('shortcuts.png')
  })

  test('oversight board', async ({ page }) => {
    await openMock(page)
    await page.getByTestId('oversight-button').click()
    await expect(page.getByTestId('oversight')).toBeVisible()
    await expect(page.getByTestId('oversight-repo').first()).toBeVisible()
    await settle(page)
    await expect(page).toHaveScreenshot('oversight.png')
  })

  test('status bubble', async ({ page }) => {
    await openMock(page)
    await page.getByTestId('status-bubble').hover()
    await expect(page.getByTestId('stream-pill')).toBeVisible()
    await settle(page)
    await expect(page).toHaveScreenshot('status-bubble.png')
  })

  test('degraded sources', async ({ page }) => {
    await openMock(page, '&degraded=1')
    await settle(page)
    await expect(page).toHaveScreenshot('degraded.png')
  })

  test.describe('light theme', () => {
    test.use({ colorScheme: 'light' })

    test('light theme', async ({ page }) => {
      await openMock(page)
      await selectFirstSession(page)
      await settle(page)
      await expect(page).toHaveScreenshot('light-dag.png')
    })
  })
})
