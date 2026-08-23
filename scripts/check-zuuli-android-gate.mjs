#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = ".github/workflows/zuuli.yml";
const policyPath = "scripts/check-zuuli-android-gate.mjs";
const toolchainEnvPath = "wallet/zuuli/scripts/android-toolchain-env.sh";
const target = "armv7-linux-androideabi";
const ndk = "27.0.12077973";
const cacheKey = `zuuli-plugin-android-armv7-ndk${ndk}-api29`;
const changeDetectorDigest =
  "6d8ed19ac60777c842ab06f791f2ac22c734dce248e20451f5bc9f947fb2b1fb";

function job(workflow, name) {
  const start = new RegExp(`^  ${name}:\\n`, "m").exec(workflow);
  if (!start) return "";
  const tail = workflow.slice(start.index + start[0].length);
  const next = /^  [a-zA-Z0-9_]+:\n/m.exec(tail);
  return workflow.slice(
    start.index,
    next ? start.index + start[0].length + next.index : workflow.length,
  );
}

function namedStep(jobContents, name) {
  const start = new RegExp(`^      - name: ${name.replaceAll("/", "\\/")}\\n`, "m").exec(
    jobContents,
  );
  if (!start) return "";
  const tail = jobContents.slice(start.index + start[0].length);
  const next = /^(?:      - (?:name|uses):|  (?=\S))/m.exec(tail);
  return jobContents
    .slice(
      start.index,
      next ? start.index + start[0].length + next.index : jobContents.length,
    )
    .trimEnd();
}

function requireLine(failures, contents, expected, message) {
  const lines = contents.split("\n").map((line) => line.trim());
  if (!lines.includes(expected)) failures.push(message);
}

