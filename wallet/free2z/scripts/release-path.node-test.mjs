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
//
// The last one is free2z's own. free2z is the only one of the three apps that
// declares capture permissions, and the workflow asserts that set as a LITERAL
// against the merged manifest inside the built bundle — a string in a YAML file,
// far away from the manifest it is about. Deriving the same literal from the
// committed manifest here is what stops the two from drifting into a release
// that either ships an undeclared permission or fails four jobs deep on a
// comparison nobody updated.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "../..");
const workflowPath = resolve(repoRoot, ".github/workflows/free2z-release.yml");

function inlinedPayloadDigest(workflow) {
  const start = workflow.indexOf("<<'FREE2Z_AAB_PAYLOAD_DIGEST'\n");
  assert.notEqual(start, -1, "the workflow no longer inlines the payload digest helper");
  const body = workflow.slice(start + "<<'FREE2Z_AAB_PAYLOAD_DIGEST'\n".length);
  const end = body.indexOf("\n          FREE2Z_AAB_PAYLOAD_DIGEST\n");
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

test("the release workflow signs only inside free2z's own protected environment", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const environments = [...workflow.matchAll(/^\s*environment: (\S+)$/gm)].map(([, name]) => name);
  assert.deepEqual([...new Set(environments)], ["free2z-app-stores"]);
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
  assert.equal(identity.applicationId, "cash.free2z.free2z");
  assert.equal(identity.identity, `${identity.version}+${identity.build}`);
  assert.equal(identity.tag, `free2z-v${identity.identity}`);
});

// ---------------------------------------------------------------------------
// The push path cannot upload.
//
// `on: push` filtered to release.json means merging a build bump starts a
// release run. That is wanted -- it proves the pipeline works on the exact
// commit that established the identity, which is the one commit the manual
// dispatch will accept. What is NOT wanted is the run finishing the job: every
// iOS prerequisite for free2z exists, so a push arm resolving dry_run=false
// would carry a squash-merge all the way to `xcrun altool --upload-app`, and
// the upload submits free2z's ITSAppUsesNonExemptEncryption answer to Apple --
// a declaration under owner and counsel review in #961/#967 that nobody has
// approved making.
//
// e2e2z is not a precedent: its push arm targets `mobile` and stops in
// `prepare` on the missing Play listing, so an accident stands in for the
// decision. free2z has no such accident, which is why the rule is asserted here
// rather than assumed. Three things have to hold together, so all three are
// checked -- the trigger is the one being reasoned about, the push arm resolves
// to dry_run=true, and dry_run=true actually withholds the store transactions.
// ---------------------------------------------------------------------------

// The `if [[ "$EVENT_NAME" == push ]]` arm of the identity step, comments and
// blank lines removed: what the push event actually resolves to.
function pushArmAssignments(workflow) {
  const opener = '          if [[ "$EVENT_NAME" == push ]]; then\n';
  const start = workflow.indexOf(opener);
  assert.notEqual(start, -1, "the identity step no longer branches on a push event");
  const body = workflow.slice(start + opener.length);
  const end = body.indexOf("\n          else\n");
  assert.notEqual(end, -1, "the push arm of the identity step has no dispatch arm after it");
  return body
    .slice(0, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// Every region the workflow will only execute for a real release. The guard and
// its closing `fi` are matched at their own ten-space indentation, so a `fi`
// closing something nested inside the guard does not end the region early.
function dryRunGuardedRegions(workflow) {
  const opener = '          if [[ "$DRY_RUN" == false ]]; then\n';
  const closer = "\n          fi\n";
  const regions = [];
  for (let from = 0; ; ) {
    const start = workflow.indexOf(opener, from);
    if (start === -1) break;
    const end = workflow.indexOf(closer, start + opener.length);
    assert.notEqual(end, -1, "a DRY_RUN guard is never closed at its own indentation");
    regions.push(workflow.slice(start, end));
    from = end + closer.length;
  }
  assert.equal(regions.length, 2, "expected exactly two guarded regions: Play upload and ASC upload");
  return regions;
}

test("merging a release.json bump starts a run, and only a build-bump run", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  // Asserted so the rule below is known to be about a trigger that still fires
  // on exactly this. A push arm that became unreachable would make the
  // dry_run assertion pass while meaning nothing.
  assert.match(
    workflow,
    /^on:\n {2}push:\n {4}branches: \[main\]\n {4}paths:\n {6}- wallet\/free2z\/release\.json\n {2}workflow_dispatch:$/m,
  );
});

test("the push path builds and signs but never uploads", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const assignments = pushArmAssignments(workflow);
  // TestFlight-only until a Play Console listing exists; the store_records step
  // checks `ios` for a push and the identity step refuses to disagree with it.
  assert.ok(
    assignments.includes("target=ios"),
    `the push path must target ios, got: ${assignments.join(" ")}`,
  );
  // The rule this test exists for. Stated in both directions: the push arm sets
  // dry_run=true, and there is no assignment anywhere in it that could set it
  // false -- an added branch resolving to false fails here even if the line
  // above survives.
  assert.ok(
    assignments.includes("dry_run=true"),
    `the push path must resolve dry_run=true, got: ${assignments.join(" ")}`,
  );
  const dryRunAssignments = assignments.filter((line) => line.startsWith("dry_run="));
  assert.deepEqual(
    dryRunAssignments,
    ["dry_run=true"],
    "the push path must resolve dry_run exactly once, to true",
  );
  // A dispatch that forgot to say is a dispatch that did not decide to publish.
  assert.match(
    workflow,
    /dry_run:\n\s+description: Build, sign, and validate without uploading to either store\n\s+required: true\n\s+default: true\n/,
  );
});

