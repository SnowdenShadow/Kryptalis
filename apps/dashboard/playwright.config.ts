import { defineConfig, devices } from '@playwright/test';

/**
 * E2E without a backend: every request to the API origin is intercepted by
 * page.route() (see e2e/helpers/api-mock.ts), so only the Next dev server
 * needs to run. `next dev` (not build+start) keeps iteration fast; port 3100
 * avoids clashing with the regular dev server on :3000.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'on-first-retry',
    // The app ships a strict per-request CSP (src/middleware.ts) with no
    // 'unsafe-eval'. `next dev` relies on eval'd source maps and Playwright
    // injects init scripts, both of which that CSP blocks — bypass it in
    // tests (CSP itself is not under test here).
    bypassCSP: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm exec next dev --port 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Baked into the client bundle; requests to this origin are all
      // intercepted by the mock layer anyway.
      NEXT_PUBLIC_API_URL: 'http://localhost:4000',
    },
  },
});
