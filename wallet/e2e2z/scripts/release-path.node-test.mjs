// The release path's own contracts, run by `npm test` so they are gated on
// every pull request that touches this app.
//
// The interesting one is the first. The protected Android signing job may not
// check the repository out — holding the keystore and the source on one runner
// is the boundary the whole pipeline exists to keep — so it cannot invoke
// `scripts/aab-payload-digest.sh` from the tree. The workflow therefore carries
// a verbatim copy in a heredoc, and a copy nobody compares is a copy that
// drifts. ZUULI paid for that lesson at 0.1.0+16 (issue #751), where the two
// sides of a payload comparison disagreed about member ordering and the release
// failed after signing.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "../..");
const workflowPath = resolve(repoRoot, ".github/workflows/e2e2z-release.yml");

function inlinedPayloadDigest(workflow) {
  const start = workflow.indexOf("<<'E2E2Z_AAB_PAYLOAD_DIGEST'\n");
  assert.notEqual(start, -1, "the workflow no longer inlines the payload digest helper");
  const body = workflow.slice(start + "<<'E2E2Z_AAB_PAYLOAD_DIGEST'\n".length);
  const end = body.indexOf("\n          E2E2Z_AAB_PAYLOAD_DIGEST\n");
  assert.notEqual(end, -1, "the inlined payload digest helper has no terminator");
  const lines = body.slice(0, end).split("\n");
  // The heredoc is not quoted-indented (`<<-` only strips tabs), so the ten
  // spaces of YAML indentation are part of every line and must come off here
  // rather than being tolerated as a difference.
  return `${lines
    .map((line) => {
      if (line.length === 0) return line;
      assert.ok(line.startsWith("          "), `unindented heredoc line: ${JSON.stringify(line)}`);
      return line.slice(10);
    })
    .join("\n")}\n`;
}

test("the workflow's inlined AAB payload digest helper matches the tested file", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const tracked = readFileSync(resolve(appDir, "scripts/aab-payload-digest.sh"), "utf8");
  assert.equal(inlinedPayloadDigest(workflow), tracked);
});

test("the release workflow signs only inside e2e2z's own protected environment", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const environments = [...workflow.matchAll(/^\s*environment: (\S+)$/gm)].map(([, name]) => name);
  assert.deepEqual([...new Set(environments)], ["e2e2z-app-stores"]);
  // Three protected jobs: Android sign/upload, iOS sign, iOS upload. A fourth
  // would mean a new job gained access to signing material.
  assert.equal(environments.length, 3);
});

test("store-identity self-test passes", () => {
  execFileSync("node", ["scripts/store-identity.mjs", "--self-test"], { cwd: appDir });
});

test("the generated iOS project is canonical", () => {
  execFileSync("node", ["scripts/normalize-generated-ios-project.mjs", "--self-test"], {
    cwd: appDir,
  });
});

test("release identity agrees across every file that restates it", () => {
  const output = execFileSync("node", ["scripts/release-identity.mjs"], {
    cwd: appDir,
    encoding: "utf8",
  });
  const identity = JSON.parse(output);
  assert.equal(identity.applicationId, "cash.free2z.e2e2z");
  assert.equal(identity.identity, `${identity.version}+${identity.build}`);
  assert.equal(identity.tag, `e2e2z-v${identity.identity}`);
});
