import { defineConfig, devices } from '@playwright/test';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DASHBOARD_TEST_PORT || 3849;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 1440, height: 900 },
  },

  webServer: {
    command: `DASHBOARD_PORT=${PORT} DASHBOARD_HOST=127.0.0.1 node server.mjs`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
    cwd: __dirname,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
