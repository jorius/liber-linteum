import { defineConfig, devices } from '@playwright/test';

const PORT = 4317;

/** Zero-network test of the built UI (M2a §7); run `vite build` first. */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node e2e/serve.ts ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
  },
});
