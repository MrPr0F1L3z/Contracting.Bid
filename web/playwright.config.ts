import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT ?? 3100);
// The template under test follows NEXT_PUBLIC_CB_TEMPLATE: `next start` reads it to pick the build folder.

// End-to-end tests run against the production build, the way a visitor gets it.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'off',
    // Set PW_CHROMIUM_PATH to reuse a Chromium that is already installed.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `pnpm exec next start --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
