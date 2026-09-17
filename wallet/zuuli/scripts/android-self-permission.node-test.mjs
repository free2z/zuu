// The protected Android signer re-checks androidx.core's injected
// DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION against the manifest bundletool
// decodes from the AAB. That check compared bundletool's compiled rendering,
// android:protectionLevel="0x00000002", to the source string "signature", so it
// rejected the correct bundles of 0.1.0+22 and 0.1.0+23 and nothing exercised it
// before a protected release did (issue #1016).
//
// The bundletool-*.xml fixtures are real `bundletool-all-1.18.3.jar dump
// manifest` output: each was compiled with aapt2 --proto-format against
// android-36, built into an AAB with `bundletool build-bundle`, and dumped with
// the pinned verifier. bundletool-signature.xml renders the self-permission
// byte-for-byte as the build 22 dump quoted in #1016 does. agp-merged-*.xml are
// the source-XML shape AGP's merged manifest has, which the packaging gate
// checks with the same script.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

const checker = new URL("./android-self-permission.sh", import.meta.url).pathname;
const fixtures = new URL("./fixtures/android-self-permission/", import.meta.url).pathname;
const releaseWorkflow = new URL("../../../.github/workflows/zuuli-release.yml", import.meta.url).pathname;
const packagingWorkflow = new URL("../../../.github/workflows/zuuli-packaging.yml", import.meta.url).pathname;
const HEREDOC = "ZUULI_ANDROID_SELF_PERMISSION";
const APP = "cash.free2z.zuuli";
const SELF = `${APP}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`;

function check(fixture, applicationId = APP) {
  return spawnSync(checker, [applicationId, `${fixtures}${fixture}`], { encoding: "utf8" });
}

test("the fixture is the rendering the protected signer actually sees", async () => {
  const dump = await readFile(`${fixtures}bundletool-signature.xml`, "utf8");
  assert.ok(
    dump.includes(`<permission android:name="${SELF}" android:protectionLevel="0x00000002"/>`),
    "bundletool 1.18.3 renders signature as 0x00000002; the positive fixture must too",
  );
  assert.equal(dump.includes('protectionLevel="signature"'), false);
});

test("signature-level is accepted in both renderings", () => {
  for (const fixture of ["bundletool-signature.xml", "agp-merged-signature.xml"]) {
    const run = check(fixture);
    assert.equal(run.status, 0, `${fixture}: ${run.stderr}`);
    assert.match(run.stdout, /signature, no flags/);
  }
});

test("any other base level fails with a decoded diagnostic", () => {
  for (const [fixture, rendered, base] of [
    ["bundletool-normal.xml", "0x00000000", "normal"],
    ["bundletool-dangerous.xml", "0x00000001", "dangerous"],
    ["bundletool-signature-or-system.xml", "0x00000003", "signatureOrSystem"],
  ]) {
    const run = check(fixture);
    assert.equal(run.status, 1, fixture);
    assert.match(run.stderr, /is not exactly signature-level/);
    assert.ok(run.stderr.includes(`actual:   ${rendered} = base ${base}, flags 0x00000000`), run.stderr);
  }
});

test("signature with any extra flag fails", () => {
  for (const [fixture, rendered, flags] of [
    ["bundletool-signature-privileged.xml", "0x00000012", "0x00000010"],
    ["bundletool-signature-development.xml", "0x00000022", "0x00000020"],
    ["bundletool-signature-known-signer.xml", "0x08000002", "0x08000000"],
  ]) {
    const run = check(fixture);
    assert.equal(run.status, 1, fixture);
    assert.ok(run.stderr.includes(`actual:   ${rendered} = base signature, flags ${flags}`), run.stderr);
  }
  const source = check("agp-merged-signature-privileged.xml");
  assert.equal(source.status, 1);
  assert.match(source.stderr, /unrecognized android:protectionLevel rendering/);
  assert.match(source.stderr, /actual: {3}signature\|privileged/);
});

test("a missing protection level fails, because Android reads it as normal", () => {
  const run = check("bundletool-protection-level-absent.xml");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /has no android:protectionLevel, which Android reads as normal/);
});

test("the declared <permission> set must be exactly the app's own", () => {
  const absent = check("bundletool-self-permission-absent.xml");
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /actual: {3}<none> \(0 <permission> element\(s\)\)/);

  const duplicate = check("bundletool-duplicate-self-permission.xml");
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /\(2 <permission> element\(s\)\)/);
  assert.match(duplicate.stderr, /protectionLevel="0x00000000"/);

  const extra = check("bundletool-extra-permission.xml");
  assert.equal(extra.status, 1);
  assert.ok(extra.stderr.includes(`actual:   ${SELF},com.evil.OTHER (2 <permission> element(s))`), extra.stderr);

  // A correct manifest for some other application is still the wrong one.
  const foreign = check("bundletool-signature.xml", "cash.free2z.free2z");
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /expected: cash\.free2z\.free2z\.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION/);
});

test("the checker refuses unusable input", () => {
  assert.equal(check("does-not-exist.xml").status, 1);
  assert.equal(spawnSync(checker, [APP], { encoding: "utf8" }).status, 2);
});

test("the release workflow installs and runs this exact checker", async () => {
  // android-sign-upload may not check out the repository, so the workflow
  // carries a copy of this file. If the copy and the tested file diverge,
  // everything above stops describing what ships.
  const source = await readFile(releaseWorkflow, "utf8");
  const document = parseDocument(source);
  const steps = document.getIn(["jobs", "android-sign-upload", "steps"], true).toJSON();
  const installAt = steps.findIndex((step) => step.name === "Install the shared Android self-permission checker");
  assert.ok(installAt >= 0, "android-sign-upload must install the shared self-permission checker");
  const lines = steps[installAt].run.split("\n");
  const start = lines.findIndex((line) => line.includes(`<<'${HEREDOC}'`));
  const end = lines.indexOf(HEREDOC, start + 1);
  assert.ok(start >= 0 && end > start, "the checker heredoc is missing from the install step");
  assert.equal(`${lines.slice(start + 1, end).join("\n")}\n`, await readFile(checker, "utf8"));

  const inspectAt = steps.findIndex((step) => step.name === "Inspect attested Android artifact without credentials");
  const signAt = steps.findIndex((step) => step.name?.startsWith("Materialize, sign"));
  assert.ok(installAt < inspectAt && inspectAt < signAt, "the checker must run before any credential exists");
  const inspect = steps[inspectAt].run;
  assert.ok(
    inspect.includes(`"$RUNNER_TEMP/android-self-permission.sh" ${APP} "$RUNNER_TEMP/aab-manifest-dump.xml"`),
    "the inspection must run the installed checker on the bundletool dump",
  );
  // The source-string comparison that broke #1016 must not come back inline.
  assert.equal(inspect.includes("protectionLevel=\"signature\""), false);
});

test("the packaging gate runs the same checker on AGP's merged manifest", async () => {
  const source = await readFile(packagingWorkflow, "utf8");
  assert.ok(source.includes(`scripts/android-self-permission.sh ${APP} "$manifest"`));
  assert.equal(source.includes("grep -qF 'android:protectionLevel=\"signature\"'"), false);
});
