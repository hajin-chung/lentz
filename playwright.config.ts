import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4327',
    viewport: { width: 1360, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx tests/start-server.ts',
    url: 'http://127.0.0.1:4327/api/bootstrap',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
