import { defineConfig } from 'playwright/test'

// All projects load the SPA served by the real server on :4280 (read-only against this machine's
// data).
//  - real / mock: smoke e2e (console.spec.ts) on installed Chrome; `mock` adds ?mock=1 so the
//    client uses its deterministic in-browser backend.
//  - visual:      pixel screenshot tests against the mock backend (visual.spec.ts). Uses
//    Playwright's bundled Chromium (`npx playwright install chromium`) so pixels are stable;
//    baselines are per-platform under test/e2e/__screenshots__/<platform>/.
//  - live:        integration test against live local data (live.spec.ts); skips when empty.
export default defineConfig({
  testDir: './test/e2e',
  outputDir: './test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4280',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'node bin/occ.mjs --no-open --port 4280',
    url: 'http://127.0.0.1:4280/api/meta',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'real', testMatch: 'console.spec.ts', metadata: { mock: false } },
    { name: 'mock', testMatch: 'console.spec.ts', metadata: { mock: true } },
    {
      name: 'visual',
      testMatch: 'visual.spec.ts',
      use: { channel: undefined, browserName: 'chromium', deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC' },
    },
    { name: 'live', testMatch: 'live.spec.ts' },
  ],
})
