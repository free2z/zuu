#!/usr/bin/env node

import { execFileSync } from "node:child_process";
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
  "08fcca68b909a7349a7a1e4703d274104a9a7565ff60c75b7e82c90e7ac04c1b";
const toolchainEnvDigest =
  "403f59c58bca0a37b98a3bb0ea0ae7f1c289b3531d6e1eec8496643866ee2013";
const requiredMessagingSelector = "wallet/zuuli/*";
const messagingContractInputs = [
  "docs/e2ee/CLIENT-CONTRACT.md",
  "docs/e2ee/WIRE.md",
];
const requiredWalletBoundarySelectors = [
  "wallet/shared/*",
  "wallet/zuuallet/*",
];

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

/// Every `rs/crates/<name>` a tracked manifest under `wallet/` path-depends on.
///
/// Read off the manifests rather than listed, because a list is what rots. The
/// messaging plugin links six of these and takes a seventh as a
/// dev-dependency; a change to any of them changes the wallet's own build, and
/// before the selector named them an `rs/` change that broke the wallet would
/// have skipped the entire ZUULI suite.
///
/// It must be **exactly** these, and not `rs/crates/*`: `f2z-relay`,
/// `f2z-relay-store`, `f2z-kt`, `f2z-witness` and `f2z-authority` are server
/// crates the wallet does not link, and selecting the whole ZUULI gate for a
/// relay change is the over-selection `check-github-actions-pins.mjs`'s
/// frontend-build contract already refuses.
function linkedRsCrates(root = repoRoot) {
  const manifests = execFileSync("git", ["ls-files", "--", "wallet/**/Cargo.toml"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const crates = new Set();
  for (const manifest of manifests) {
    const contents = readFileSync(resolve(root, manifest), "utf8");
    for (const [, name] of contents.matchAll(/rs\/crates\/([a-z0-9-]+)/g)) {
      crates.add(name);
    }
  }
  return [...crates].sort();
}

function requireLine(failures, contents, expected, message) {
  const lines = contents.split("\n").map((line) => line.trim());
  if (!lines.includes(expected)) failures.push(message);
}

function check(
  workflow,
  toolchainEnv,
  expectedChangeDetectorDigest = changeDetectorDigest,
  linkedCrates = linkedRsCrates(),
) {
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
  if (detectorDigest !== expectedChangeDetectorDigest) {
    failures.push(
      "change detector differs from the reviewed fail-open/fail-closed selector step",
    );
  }
  const zuuliPatternSets = detector
    .split("\n")
    .map((line) => line.split("#", 1)[0].trim())
    .filter((line) => line.endsWith(")"))
    .map((line) => line.slice(0, -1).split("|").map((entry) => entry.trim()));
  const selectedPatterns =
    zuuliPatternSets.find((patterns) => patterns.includes(policyPath)) ?? [];
  const allSelectedPatterns = new Set(zuuliPatternSets.flat());
  if (!selectedPatterns.includes(policyPath)) {
    failures.push("Android gate policy changes must select the full ZUULI suite");
  }
  if (!selectedPatterns.includes(requiredMessagingSelector)) {
    failures.push(
      "messaging changes must retain the full wallet/zuuli/* selector",
    );
  }
  for (const input of messagingContractInputs) {
    if (!selectedPatterns.includes(input)) {
      failures.push(`messaging contract input must select ZUULI: ${input}`);
    }
  }
  if (selectedPatterns.includes("rs/crates/*")) {
    failures.push(
      "rs/crates/* over-selects: name the crates the wallet links, not the tree",
    );
  }
  for (const crate of linkedCrates) {
    if (!selectedPatterns.includes(`rs/crates/${crate}/*`)) {
      failures.push(
        `wallet/ links rs/crates/${crate} in source; the ZUULI selector must name it`,
      );
    }
  }
  for (const input of requiredWalletBoundarySelectors) {
    if (!allSelectedPatterns.has(input)) {
      failures.push(`wallet package-boundary input must select ZUULI: ${input}`);
    }
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
  if (createHash("sha256").update(toolchainEnv).digest("hex") !== toolchainEnvDigest) {
    failures.push(
      "Android toolchain environment differs from the reviewed linker/compiler/archiver contract",
    );
  }

  const gateLines = gate.split("\n");
  const expectedGateControls = [
    "  gate:",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 5",
    "    steps:",
  ];
  if (
    gateLines[0] !== expectedGateControls[0] ||
    gateLines.slice(2, 6).join("\n") !== expectedGateControls.slice(1).join("\n")
  ) {
    failures.push("gate must retain its exact required-job controls");
  }
  const gateNeedsLines = [...gate.matchAll(/^    needs: \[([^\n]*)\]$/gm)];
  if (gateNeedsLines.length !== 1 || gateNeedsLines[0].index !== gate.indexOf("\n") + 1) {
    failures.push("gate must declare exactly one inline needs list in its header");
  } else {
    const gateNeeds = gateNeedsLines[0][1]
      .split(",")
      .map((dependency) => dependency.trim());
    if (gateNeeds.filter((dependency) => dependency === "rust_android_32").length !== 1) {
      failures.push("gate must await rust_android_32 exactly once");
    }
  }
  if (/^\s+continue-on-error:/m.test(gate)) {
    failures.push("required gate and its steps must fail closed");
  }
  const expectedGateStep = [
    "      - name: Verify required jobs succeeded or legitimately skipped",
    "        env:",
    "          POLICY_OUTCOME: ${{ steps.policy.outcome }}",
    "          REQUIRED_JOBS_JSON: ${{ toJSON(needs) }}",
    "        run: |",
    "          node scripts/check-github-actions-pins.mjs",
    "          node scripts/check-github-actions-pins.mjs --verify-gate-results",
  ].join("\n");
  const gateStep = namedStep(
    gate,
    "Verify required jobs succeeded or legitimately skipped",
  );
  if (gateStep !== expectedGateStep) {
    failures.push(
      "gate must enforce the complete needs context containing the 32-bit Android result",
    );
  }

  return failures;
}

function runSelfTest(workflow, toolchainEnv) {
  const selectorMutation = (input) => {
    for (const [from, to] of [
      [`|${input}|`, "|"],
      [`|${input})`, ")"],
      [`${input}|`, ""],
    ]) {
      if (workflow.includes(from)) return [from, to];
    }
    throw new Error(`self-test selector fixture missing: ${input}`);
  };
  const mutations = [
    [
      "the change detector restores a line-delimited Git producer",
      "git diff --name-only -z --no-renames",
      "git diff --name-only --no-renames",
    ],
    [
      "the change detector restores a line-delimited consumer",
      "while IFS= read -r -d '' file; do",
      "while IFS= read -r file; do",
    ],
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
      "the job is duplicated in gate needs",
      "rust_android_32, rust_app",
      "rust_android_32, rust_android_32, rust_app",
    ],
    [
      "the complete gate result input is redirected",
      "REQUIRED_JOBS_JSON: ${{ toJSON(needs) }}",
      'REQUIRED_JOBS_JSON: "{}"',
    ],
    [
      "the exact type-check command is hidden behind a false condition",
      "          source wallet/zuuli/scripts/android-toolchain-env.sh\n",
      "          if false; then\n          source wallet/zuuli/scripts/android-toolchain-env.sh\n          fi\n",
    ],
    [
      "the complete gate verifier is replaced with logging",
      "          node scripts/check-github-actions-pins.mjs --verify-gate-results",
      '          echo "$REQUIRED_JOBS_JSON"',
    ],
    [
      "the complete gate verdict is disabled",
      "      - name: Verify required jobs succeeded or legitimately skipped\n        env:",
      "      - name: Verify required jobs succeeded or legitimately skipped\n        if: false\n        env:",
    ],
    ["the policy no longer selects itself", `|${policyPath}|`, "|"],
    [
      "the messaging selector is deleted",
      `|${requiredMessagingSelector}|`,
      "|",
      "messaging changes must retain the full wallet/zuuli/* selector",
    ],
    [
      "the messaging selector is narrowed to one current directory",
      `|${requiredMessagingSelector}|`,
      "|wallet/zuuli/src/features/messages/*|",
      "messaging changes must retain the full wallet/zuuli/* selector",
    ],
    [
      "the messaging selector is substituted with an unrelated path",
      `|${requiredMessagingSelector}|`,
      "|wallet/zuuli/src/features/chat/*|",
      "messaging changes must retain the full wallet/zuuli/* selector",
    ],
    ...requiredWalletBoundarySelectors.map((input) => {
      const [from, to] = selectorMutation(input);
      return [
        `wallet package-boundary input no longer selects ZUULI: ${input}`,
        from,
        to,
      ];
    }),
    ...messagingContractInputs.map((input) => [
      `messaging contract input no longer selects ZUULI: ${input}`,
      `|${input}|`,
      "|",
      `messaging contract input must select ZUULI: ${input}`,
    ]),
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
  for (const [name, digest] of [
    [
      "the reviewed change-detector digest is stale",
      "c6310395af8224c88b3e58fddf182950d65c52cf12caf6b48bbf82815694f52b",
    ],
    ["the reviewed change-detector digest is wrong", "0".repeat(64)],
  ]) {
    const failures = check(workflow, toolchainEnv, digest);
    if (
      !failures.includes(
        "change detector differs from the reviewed fail-open/fail-closed selector step",
      )
    ) {
      throw new Error(`mutation escaped policy: ${name}`);
    }
    console.log(`self-test: ${name}: passed`);
  }
  for (const [name, from, to, expectedFailure] of mutations) {
    if (!workflow.includes(from)) throw new Error(`self-test fixture missing: ${name}`);
    const failures = check(workflow.replace(from, to), toolchainEnv);
    if (failures.length === 0) throw new Error(`mutation escaped policy: ${name}`);
    if (expectedFailure && !failures.includes(expectedFailure)) {
      throw new Error(
        `mutation failed for the wrong reason: ${name}: ${failures.join("; ")}`,
      );
    }
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
  const deadPinnedArmv7Archiver = toolchainEnv.replace(
    'export AR_armv7_linux_androideabi="$zuuli_ndk_bin/llvm-ar"',
    'export AR_armv7_linux_androideabi="/usr/bin/ar"\nif false; then\n  export AR_armv7_linux_androideabi="$zuuli_ndk_bin/llvm-ar"\nfi',
  );
  if (check(workflow, deadPinnedArmv7Archiver).length === 0) {
    throw new Error("mutation escaped policy: pinned armv7 archiver is dead decoration");
  }
  // The rs/ selector, both directions.
  {
    const failures = check(workflow, toolchainEnv, changeDetectorDigest, [
      "f2z-msg-dag",
      "f2z-not-selected",
    ]);
    const expected =
      "wallet/ links rs/crates/f2z-not-selected in source; the ZUULI selector must name it";
    if (!failures.includes(expected)) {
      throw new Error("mutation escaped policy: a linked rs crate the selector omits");
    }
    console.log("self-test: a linked rs crate the selector omits is detected: passed");
  }
  {
    const overBroad = workflow.replace("rs/crates/f2z-codec/*", "rs/crates/*");
    const failures = check(overBroad, toolchainEnv, changeDetectorDigest, []);
    if (
      !failures.includes(
        "rs/crates/* over-selects: name the crates the wallet links, not the tree",
      )
    ) {
      throw new Error("mutation escaped policy: an over-broad rs/crates/* selector");
    }
    console.log("self-test: an over-broad rs/crates/* selector is detected: passed");
  }

  console.log(
    `Android gate policy self-test passed (${mutations.length + 8} mutations).`,
  );
}

const workflow = readFileSync(resolve(repoRoot, workflowPath), "utf8");
const toolchainEnv = readFileSync(resolve(repoRoot, toolchainEnvPath), "utf8");
// The digest is a reviewed constant, and re-deriving it by hand is how a
// deliberate edit to the change detector turns into a wrong literal. This
// prints what the current file hashes to, so updating the constant is a copy
// rather than an experiment — the same affordance
// `scripts/check-librustzcash-compat.mjs --print-scope-digest` provides.
if (process.argv.includes("--print-change-detector-digest")) {
  const changes = job(workflow, "changes");
  const detector = namedStep(changes, "Detect release-impacting ZUULI changes");
  console.log(createHash("sha256").update(detector).digest("hex"));
} else if (process.argv.includes("--self-test")) {
  runSelfTest(workflow, toolchainEnv);
} else {
  const failures = check(workflow, toolchainEnv);
  if (failures.length > 0) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
  }
  console.log(`Required ZUULI gate type-checks ${target}.`);
}
