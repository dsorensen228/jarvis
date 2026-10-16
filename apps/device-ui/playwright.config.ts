import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  timeout: 20_000,
  expect: { timeout: 5000 },
  use: { baseURL: 'http://127.0.0.1:4178', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'touch-800', use: { browserName: 'chromium', viewport: { width: 800, height: 480 }, hasTouch: true } },
    { name: 'touch-1280', use: { browserName: 'chromium', viewport: { width: 1280, height: 720 }, hasTouch: true } },
  ],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 4178 --strictPort', url: 'http://127.0.0.1:4178', reuseExistingServer: !process.env.CI },
});
