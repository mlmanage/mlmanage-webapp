import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // Live-backend operations can include namespace, storage, queue, image-pull, and pod
  // scheduling work, so they need longer timeouts than isolated browser tests.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['html', { open: 'never' }], ['list']],
  globalTeardown: './tests/global-teardown.ts',
  use: {
    // 3001 is where backend_server.sh serves the app; 3002/3003 are Grafana/Prometheus.
    baseURL: process.env.MLM_APP_URL || 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // For the full browser matrix, prefer a production server. Set MLM_APP_URL to attach
  // Playwright to an existing build; otherwise the development server starts automatically.
  webServer: {
    command: 'npm run dev -- -p 3001',
    url: process.env.MLM_APP_URL || 'http://localhost:3001',
    reuseExistingServer: !process.env.CI,
    env: {
      MLMANAGE_API_URL: process.env.MLMANAGE_API_URL || 'http://localhost:8000',
    },
  },
});
