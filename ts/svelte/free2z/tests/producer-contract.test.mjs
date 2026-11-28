import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
test("shared producer client contracts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "free2z-producer-"));
  try {
    const file = join(dir, "test.mjs");
    await build({
      entryPoints: ["tests/producer-contract.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: file,
    });
    execFileSync(process.execPath, ["--test", file], {
      stdio: "inherit",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
