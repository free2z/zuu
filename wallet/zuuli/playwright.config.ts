import { defineConfig } from "@playwright/test";

const port = Number(process.env.ZUULI_PW_PORT ?? 1432);
const billingPort = port + 1;

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
  projects: [
    { name: "demo", testIgnore: "**/account-billing.pw.ts" },
    {
      name: "account-billing",
      testMatch: "**/account-billing.pw.ts",
      use: { baseURL: `http://127.0.0.1:${billingPort}` },
    },
  ],
  webServer: [{
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    env: { ...process.env, VITE_MOCK: "1" },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 30_000,
    url: `http://127.0.0.1:${port}`,
  }, {
    // Exercise the shipping account/API flow separately from the demo. API
    // responses and native opener calls are intercepted by this project's tests.
    // The first server has already built WASM; do not rewrite its watched artifact.
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${billingPort}`,
    env: {
      ...process.env,
      VITE_MOCK: "0",
      VITE_F2Z_API: "",
      VITE_F2Z_PROXY: "https://stage.free2z.cash",
    },
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 30_000,
    url: `http://127.0.0.1:${billingPort}`,
  }],
});