function check(workflow, toolchainEnv) {
  const failures = [];
  const changes = job(workflow, "changes");
  const android = job(workflow, "rust_android_32");
  const gate = job(workflow, "gate");

  const expectedPolicyStep = [
    "      - name: Verify the required 32-bit Android type-check policy",
    "        run: |",
    `          node ${policyPath} --self-test`,
    `          node ${policyPath}`,
  ].join("\n");
  if (
    namedStep(changes, "Verify the required 32-bit Android type-check policy") !==
    expectedPolicyStep
  ) {
    failures.push("changes job must execute the exact Android gate policy step");
  }
  const detector = namedStep(changes, "Detect release-impacting ZUULI changes");
  const detectorDigest = createHash("sha256").update(detector).digest("hex");
  if (detectorDigest !== changeDetectorDigest) {
    failures.push(
      "change detector differs from the reviewed fail-open/fail-closed selector step",
    );
  }
  const zuuliCase = detector.match(
    /case "\$file" in\n\s+([^\n]+)\)\n\s+zuuli=true/,
  );
  const selectedPatterns = zuuliCase?.[1].split("|").map((entry) => entry.trim()) ?? [];
  if (!selectedPatterns.includes(policyPath)) {
    failures.push("Android gate policy changes must select the full ZUULI suite");
  }

  if (!android) failures.push("required rust_android_32 job is missing");
  const expectedAndroidHeader = [
    "  rust_android_32:",
    "    name: Rust / Android 32-bit",
    "    needs: changes",
    "    if: needs.changes.outputs.zuuli == 'true'",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 35",
    "    steps:",
  ].join("\n");
  if (!android.startsWith(expectedAndroidHeader)) {
    failures.push("32-bit Android job must retain its exact required-job header");
  }
  if (/^\s+continue-on-error:/m.test(android)) {
    failures.push("32-bit Android job and steps must fail closed");
  }
  requireLine(
    failures,
    android,
    "run: git submodule update --init z/zcash/librustzcash",
    "32-bit Android job must fetch the in-source Zcash dependency",
  );
  const expectedTargetStep = [
    "      - name: Install the pinned 32-bit Android Rust target",
    "        uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable",
    "        with:",
    "          toolchain: ${{ steps.rust_toolchain.outputs.version }}",
    `          targets: ${target}`,
  ].join("\n");
  if (
    namedStep(android, "Install the pinned 32-bit Android Rust target") !==
    expectedTargetStep
  ) {
    failures.push(`32-bit Android job must install ${target} with the pinned action`);
  }
  const expectedNdkStep = [
    "      - name: Install the pinned Android NDK",
    "        run: |",
    "          set -euo pipefail",
    "          set +e",
    '          yes 2>/dev/null | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \\',
    `            'ndk;${ndk}' >/dev/null`,
    "          sdk_status=${PIPESTATUS[1]}",
    "          set -e",
    '          [[ "$sdk_status" -eq 0 ]] || { echo "sdkmanager failed ($sdk_status)" >&2; exit 1; }',
  ].join("\n");
  if (namedStep(android, "Install the pinned Android NDK") !== expectedNdkStep) {
    failures.push(`32-bit Android job must install the exact NDK ${ndk}`);
  }
  const expectedCacheStep = [
    "      - name: Restore the 32-bit Android Rust cache",
    "        uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2",
    "        with:",
    "          workspaces: wallet/plugins/tauri-plugin-zcash",
    `          key: ${cacheKey}`,
  ].join("\n");
  if (
    namedStep(android, "Restore the 32-bit Android Rust cache") !== expectedCacheStep
  ) {
    failures.push("32-bit Android cache must bind its pinned action, target, NDK, and API level");
  }
  const expectedTypecheckStep = [
    "      - name: Type-check the shared plugin on 32-bit Android",
    "        run: |",
    "          set -euo pipefail",
    "          source wallet/zuuli/scripts/android-toolchain-env.sh",
    `          cargo check --locked --target ${target} --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml`,
  ].join("\n");
  const typecheckStep = namedStep(android, "Type-check the shared plugin on 32-bit Android");
  if (typecheckStep !== expectedTypecheckStep) {
    failures.push("32-bit Android type-check step must execute the exact reviewed command block");
  }
  const requiredArchiverLines = [
    'export AR_aarch64_linux_android="$zuuli_ndk_bin/llvm-ar"',
    'export AR_armv7_linux_androideabi="$zuuli_ndk_bin/llvm-ar"',
    'export AR_i686_linux_android="$zuuli_ndk_bin/llvm-ar"',
    'export AR_x86_64_linux_android="$zuuli_ndk_bin/llvm-ar"',
    '[[ -x "$zuuli_ndk_bin/llvm-ar" ]] || {',
  ];
  for (const line of requiredArchiverLines) {
    requireLine(
      failures,
      toolchainEnv,
      line,
      `Android toolchain environment must retain pinned NDK archiver contract: ${line}`,
    );
  }

  const expectedGateHeader = [
    "  gate:",
    "    needs: [changes, frontend, rust_fmt, rust_deny, rust_clippy, rust_plugin, rust_android_32, rust_app, zuuallet_schema]",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 5",
    "    steps:",
  ].join("\n");
  if (!gate.startsWith(expectedGateHeader)) {
    failures.push("gate must await rust_android_32");
  }
  if (/^\s+continue-on-error:/m.test(gate)) {
    failures.push("required gate and its steps must fail closed");
  }
  requireLine(
    failures,
    gate,
    "RUST_ANDROID_32_RESULT: ${{ needs.rust_android_32.result }}",
    "gate must read the 32-bit Android result",
  );
  const resultAssignments = gate.match(/^\s+results=.*$/gm) ?? [];
  if (
    resultAssignments.length !== 1 ||
    !resultAssignments[0].includes("$RUST_ANDROID_32_RESULT")
  ) {
    failures.push("gate must enforce the 32-bit Android result");
  }
  const expectedGateStep = [
    "      - name: Enforce the 32-bit Android result",
    "        env:",
    "          ZUULI_CHANGED: ${{ needs.changes.outputs.zuuli }}",
    "          RUST_ANDROID_32_RESULT: ${{ needs.rust_android_32.result }}",
    "        run: |",
    "          set -euo pipefail",
    '          case "$ZUULI_CHANGED:$RUST_ANDROID_32_RESULT" in',
    "            true:success|false:skipped) ;;",
    '            *) echo "32-bit Android result is inconsistent: changed=$ZUULI_CHANGED result=$RUST_ANDROID_32_RESULT"; exit 1 ;;',
    "          esac",
  ].join("\n");
  const gateStep = namedStep(gate, "Enforce the 32-bit Android result");
  if (gateStep !== expectedGateStep) {
    failures.push("gate must directly reject an unexpected 32-bit Android result");
  }
  if (/\b(?:export\s+)?RUST_ANDROID_32_RESULT\s*=/.test(gate)) {
    failures.push("gate must not overwrite the 32-bit Android result");
  }

  return failures;
}

