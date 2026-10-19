import { defineConfig, devices } from '@playwright/test';

// NIMW_E2E_PORT lets parallel worktrees run their suites side by side.
const PORT = Number(process.env.NIMW_E2E_PORT ?? 4317);

/** Zero-network test of the built UI (M2a §7); run `vite build` first. */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } },
    // WKWebView (macOS) is WebKit: editor interactions are checked there too.
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], browserName: 'webkit' },
      testMatch:
        /\/(checklist|m2b|m2c|m3a|m3a-a11y|m3a-perf|m3b|m4|m4-perf|m4b|m4b2|cover-resize|m4b3-covers|m4b3-wide|m4b3-gv|m4b3-files|m4b3-settings|m4c-scratchpad|m4c-files)\.spec\.ts$/,
    },
  ],
  webServer: {
    command: `node e2e/serve.ts ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
  },
});
