import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePaths = ["src/lib/api/mock-data.ts", "src/lib/wallet/mock.ts"];
const emailPattern = /[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/gi;
const reservedEmailDomains = new Set(["example.com", "example.net", "example.org"]);

test("the primary app fixture uses an explicitly fictional editorial identity", async () => {
  const source = await readFile(resolve(root, fixturePaths[0]), "utf8");
  for (const contract of [
    'username: "demo-creator"',
    'email: "demo.creator@example.com"',
    'free2zaddr: "demo-creator"',
    'display_name: "Demo Creator"',
  ]) {
    assert.ok(source.includes(contract), `app fixture is missing its fictional identity contract: ${contract}`);
  }
});

test("app fixture sources allow only reserved example-domain emails", async () => {
  const violations = [];
  for (const fixturePath of fixturePaths) {
    const source = await readFile(resolve(root, fixturePath), "utf8");
    for (const match of source.matchAll(emailPattern)) {
      const domain = match[1].toLowerCase();
      if (!reservedEmailDomains.has(domain)) violations.push(`${fixturePath}: non-example email domain`);
    }
  }
  assert.deepEqual(violations, []);
});
