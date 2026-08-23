import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";

import {
  credentialJobDigests,
  releaseAuthorityDigests,
  verifyAppleCredentialBoundary,
} from "./apple-credential-boundary.mjs";

const buildJob = (name, command) => {
  const checksumMembers = name === "ios-build"
    ? "ZUULI.xcarchive.zip ExportOptions.plist source-record.json"
    : "ZUULI.app.zip ZUULI-layout.dmg source-record.json";
  return `  ${name}:
    steps:
      - uses: actions/checkout@sha
      - run: scripts/assert-no-apple-credentials.sh
      - run: npm ci
      - run: |
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
        ? "          EXPECTED_PAYLOAD_SHA256=fixture\n          test \"$(shasum -a 256 unsigned-macos/CHECKSUMS.sha256 | awk '{print $1}')\" = \"$EXPECTED_PAYLOAD_SHA256\"\n          (cd unsigned-macos && shasum -a 256 -c CHECKSUMS.sha256)\n          gh attestation verify unsigned-macos/CHECKSUMS.sha256 --repo repo"
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
      - uses: actions/attest-build-provenance@sha
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
  android:
    env:
      KEYSTORE: \${{ secrets.ANDROID_KEYSTORE_BASE64 }}
${buildJob("ios-build", "tauri ios build --archive-only")}
${credentialJob("ios-sign", "xcodebuild -exportArchive")}
${finalizeJob("ios-verify")}
${credentialJob("ios-upload", "xcrun altool --upload-app", "ASC_KEY_BASE64")}
${finalizeJob("ios-finalize")}
${buildJob("macos-build", "tauri build")}
${credentialJob("macos-sign", "codesign app && xcrun notarytool submit app")}
${finalizeJob("macos-finalize")}
  linux:
    container:
      credentials:
        password: \${{ secrets.GITHUB_TOKEN }}
  release-index:
    steps: []
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
const verifyFixture = (source) => verifyAppleCredentialBoundary(source, {
  credentialJobDigests: fixtureCredentialJobDigests,
  rootAuthorityDigests: fixtureRootAuthorityDigests,
});

test("accepts separated source, credential, and finalization jobs", () => {
  assert.deepEqual(verifyFixture(validWorkflow), []);
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
  [
    "line continuation",
    `[[ 1 -eq 1 && ${String.fromCharCode(92)}\n  1 -eq 2 ]]`,
  ],
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
    "ios-build must run the Apple credential canary before dependency install",
  ],
  [
    "rejects a build without a post-build credential canary",
    (source) => source.replace(
      "          shasum -a 256 ZUULI.xcarchive.zip ExportOptions.plist source-record.json > CHECKSUMS.sha256\n      - run: scripts/assert-no-apple-credentials.sh",
      "          shasum -a 256 ZUULI.xcarchive.zip ExportOptions.plist source-record.json > CHECKSUMS.sha256",
    ),
    "ios-build must run the Apple credential canary after the unsigned build",
  ],
  [
    "rejects source checkout in a signer",
    (source) => source.replace(
      "      - uses: actions/download-artifact@sha\n",
      "      - uses: actions/checkout@sha\n      - uses: actions/download-artifact@sha\n",
    ),
    "ios-sign contains forbidden \"actions/checkout@\"",
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
      "      KEYSTORE: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
      "      KEYSTORE: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n      APPLE_LEAK: ${{ secrets.ASC_KEY_BASE64 }}\n",
    ),
    "android contains unauthorized secrets-context expression \"${{ secrets.ASC_KEY_BASE64 }}\"",
  ],
  [
    "rejects a flow anchor in Android aliased into the unsigned iOS build",
    (source) => source
      .replace(
        "      KEYSTORE: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
        "      KEYSTORE: &apple ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
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
        "      KEYSTORE: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
        `      KEYSTORE: &${anchor} \${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n`,
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
        "      KEYSTORE: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
        "      KEYSTORE: &apple ${{ secrets.ANDROID_KEYSTORE_BASE64 }}\n",
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
    (source) => source.replace("ZUULI.app.zip ZUULI-layout.dmg source-record.json", "ZUULI.app.zip source-record.json"),
    "macOS unsigned builder is missing \"ZUULI.app.zip ZUULI-layout.dmg source-record.json > CHECKSUMS.sha256\"",
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
    "ios-sign credential execution program changed",
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
