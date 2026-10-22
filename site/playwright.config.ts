import { defineConfig, devices } from '@playwright/test';

// The showcase site's tests. Run from the repo root:
//   pnpm --filter @liber/desktop exec playwright test -c ../../site/playwright.config.ts
// LIBER_SITE_PORT lets several checkouts run it side by side.
const PORT = Number(process.env.LIBER_SITE_PORT ?? 4327);

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${PORT}/liber-linteum/` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } }],
  webServer: {
    command: `node tests/serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/liber-linteum/`,
    reuseExistingServer: false,
  },
});
