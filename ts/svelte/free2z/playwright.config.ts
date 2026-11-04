import { defineConfig } from "@playwright/test";

import {
  APP_PORT_ENV,
  MOCK_API_PORT_ENV,
  resolveBrowserPorts,
} from "./tests/browser/ports";
import { resolveBrowserOutputPaths } from "./tests/browser/output";

// The ports are NOT fixed: they default to a pair derived from this worktree's
// path so two agents in two worktrees never collide, and honour
// PLAYWRIGHT_APP_PORT / PLAYWRIGHT_MOCK_API_PORT when set. This call is the one
// place that decides, and it publishes the decision into process.env so the
// worker processes (and therefore the specs) read the same values. See
// tests/browser/ports.ts for why a fixed port cost a reviewer 18 phantom
// failures.
const { appPort, mockApiPort, appOrigin, mockApiOrigin, source } =
  resolveBrowserPorts();
const browserOutput = resolveBrowserOutputPaths();

// One line, on stderr, once per run: when a spec does fail, the log says which
// ports it was talking to and whether they were derived or asked for. Skipped
// for `inherited`, which is this same config being re-loaded by each of
// Playwright's worker processes -- one line per worker is noise, not signal.
if (source !== "inherited") {
  process.stderr.write(
    `playwright ports: app ${appPort}, mock-api ${mockApiPort} (${source}; ` +
      `override with ${APP_PORT_ENV}/${MOCK_API_PORT_ENV})\n`,
  );
}

if (browserOutput.source === "local") {
  process.stderr.write(
    `playwright output: ${browserOutput.outputDir} ` +
      `(concurrent local runs use separate directories)\n`,
  );
}

// The suite includes source-module harness tests that intentionally import
// /src/... through Vite, so it must run against the dev server. A production
// preview does not expose those source modules and makes those tests fail
// before they exercise the application. `--strictPort` keeps Vite from
// wandering to another port behind our back: the specs are told this one, so a
// silent move is a suite that tests nothing reachable.
const appServerCommand = `npm run dev -- --host 127.0.0.1 --port ${appPort} --strictPort`;

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: browserOutput.outputDir,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Stays at 1: the specs share ONE mock-API server within this process tree.
  // That is unaffected by the per-worktree ports above, which are about two
  // process trees not sharing one server.
  workers: 1,
  reporter: process.env.CI
    ? [
        ["list"],
        ["github"],
        ["html", { open: "never", outputFolder: browserOutput.reportDir }],
        ["./tests/browser/first-failure-artifacts-reporter.mjs"],
      ]
    : [["list"], ["./tests/browser/local-output-cleanup-reporter.ts"]],
  use: {
    baseURL: appOrigin,
    browserName: "chromium",
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/browser/mock-api.mjs",
      url: `${mockApiOrigin}/healthz`,
      env: {
        MOCK_API_PORT: String(mockApiPort),
        MOCK_TRUSTED_APP_ORIGIN: appOrigin,
      },
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: appServerCommand,
      url: `${appOrigin}/healthz`,
      env: {
        PRIVATE_API_BASE_URL: mockApiOrigin,
        PRIVATE_BACKEND_TRUSTED_ORIGINS: appOrigin,
        VITE_API_PROXY_TARGET: mockApiOrigin,
        PUBLIC_API_BASE_URL: "",
        PUBLIC_STRIPE_CHECKOUT_ENABLED: "true",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
