// The Android release path proves that signing changed only the signature block
// by digesting every payload member of the unsigned and the signed AAB and
// comparing the two lists with cmp. That comparison can only be exercised by a
// real release, so it shipped broken and stayed broken: the unsigned side read a
// sorted member list and the signed side read raw archive order, which cmp
// reports as a difference on the first line even when every digest is identical
// (issue #751, build 0.1.0+16).
//
// These tests are that missing exercise. They build an AAB, produce a "signed"
// variant that adds META-INF/* and reorders every surviving member without
// touching its content, and require the comparison to pass -- and require it to
// fail the moment a payload byte actually changes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

const helper = new URL("./aab-payload-digest.sh", import.meta.url).pathname;
const workflow = new URL("../../../.github/workflows/zuuli-release.yml", import.meta.url).pathname;
const HEREDOC = "ZUULI_AAB_PAYLOAD_DIGEST";

const MEMBERS = [
  ["BundleConfig.pb", "bundle config bytes"],
  ["BUNDLE-METADATA/com.android.tools.build.libraries/dependencies.pb", "dependency metadata"],
  ["base/manifest/AndroidManifest.xml", "<manifest/>"],
  ["base/res/drawable/icon.png", "icon bytes"],
  ["base/resources.pb", "resource table"],
  ["base/lib/arm64-v8a/libzuuli.so", "arm64-v8a payload"],
  ["base/lib/armeabi-v7a/libzuuli.so", "armeabi-v7a payload"],
  ["base/lib/x86/libzuuli.so", "x86 payload"],
  ["base/lib/x86_64/libzuuli.so", "x86_64 payload"],
];

// jarsigner prepends its signature block and rewrites the central directory; it
// makes no promise about the order of the members it carries over.
const SIGNATURE_BLOCK = [
  ["META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n"],
  ["META-INF/UPLOAD.SF", "Signature-Version: 1.0\n"],
  ["META-INF/UPLOAD.RSA", "pkcs7 fixture bytes"],
];

async function writeMembers(root, members) {
  for (const [name, body] of members) {
    await mkdir(join(root, dirname(name)), { recursive: true });
    await writeFile(join(root, name), body);
  }
}

// `zip` stores members in the order it is handed them, so naming each member
// explicitly is what lets a fixture control archive order independently of
// sorted order.
function zipInOrder(archive, cwd, names) {
  const zipped = spawnSync("zip", ["-q", "-X", archive, ...names], { cwd, encoding: "utf8" });
  assert.equal(zipped.status, 0, zipped.stderr);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zuuli-aab-payload-digest-test-"));
  const tree = join(root, "unsigned");
  await writeMembers(tree, MEMBERS);
  const unsigned = join(root, "unsigned.aab");
  zipInOrder(unsigned, tree, MEMBERS.map(([name]) => name));
  return { root, unsigned };
}

// The signed variant is the whole point: identical payload content, a signature
// block that did not exist before, and a deliberately different member order.
async function signedVariant(root, { mutate } = {}) {
  const tree = join(root, `signed-${Math.random().toString(36).slice(2)}`);
  await writeMembers(tree, MEMBERS);
  await writeMembers(tree, SIGNATURE_BLOCK);
  if (mutate) await writeFile(join(tree, mutate), "tampered payload");
  const archive = `${tree}.aab`;
  const reordered = [...MEMBERS.map(([name]) => name)].reverse();
  zipInOrder(archive, tree, [...SIGNATURE_BLOCK.map(([name]) => name), ...reordered]);
  return archive;
}

function digest(aab, output) {
  return spawnSync(helper, [aab, output], { encoding: "utf8" });
}

