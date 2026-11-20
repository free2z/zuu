import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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
  const registry = join(dir, "accounts.json");
  await writeFile(
    registry,
    JSON.stringify({
      accounts: {
        team: {
          username: "example-team",
          token_file: join(dir, "not-opened.token"),
        },
      },
    }),
    { mode: 0o600 },
  );
  const profileEnv = { ...env, FREE2Z_ACCOUNTS_FILE: registry };
  const profileCheck = JSON.parse(
    execFileSync(process.execPath, [cli, "--check"], {
      env: profileEnv,
      encoding: "utf8",
      cwd: dir,
    }),
  );
  assert.equal(profileCheck.authentication, "profiles");
  assert.ok(!JSON.stringify(profileCheck).includes(dir));
  const client = new Client({ name: "packed-consumer", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli],
        cwd: dir,
        env: profileEnv,
      }),
    );
    const result = await client.callTool({
      name: "free2z_list_accounts",
      arguments: {},
    });
    assert.equal(result.isError, false);
    assert.equal(
      JSON.parse(result.content[0].text).accounts[0].username,
      "example-team",
    );
    assert.ok(!JSON.stringify(result).includes(dir));
    const hidden = await client.callTool({
      name: "free2z_search_operations",
      arguments: { query: "account_data_export" },
    });
    assert.equal(JSON.parse(hidden.content[0].text).total, 0);
    const denied = await client.callTool({
      name: "free2z_describe_operation",
      arguments: { operation_id: "account_data_export_latest" },
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
  }
  console.log(
    "Installed tarball runs outside the source checkout without dev dependencies.",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
