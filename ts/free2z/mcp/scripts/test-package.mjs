import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const dir = await mkdtemp(join(tmpdir(), "free2z-mcp-package-"));
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
      encoding: "utf8",
    }),
  )[0];
  assert.ok(packed.files.some((file) => file.path === "schema.json"));
  assert.ok(packed.files.some((file) => file.path === "dist/cli.js"));
  assert.ok(
    !packed.files.some((file) =>
      /(?:^|\/)(?:test|src|node_modules)\//.test(file.path),
    ),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--prefix",
      join(dir, "consumer"),
      join(dir, packed.filename),
    ],
    { stdio: "pipe" },
  );
  const cli = join(dir, "consumer/node_modules/@free2z/mcp/dist/cli.js");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("FREE2Z_")),
  );
  const check = JSON.parse(
    execFileSync(process.execPath, [cli, "--check"], {
      env,
      encoding: "utf8",
      cwd: dir,
    }),
  );
  assert.equal(check.authentication, "anonymous");
  assert.ok(check.operations > 0);
  assert.equal(
    execFileSync(process.execPath, [cli, "--version"], {
      env,
      encoding: "utf8",
      cwd: dir,
    }).trim(),
    JSON.parse(await readFile(new URL("../package.json", import.meta.url)))
      .version,
  );
  console.log(
    "Installed tarball runs outside the source checkout without dev dependencies.",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