// Whole-line comments removed, so a call site is counted and a sentence about
// one is not. The push-path comment in this very workflow quotes
// `xcrun altool --upload-app` to explain what it is preventing, and a scan over
// raw text would either count that as an unguarded upload or force the file to
// stop explaining itself. Only whole-line comments go: a `#` inside a command
// stays, because that line is still a command.
const withoutCommentLines = (contents) =>
  contents
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

test("dry_run withholds every store transaction", () => {
  const raw = readFileSync(workflowPath, "utf8");
  const workflow = withoutCommentLines(raw);
  const guarded = withoutCommentLines(dryRunGuardedRegions(raw).join("\n"));
  // What makes dry_run=true meaningful. Each command that reaches a store must
  // appear only inside a guarded region -- counted rather than merely found, so
  // a second unguarded call site cannot hide behind a guarded first one.
  for (const transaction of ["xcrun altool --upload-app", "androidpublisher.googleapis.com"]) {
    const total = workflow.split(transaction).length - 1;
    assert.ok(total > 0, `the workflow no longer performs ${transaction}`);
    assert.equal(
      guarded.split(transaction).length - 1,
      total,
      `every ${transaction} call must sit inside an "if [[ \\"$DRY_RUN\\" == false ]]" guard`,
    );
  }
  // The pre-flight that a dry run is still expected to perform. `--validate-app`
  // creates no App Store Connect build record and makes no export-compliance
  // declaration, so it belongs outside the guard; moving it inside would leave a
  // dry run proving nothing about the bundle it just signed.
  assert.ok(
    workflow.includes("xcrun altool --validate-app"),
    "the iOS path must still validate the signed bundle on a dry run",
  );
  assert.ok(
    !guarded.includes("xcrun altool --validate-app"),
    "bundle validation must run on a dry run, so it must not sit inside the DRY_RUN guard",
  );
});

test("the workflow's merged-manifest permission assertion matches the committed manifest", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const manifest = readFileSync(
    resolve(appDir, "src-tauri/gen/android/app/src/main/AndroidManifest.xml"),
    "utf8",
  );
  const declared = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map(
    ([, name]) => name,
  );
  assert.ok(declared.length > 0, "the committed manifest declares no permission to compare");
  // The merged manifest also carries the signature-level self-permission
  // androidx.core injects for its dynamic receivers. It is not a declaration
  // free2z made, so it is appended here rather than expected in the manifest.
  const expected = [...declared, "cash.free2z.free2z.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"]
    .sort()
    .join(",");
  assert.ok(
    workflow.includes(`test "$manifest_permissions" = "${expected}"`),
    `the release workflow must assert the merged permission set ${expected}`,
  );
});
