import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const appPort = process.env.PLAYWRIGHT_CLASSIC_APP_PORT
  ? Number(process.env.PLAYWRIGHT_CLASSIC_APP_PORT)
  : 42000 +
    (parseInt(
      createHash("sha256")
        .update(realpathSync(process.cwd()))
        .digest("hex")
        .slice(0, 6),
      16
    ) %
      15000);
const appOrigin = `http://127.0.0.1:${appPort}`;

if (process.env.PLAYWRIGHT_CLASSIC_PORT_PROBED !== String(appPort)) {
  execFileSync(process.execPath, [
    "-e",
    `
    const server = require("node:net").createServer();
    server.once("error", () => process.exit(1));
    server.listen(Number(process.argv[1]), "127.0.0.1", () => {
      server.close((error) => process.exit(error ? 1 : 0));
    });
  `,
    String(appPort),
  ]);
  process.env.PLAYWRIGHT_CLASSIC_PORT_PROBED = String(appPort);
  process.stderr.write(`classic React browser app port: ${appPort}\n`);
}

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: appOrigin,
    browserName: "chromium",
    viewport: { width: 1280, height: 900 },
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : undefined,
  },
  webServer: {
    command: "node tests/browser/static-server.mjs",
    url: appOrigin,
    env: {
      PORT: String(appPort),
    },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