function runSelfTest(workflow, toolchainEnv) {
  const mutations = [
    ["the armv7 target is replaced", `targets: ${target}`, "targets: aarch64-linux-android"],
    ["the target check is replaced", `--target ${target}`, "--target aarch64-linux-android"],
    ["the pinned NDK is changed", `'ndk;${ndk}'`, "'ndk;latest'"],
    ["the cache drops its NDK boundary", `key: ${cacheKey}`, "key: zuuli-plugin-android-armv7"],
    [
      "the target action is replaced by decorative text",
      "      - name: Install the pinned 32-bit Android Rust target\n        uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable",
      `      - name: Install the pinned 32-bit Android Rust target\n        run: echo 'targets: ${target}'`,
    ],
    [
      "the NDK install is replaced by decorative text",
      "      - name: Install the pinned Android NDK\n        run: |\n          set -euo pipefail",
      `      - name: Install the pinned Android NDK\n        run: echo "'ndk;${ndk}' >/dev/null"`,
    ],
    [
      "the cache action is replaced by decorative text",
      "      - name: Restore the 32-bit Android Rust cache\n        uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2",
      `      - name: Restore the 32-bit Android Rust cache\n        run: echo 'key: ${cacheKey}'`,
    ],
    [
      "the job is detached from change detection",
      "  rust_android_32:\n    name: Rust / Android 32-bit\n    needs: changes",
      "  rust_android_32:\n    name: Rust / Android 32-bit\n    needs: []",
    ],
    ["the job is removed from gate needs", ", rust_android_32", ""],
    [
      "the gate result input is redirected",
      "RUST_ANDROID_32_RESULT: ${{ needs.rust_android_32.result }}",
      "RUST_ANDROID_32_RESULT: success",
    ],
    [
      "the exact type-check command is hidden behind a false condition",
      "          source wallet/zuuli/scripts/android-toolchain-env.sh\n",
      "          if false; then\n          source wallet/zuuli/scripts/android-toolchain-env.sh\n          fi\n",
    ],
    [
      "the gate overwrites the checked result",
      '          results="$FRONTEND_RESULT $RUST_FMT_RESULT $RUST_DENY_RESULT $RUST_CLIPPY_RESULT $RUST_PLUGIN_RESULT $RUST_ANDROID_32_RESULT $RUST_APP_RESULT"',
      '          results="$FRONTEND_RESULT $RUST_FMT_RESULT $RUST_DENY_RESULT $RUST_CLIPPY_RESULT $RUST_PLUGIN_RESULT $RUST_ANDROID_32_RESULT $RUST_APP_RESULT"\n          results="$FRONTEND_RESULT $RUST_FMT_RESULT $RUST_DENY_RESULT $RUST_CLIPPY_RESULT $RUST_PLUGIN_RESULT $RUST_APP_RESULT"',
    ],
    [
      "the dedicated gate check is disabled",
      "        run: |\n          set -euo pipefail\n          case \"$ZUULI_CHANGED:$RUST_ANDROID_32_RESULT\" in",
      "        if: false\n        run: |\n          set -euo pipefail\n          case \"$ZUULI_CHANGED:$RUST_ANDROID_32_RESULT\" in",
    ],
    ["the policy no longer selects itself", `|${policyPath}|`, "|"],
    [
      "the live policy invocation is removed",
      `          node ${policyPath}\n`,
      "",
    ],
    [
      "the policy invocation is hidden behind a false condition",
      `          node ${policyPath} --self-test\n          node ${policyPath}`,
      `          if false; then\n            node ${policyPath} --self-test\n            node ${policyPath}\n          fi`,
    ],
  ];

  const baseline = check(workflow, toolchainEnv);
  if (baseline.length > 0) {
    throw new Error(`cannot self-test an invalid baseline:\n${baseline.join("\n")}`);
  }
  for (const [name, from, to] of mutations) {
    if (!workflow.includes(from)) throw new Error(`self-test fixture missing: ${name}`);
    const failures = check(workflow.replace(from, to), toolchainEnv);
    if (failures.length === 0) throw new Error(`mutation escaped policy: ${name}`);
  }
  const decoratedSelector = workflow
    .replace(`|${policyPath}|`, "|")
    .replace(
      "  frontend:\n",
      `  # Dead decoration must not satisfy the real selector.\n  # if false; then : '|${policyPath}|'; fi\n  frontend:\n`,
    );
  if (check(decoratedSelector, toolchainEnv).length === 0) {
    throw new Error("mutation escaped policy: dead text replaces the real change selector");
  }
  const deadZuuliCase = workflow
    .replace(
      '          while IFS= read -r file; do\n            case "$file" in',
      '          while IFS= read -r file; do\n            if false; then\n            case "$file" in',
    )
    .replace(
      '            esac\n            case "$file" in',
      '            esac\n            fi\n            case "$file" in',
    );
  if (check(deadZuuliCase, toolchainEnv).length === 0) {
    throw new Error("mutation escaped policy: real ZUULI selector case is dead code");
  }
  const missingArmv7Archiver = toolchainEnv.replace(
    'export AR_armv7_linux_androideabi="$zuuli_ndk_bin/llvm-ar"',
    'export AR_armv7_linux_androideabi="arm-linux-androideabi-ar"',
  );
  if (check(workflow, missingArmv7Archiver).length === 0) {
    throw new Error("mutation escaped policy: armv7 uses an unpinned archiver");
  }
  console.log(
    `Android gate policy self-test passed (${mutations.length + 3} mutations).`,
  );
}

const workflow = readFileSync(resolve(repoRoot, workflowPath), "utf8");
const toolchainEnv = readFileSync(resolve(repoRoot, toolchainEnvPath), "utf8");
if (process.argv.includes("--self-test")) {
  runSelfTest(workflow, toolchainEnv);
} else {
  const failures = check(workflow, toolchainEnv);
  if (failures.length > 0) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
  }
  console.log(`Required ZUULI gate type-checks ${target}.`);
}
