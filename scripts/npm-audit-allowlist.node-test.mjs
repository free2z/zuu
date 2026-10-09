import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { allowlistForScope, evaluate, ALLOWLIST } from "./npm-audit-allowlist.mjs";

const SCRIPT = new URL("./npm-audit-allowlist.mjs", import.meta.url);

const BR = "GHSA-vfj7-8cjw-p6xm";
const adv = (name, id, severity = "high") => ({ name, severity, title: "t", url: `https://github.com/advisories/${id}` });
const report = (...vias) => ({ vulnerabilities: { braces: { severity: "high", via: vias }, micromatch: { severity: "high", via: ["braces"] } } });
const before = new Date("2026-10-05T00:00:00Z");

test("braces advisory waived while live", () => {
  const r = evaluate(report(adv("braces", BR)), ALLOWLIST, before);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.waived, [BR]);
});
test("any other high advisory fails", () => {
  const r = evaluate(report(adv("braces", BR), adv("lodash", "GHSA-aaaa-bbbb-cccc")), ALLOWLIST, before);
  assert.equal(r.problems.length, 1);
});
test("same id on a different package is not waived", () => {
  assert.equal(evaluate(report(adv("evil", BR)), ALLOWLIST, before).problems.length, 1);
});
test("critical severity of another advisory fails; moderate ignored", () => {
  assert.equal(evaluate(report(adv("x", "GHSA-aaaa-bbbb-cccc", "critical")), ALLOWLIST, before).problems.length, 1);
  assert.equal(evaluate(report(adv("x", "GHSA-aaaa-bbbb-cccc", "moderate")), ALLOWLIST, before).problems.length, 0);
});
test("expired entry fails even if advisory present", () => {
  const r = evaluate(report(adv("braces", BR)), ALLOWLIST.filter((entry) => !entry.scope), new Date("2026-11-04T00:00:00Z"));
  assert.ok(r.problems.some((p) => /EXPIRED/.test(p)));
  assert.ok(r.problems.some((p) => /braces/.test(p)));
});
test("expired entry fails even with a clean report", () => {
  const r = evaluate({ vulnerabilities: {} }, ALLOWLIST.filter((entry) => !entry.scope), new Date("2026-11-04T00:00:00Z"));
  assert.ok(r.problems.some((p) => /EXPIRED/.test(p)));
});
test("malformed report is not a pass", () => {
  assert.ok(evaluate({}, ALLOWLIST, before).unparseable);
});
test("a high devalue advisory fails whether npm marks it dev or production", () => {
  for (const isDev of [true, false]) {
    const result = evaluate({
      vulnerabilities: {
        devalue: { name: "devalue", severity: "high", isDirect: false, isDev, via: [adv("devalue", "GHSA-j22f-vq7h-c4qm")] },
      },
    }, allowlistForScope("ts/svelte/free2z"), before);
    assert.ok(result.problems.some((problem) => /devalue/.test(problem)), JSON.stringify(result));
  }
});
test("empty Svelte baseline and unknown roots cannot inherit wallet exceptions", () => {
  assert.deepEqual(allowlistForScope("ts/svelte/free2z", ALLOWLIST.filter((entry) => entry.scope === "ts/svelte/free2z")), []);
  assert.deepEqual(allowlistForScope("unknown/root"), []);
  const svelte = evaluate(report(adv("braces", BR)), allowlistForScope("ts/svelte/free2z"), before);
  assert.match(svelte.problems.join("\n"), /braces/);
});
test("a package-scoped baseline cannot inherit another root's reasons", () => {
  const scoped = allowlistForScope("ts/svelte/free2z");
  assert.deepEqual(scoped, []);
  assert.deepEqual(allowlistForScope("wallet/zuuli").map((entry) => entry.id), [
    "GHSA-vfj7-8cjw-p6xm",
    "GHSA-5gmw-xhrv-c9v3",
    "GHSA-85c8-ppgw-ccpr",
    "GHSA-68fv-2mgg-jv7q",
  ]);
});
test("npm audit rejects vulnerable devalue in prod and dev fixtures under production omit-dev config", { timeout: 120_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-audit-devalue-test-"));
  try {
    for (const dependencyType of ["prod", "dev"]) {
      const packageDir = path.join(root, dependencyType);
      fs.mkdirSync(packageDir);
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: `devalue-${dependencyType}-fixture`, version: "1.0.0" }));
      const installArgs = ["install", "--package-lock-only", "--ignore-scripts", "--save-exact", `devalue@5.3.1`, dependencyType === "dev" ? "--save-dev" : "--save-prod"];
      const install = spawnSync("npm", installArgs, {
        cwd: packageDir,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "", npm_config_omit: "" },
      });
      assert.equal(install.status, 0, `${dependencyType} fixture install failed:\n${install.stderr}`);

      const audit = spawnSync(process.execPath, [SCRIPT.pathname, packageDir], {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production", npm_config_omit: "dev" },
      });
      assert.equal(audit.status, 1, `${dependencyType} devalue fixture unexpectedly passed:\n${audit.stdout}\n${audit.stderr}`);
      assert.match(`${audit.stdout}\n${audit.stderr}`, /devalue/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("npm audit network errors and unexpected exits fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-audit-allowlist-test-"));
  try {
    const bin = path.join(root, "bin");
    const packageDir = path.join(root, "package");
    fs.mkdirSync(bin);
    fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "package-lock.json"), "{}");
    const npm = path.join(bin, "npm");
    const check = (body, exitCode) => {
      fs.writeFileSync(npm, `#!/bin/sh\nfor required in --include=prod --include=dev --include=optional --include=peer; do\n  found=0\n  for arg in "$@"; do [ "$arg" = "$required" ] && found=1; done\n  [ "$found" -eq 1 ] || exit 9\ndone\nprintf '%s\\n' '${body}'\nexit ${exitCode}\n`);
      fs.chmodSync(npm, 0o755);
      return spawnSync(process.execPath, [SCRIPT.pathname, packageDir], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      });
    };
    const networkFailure = check('{"error":{"code":"ENOAUDIT"}}', 1);
    assert.equal(networkFailure.status, 2);
    assert.match(networkFailure.stderr, /npm audit error/);
    const unexpectedExit = check('{"vulnerabilities":{}}', 2);
    assert.equal(unexpectedExit.status, 2);
    assert.match(unexpectedExit.stderr, /exited unexpectedly/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("allowlist is exact and expiring per package root", () => {
  assert.deepEqual(
    ALLOWLIST.filter((e) => !e.scope).map((e) => [e.id, e.package, e.issue.split("/").pop()]),
    [
      ["GHSA-vfj7-8cjw-p6xm", "braces", "1130"],
      ["GHSA-5gmw-xhrv-c9v3", "tinypool", "1173"],
      ["GHSA-85c8-ppgw-ccpr", "tinypool", "1174"],
      ["GHSA-68fv-2mgg-jv7q", "source-map-js", "1176"],
    ],
  );
  for (const e of ALLOWLIST.filter((entry) => !entry.scope)) assert.match(e.expires, /^2026-11-0[34]$/);
  assert.deepEqual(allowlistForScope("ts/svelte/free2z"), []);
});
