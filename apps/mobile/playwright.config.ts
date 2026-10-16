import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4180', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { viewport: { width: 360, height: 800 } } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: 'python3 -m http.server 4180 --bind 127.0.0.1 --directory dist', url: 'http://127.0.0.1:4180', reuseExistingServer: !process.env.CI },
});