async function archiveOrder(aab) {
  const listed = spawnSync("unzip", ["-Z1", aab], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.trimEnd().split("\n");
}

test("the release workflow installs this exact helper", async () => {
  // The credential-bearing android-sign-upload job may not check out the
  // repository, so the workflow carries a copy of this file. If the copy and the
  // tested file ever diverge, everything below stops describing what ships.
  const source = await readFile(workflow, "utf8");
  const document = parseDocument(source);
  const steps = document.getIn(["jobs", "android-sign-upload", "steps"], true).toJSON();
  const install = steps.find((step) => step.name === "Install the shared AAB payload digest helper");
  assert.ok(install, "android-sign-upload must install the shared payload digest helper");
  const lines = install.run.split("\n");
  const start = lines.findIndex((line) => line.includes(`<<'${HEREDOC}'`));
  const end = lines.indexOf(HEREDOC, start + 1);
  assert.ok(start >= 0 && end > start, "the helper heredoc is missing from the install step");
  assert.equal(`${lines.slice(start + 1, end).join("\n")}\n`, await readFile(helper, "utf8"));

  // Both comparison sides must run the installed copy; an inline re-implementation
  // of either one is how the two orders came to disagree in the first place.
  const range = document.getIn(["jobs", "android-sign-upload"], true).range;
  const job = source.slice(range[0], range[2]);
  assert.match(job, /"\$RUNNER_TEMP\/aab-payload-digest\.sh" "\$aab" "\$RUNNER_TEMP\/unsigned-aab-payload\.sha256"/);
  assert.match(job, /"\$RUNNER_TEMP\/aab-payload-digest\.sh" "\$secret_dir\/ZUULI-signed\.aab" "\$RUNNER_TEMP\/signed-aab-payload\.sha256"/);
  const walks = job.split('case "$member" in META-INF/').length - 1;
  assert.equal(walks, 1, "the payload member walk must exist once, in the installed helper");
});

test("signing that only adds META-INF and reorders members compares equal", async (t) => {
  const { root, unsigned } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const signed = await signedVariant(root);

  // Guard the fixture itself: if the two archives happened to agree on order,
  // this test could pass against the very bug it exists to catch.
  const unsignedOrder = await archiveOrder(unsigned);
  const signedOrder = (await archiveOrder(signed)).filter((name) => !name.startsWith("META-INF/"));
  assert.notDeepEqual(signedOrder, unsignedOrder, "the signed fixture must not reuse unsigned archive order");
  assert.deepEqual([...signedOrder].sort(), [...unsignedOrder].sort());

  const unsignedList = join(root, "unsigned-aab-payload.sha256");
  const signedList = join(root, "signed-aab-payload.sha256");
  const unsignedRun = digest(unsigned, unsignedList);
  assert.equal(unsignedRun.status, 0, unsignedRun.stderr);
  const signedRun = digest(signed, signedList);
  assert.equal(signedRun.status, 0, signedRun.stderr);

  // cmp is what the release job runs, so assert on cmp and not on set equality.
  const compared = spawnSync("cmp", [unsignedList, signedList], { encoding: "utf8" });
  assert.equal(compared.status, 0, `${compared.stdout}${compared.stderr}`);

  const list = await readFile(unsignedList, "utf8");
  assert.equal(list.includes("META-INF/"), false, "the signature block must stay out of the payload list");
  assert.equal(list.trimEnd().split("\n").length, MEMBERS.length);
});

test("a changed payload member still fails the comparison", async (t) => {
  const { root, unsigned } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const tampered = await signedVariant(root, { mutate: "base/lib/x86_64/libzuuli.so" });
  const unsignedList = join(root, "unsigned.sha256");
  const tamperedList = join(root, "tampered.sha256");
  assert.equal(digest(unsigned, unsignedList).status, 0);
  assert.equal(digest(tampered, tamperedList).status, 0);
  assert.notEqual(spawnSync("cmp", [unsignedList, tamperedList]).status, 0);
});

test("the helper refuses an unusable bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zuuli-aab-payload-digest-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "out.sha256");
  assert.notEqual(digest(join(root, "absent.aab"), output).status, 0);

  // A bundle carrying nothing but a signature block must not silently produce an
  // empty list that compares equal to another empty list.
  const tree = join(root, "signature-only");
  await writeMembers(tree, SIGNATURE_BLOCK);
  const archive = join(root, "signature-only.aab");
  zipInOrder(archive, tree, SIGNATURE_BLOCK.map(([name]) => name));
  const empty = digest(archive, output);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /no payload members/);
});
