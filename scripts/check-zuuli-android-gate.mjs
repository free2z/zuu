#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = ".github/workflows/zuuli.yml";
const policyPath = "scripts/check-zuuli-android-gate.mjs";
const target = "armv7-linux-androideabi";
const ndk = "27.0.12077973";
const cacheKey = `zuuli-plugin-android-armv7-ndk${ndk}-api29`;

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

function check(workflow) {
  const failures = [];
  const changes = job(workflow, "changes");
  const android = job(workflow, "rust_android_32");
  const gate = job(workflow, "gate");

  const changeLines = changes.split("\n").map((line) => line.trim());
  if (!changeLines.includes(`node ${policyPath} --self-test`)) {
    failures.push("changes job must run the Android gate policy self-test");
  }
  if (!changeLines.includes(`node ${policyPath}`)) {
    failures.push("changes job must enforce the Android gate policy");
  }
  const escapedPolicyPath = policyPath.replaceAll(".", "\\.");
  if (!new RegExp(`^\\s+[^#\\n]*\\|${escapedPolicyPath}\\|`, "m").test(workflow)) {
    failures.push("Android gate policy changes must select the full ZUULI suite");
  }

  if (!android) failures.push("required rust_android_32 job is missing");
  requireLine(
    failures,
    android,
    "name: Rust / Android 32-bit",
    "32-bit Android job must retain its stable check name",
  );
  requireLine(
    failures,
    android,
    "needs: changes",
    "32-bit Android job must depend on change detection",
  );
  requireLine(
    failures,
    android,
    "if: needs.changes.outputs.zuuli == 'true'",
    "32-bit Android job must run for every ZUULI-impacting change",
  );
  requireLine(
    failures,
    android,
    `targets: ${target}`,
    `32-bit Android job must install ${target}`,
  );
  requireLine(
    failures,
    android,
    "run: git submodule update --init z/zcash/librustzcash",
    "32-bit Android job must fetch the in-source Zcash dependency",
  );
  requireLine(
    failures,
    android,
    `'ndk;${ndk}' >/dev/null`,
    `32-bit Android job must install NDK ${ndk}`,
  );
  requireLine(
    failures,
    android,
    `key: ${cacheKey}`,
    "32-bit Android cache must bind the target, NDK, and API level",
  );
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

  if (!/^\s+needs: \[[^\n]*\brust_android_32\b[^\n]*\]$/m.test(gate)) {
    failures.push("gate must await rust_android_32");
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

function runSelfTest(workflow) {
  const mutations = [
    ["the armv7 target is replaced", `targets: ${target}`, "targets: aarch64-linux-android"],
    ["the target check is replaced", `--target ${target}`, "--target aarch64-linux-android"],
    ["the pinned NDK is changed", `'ndk;${ndk}'`, "'ndk;latest'"],
    ["the cache drops its NDK boundary", `key: ${cacheKey}`, "key: zuuli-plugin-android-armv7"],
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
  ];

  const baseline = check(workflow);
  if (baseline.length > 0) {
    throw new Error(`cannot self-test an invalid baseline:\n${baseline.join("\n")}`);
  }
  for (const [name, from, to] of mutations) {
    if (!workflow.includes(from)) throw new Error(`self-test fixture missing: ${name}`);
    const failures = check(workflow.replace(from, to));
    if (failures.length === 0) throw new Error(`mutation escaped policy: ${name}`);
  }
  console.log(`Android gate policy self-test passed (${mutations.length} mutations).`);
}

const workflow = readFileSync(resolve(repoRoot, workflowPath), "utf8");
if (process.argv.includes("--self-test")) {
  runSelfTest(workflow);
} else {
  const failures = check(workflow);
  if (failures.length > 0) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
  }
  console.log(`Required ZUULI gate type-checks ${target}.`);
}
