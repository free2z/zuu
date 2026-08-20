import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const test = "src/lib/api/social-providers.live.test.ts";
const result = spawnSync(process.execPath, [vitest, "run", test], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, ZUULI_VERIFY_LIVE_SOCIAL_START: "1" },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
