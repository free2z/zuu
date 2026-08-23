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
    "source wallet/zuuli/scripts/android-toolchain-env.sh",
    "32-bit Android job must use the pinned NDK linker environment",
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
  requireLine(
    failures,
    android,
    `cargo check --locked --target ${target} --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml`,
    "32-bit Android job must type-check the shared plugin for armv7 with its lockfile",
  );

  if (!/^\s+needs: \[[^\n]*\brust_android_32\b[^\n]*\]$/m.test(gate)) {
    failures.push("gate must await rust_android_32");
  }
  requireLine(
    failures,
    gate,
    "RUST_ANDROID_32_RESULT: ${{ needs.rust_android_32.result }}",
    "gate must read the 32-bit Android result",
  );
  if (!/^\s+results="[^\n]*\$RUST_ANDROID_32_RESULT[^\n]*"$/m.test(gate)) {
    failures.push("gate must enforce the 32-bit Android result");
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
