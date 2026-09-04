import { defineConfig } from "@playwright/test";

// A port of its own so an e2e2z run never collides with ZUULI's (1432) or with
// either app's dev server.
const port = Number(process.env.E2E2Z_PW_PORT ?? 1437);

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    channel: process.env.CI ? "chrome" : undefined,
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  // Two servers, because this app has two truthful states and both have to be
  // provable in a real browser: the fixture data layer (`VITE_MOCK=1`), which
  // is the only way to reach the transcript without a running relay, and the
  // default build, where enrollment refuses and the surface must say so rather
  // than hang or throw.
  webServer: [
    {
      command: `npm run dev -- --port ${port}`,
      env: { ...process.env, VITE_MOCK: "1" },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 60_000,
      url: `http://127.0.0.1:${port}`,
    },
    {
      command: `npm run dev -- --port ${port + 1}`,
      env: { ...process.env, VITE_MOCK: "" },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 60_000,
      url: `http://127.0.0.1:${port + 1}`,
    },
  ],
});
