import { expect, test, type Page } from 'playwright/test'

// Pixel screenshot tests of the core surfaces against the deterministic in-browser mock fleet
// (?mock=1, seeded). The browser clock is faked; each test advances it to fixed absolute instants
// (FIXED_NOW + n ms) so the mock's timers, relative ages ("3m ago") and live ticks render
// identically on every run, however long real-time work (chunk loads, ELK) takes.
//
// Update baselines: npm run test:visual -- --update-snapshots

const FIXED_NOW = new Date('2026-01-15T12:00:00Z')
const ELK_CHUNK = /\/elk\.bundled[^/]*\.js(\?|$)/

/** Fake-time target per page: every helper advances to an absolute instant, never "by" an amount. */
const target = new WeakMap<Page, number>()

const fakeNow = (page: Page) => page.evaluate(() => Date.now())

/** Advance fake time to exactly FIXED_NOW + (accumulated target + ms), in steps of ≤ 250 ms. */
async function advance(page: Page, ms: number) {
  const to = (target.get(page) ?? FIXED_NOW.getTime()) + ms
  target.set(page, to)
  for (;;) {
    const left = to - (await fakeNow(page))
    if (left <= 0) break
    await page.clock.runFor(Math.min(250, left))
  }
}

async function openMock(page: Page, query = '') {
  await page.clock.install({ time: new Date(FIXED_NOW.getTime() - 60_000) })
  // Freeze time at exactly FIXED_NOW so the mock's live ticks only fire via explicit advances.
  await page.clock.pauseAt(FIXED_NOW)
  target.set(page, FIXED_NOW.getTime())
  let elkRequested = false
  page.on('request', (r) => { if (ELK_CHUNK.test(r.url())) elkRequested = true })
  const elkLoaded = page.waitForEvent('requestfinished', { predicate: (r) => ELK_CHUNK.test(r.url()), timeout: 60_000 })
  await page.goto(`/?mock=1${query}`)
  // The mock backend is created lazily and reads Date.now(); wait for the UI to bootstrap from it
  // (on real I/O, with fake time frozen) before advancing fake time, so every run starts from
  // the same fake instant.
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('rail-root-row').first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  // The default Fleet view lazy-loads ELK (~1.4 MB), but only once it mounts, which waits on
  // (faked) animation frames. Step fake time a frame at a time until the chunk is requested, then
  // wait for it in REAL time. On a cold cache (fresh build, CI) the load can take seconds; moving
  // fake time meanwhile is what made captures drift past the mock's live ticks.
  for (let i = 0; !elkRequested; i++) {
    expect(i, 'ELK chunk was never requested').toBeLessThan(40)
    await page.clock.runFor(16)
    await page.waitForTimeout(20)
  }
  await elkLoaded
  await advance(page, 1_000)
}

async function selectFirstSession(page: Page) {
  await page.getByTestId('rail-root-row').first().click()
  await expect(page.getByTestId('inspector-header')).toBeVisible()
  await expect(page.locator('[data-testid^="item-"]').first()).toBeVisible()
}

async function waitForLayout(page: Page) {
  // ELK runs its work on short timers. With the fake clock paused those never fire on their own,
  // so nudge fake time 1 ms per poll until no view-level spinner is showing. The ELK chunk is
  // already loaded (see openMock), so this takes a few ms of fake time, and every later advance()
  // lands on its absolute target anyway. Scoped to the empty-state spinner: Stream rows have an
  // unrelated inline "Loading…".
  const busy = page.getByTestId('empty-state').filter({ hasText: /^(Laying out|Loading…)/ })
  await expect.poll(async () => {
    await page.clock.runFor(1)
    return busy.count()
  }, { timeout: 30_000, intervals: [25] }).toBe(0)
  const drift = (await fakeNow(page)) - target.get(page)!
  expect(drift, 'layout should need only a few ms of fake time once ELK is loaded').toBeLessThan(100)
}

async function showView(page: Page, name: string) {
  await page.getByRole('tab', { name: new RegExp(`^(Run )?${name}$`) }).click()
  await expect(page.getByRole('tabpanel', { name: /view$/ })).toBeVisible()
  await waitForLayout(page)
  // View effects (fitView etc.) chain timers and promises; advance in steps so the async work
  // between timers can settle (one large runFor fires them all in a single batch).
  await advance(page, 2_000)
}

async function settle(page: Page) {
  // Let layout (ELK), virtualizers and CSS transitions finish before capture.
  await waitForLayout(page)
  await advance(page, 1_000)
  await waitForLayout(page)
  // Capture at a fixed fake instant, with nothing re-entering layout.
  await advance(page, 250)
  expect(await fakeNow(page)).toBe(target.get(page))
  await expect(page.getByTestId('empty-state').filter({ hasText: /^(Laying out|Loading…)/ })).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
}

test.describe('visual (mock)', () => {
  test.use({ colorScheme: 'dark' })

  test('fleet overview: no selection', async ({ page }) => {
    await openMock(page)
    await settle(page)
    await expect(page.getByTestId('fleet-node-project').first()).toBeVisible()
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
