import { defineConfig } from 'playwright/test'

// Uses the installed Google Chrome (no browser download). Both projects load the SPA served by the
// real server on :4280 (read-only against this machine's data); `mock` adds ?mock=1 so the client
// uses its deterministic in-browser backend instead.
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '*.spec.ts',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4280',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'node bin/occ.mjs --no-open --port 4280',
    url: 'http://127.0.0.1:4280/api/meta',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'real', metadata: { mock: false } },
    { name: 'mock', metadata: { mock: true } },
  ],
})
