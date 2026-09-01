#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compatibilityScopeIdentity,
  reviewedCompatibilityScope,
} from "./check-librustzcash-compat.mjs";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const POLICY_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EXTERNAL_USES =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@([^@\s]+)$/;
const REQUIRED_WORKFLOW_PATH = ".github/workflows/zuuli.yml";
const GATE_CHECKOUT_REFERENCE =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const GATE_POLICY_SELF_TEST_COMMAND =
  "node scripts/check-github-actions-pins.mjs --self-test";
const GATE_POLICY_COMMAND = "node scripts/check-github-actions-pins.mjs";
const WORKFLOW_GATES_SELF_TEST_COMMAND =
  "node scripts/check-workflow-gates.mjs --self-test";
const WORKFLOW_GATES_COMMAND = "node scripts/check-workflow-gates.mjs";
const LIBRUSTZCASH_POLICY_SELF_TEST_COMMAND =
  "node scripts/check-librustzcash-compat.mjs --self-test";
const LIBRUSTZCASH_POLICY_COMMAND =
  "node scripts/check-librustzcash-compat.mjs";
const REQUIRED_LIBRUSTZCASH_LOCKFILE_COUNT = 3;
const REQUIRED_LIBRUSTZCASH_PACKAGE_COUNT = 11;
const REQUIRED_LIBRUSTZCASH_SCOPE_DIGEST =
  "4b4115dff3d451ca9f4576881fb80e3b7b1c33b465e69968048e18b9bf0325ab";
const GATE_VERDICT_COMMAND =
  "node scripts/check-github-actions-pins.mjs --verify-gate-results";
const WASM_POLICY_SELF_TEST_COMMAND =
  "node wallet/zuuli/scripts/wasm-boundary.mjs --self-test";
const WASM_POLICY_COMMAND = "node wallet/zuuli/scripts/wasm-boundary.mjs";
const FRONTEND_CHECKOUT_REFERENCE = GATE_CHECKOUT_REFERENCE;
const POLICED_RUST_ROOTS = ["wallet", "rs"];
const RUST_ROOT_CONTRACTS = [
  {
    root: "wallet",
    workflow: ".github/workflows/zuuli.yml",
    selectorStep: "Detect release-impacting ZUULI changes",
    selectorId: "filter",
    selectorOutput: "zuuli",
    selectorOutputs: [
      {
        name: "zuuli",
        probeRoot: "wallet",
        additionalProbePaths: [
          "wallet/nested/future/source.rs",
          "wallet/Cargo.toml",
          "wallet/nested/future/Cargo.toml",
          "docs/e2ee/CLIENT-CONTRACT.md",
          "docs/e2ee/WIRE.md",
        ],
      },
      {
        name: "zuuallet_schema",
        probeRoot: "wallet/zuuallet/src-tauri",
      },
    ],
    excludedProbePaths: [
      "wallet/README.md",
      "wallet/docs/architecture.md",
      "rs/crates/f2z-relay/src/lib.rs",
      // Markdown under wallet/zuuli/ is prose about the app, not an input to
      // any job the gate awaits, and `wallet/zuuli/*` would otherwise select
      // the whole native matrix for a STATUS re-derivation. Probed at the root
      // and at depth because the guard is a glob whose `*` spans `/`.
      "wallet/zuuli/STATUS.md",
      "wallet/zuuli/CLAUDE.md",
      "wallet/zuuli/docs/e2ee/notes.md",
    ],
    jobs: [
      [
        "rust_fmt",
        "Check formatting of every Rust crate under wallet/",
        "scripts/check-rust-fmt.sh --root wallet",
      ],
      [
        "rust_clippy",
        "Lint every Rust crate under wallet/ at -D warnings",
        "scripts/check-rust-clippy.sh --root wallet",
      ],
      [
        "rust_deny",
        "Check advisories, licences and sources",
        "scripts/check-rust-deny.sh --root wallet --config wallet/deny.toml",
      ],
    ],
  },
  {
    root: "rs",
    workflow: ".github/workflows/rs.yml",
    selectorStep: "Detect changes under rs/",
    selectorId: "filter",
    selectorOutput: "rs",
    selectorOutputs: [
      {
        name: "rs",
        probeRoot: "rs",
        additionalProbePaths: [
          "docs/e2ee/KT.md",
          "docs/e2ee/decisions/0013-key-transparency-log.md",
          "docs/e2ee/evidence/akd-benchmark.json",
          "docs/e2ee/evidence/akd-audit-scope.json",
          "scripts/check-akd-doc-evidence.mjs",
        ],
      },
    ],
    jobs: [
      [
        "rs_fmt",
        "Check every crate under rs/",
        "scripts/check-rust-fmt.sh --root rs",
      ],
      [
        "rs_clippy",
        "Lint every crate under rs/ at -D warnings",
        "scripts/check-rust-clippy.sh --root rs",
      ],
      [
        "rs_deny",
        "Enforce rs/deny.toml over every crate under rs/",
        "scripts/check-rust-deny.sh --root rs --config rs/deny.toml",
      ],
    ],
  },
];
const REQUIRED_NATIVE_CLIPPY_JOB_LINES = [
  "  rust_native_clippy:",
  "    name: Rust / native lints (${{ matrix.target_os }})",
  "    needs: changes",
  "    if: needs.changes.outputs.zuuli == 'true' || needs.changes.outputs.zuuallet_schema == 'true'",
  "    timeout-minutes: 90",
  "    strategy:",
  "      fail-fast: false",
  "      matrix:",
  "        include:",
  "          - os: macos-latest",
  "            target_os: macos",
  "          - os: windows-latest",
  "            target_os: windows",
  "    runs-on: ${{ matrix.os }}",
  "    steps:",
  `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1`,
  "      - name: Fetch librustzcash submodule",
  "        run: git submodule update --init z/zcash/librustzcash",
  "      - name: Resolve the pinned Rust toolchain",
  "        id: rust_toolchain",
  "        shell: bash",
  "        run: |",
  "          set -euo pipefail",
  "          version=$(scripts/check-rust-toolchain.sh --print-channel)",
  '          echo "version=$version" >> "$GITHUB_OUTPUT"',
  "      - uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable",
  "        with:",
  "          toolchain: ${{ steps.rust_toolchain.outputs.version }}",
  "          components: clippy",
  "      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2",
  "        with:",
  "          workspaces: |",
  "            wallet/plugins/tauri-plugin-zcash",
  "            wallet/zuuli/src-tauri",
  "            wallet/zuuallet/src-tauri",
  "          key: zuuli-native-clippy-${{ matrix.target_os }}",
  "      - name: Prove native target selection and -D warnings",
  "        shell: bash",
  '        run: scripts/check-rust-clippy.sh --self-test "${{ matrix.target_os }}"',
  "      - name: Lint every Rust crate under wallet/ at -D warnings",
  "        shell: bash",
  "        run: scripts/check-rust-clippy.sh --root wallet",
];
// The macOS/Windows job that *executes* the shared plugin's test suite. Held to
// its exact source for the same reason as the lint job beside it: this is the
// only required job that runs Win32 and Darwin code paths, so weakening the
// command, the matrix or the selector silently restores the #610 state where
// Windows execution could not fail a merge.
const REQUIRED_NATIVE_TESTS_JOB_LINES = [
  "  rust_native_tests:",
  "    name: Rust / native tests (${{ matrix.target_os }})",
  "    needs: changes",
  "    if: needs.changes.outputs.zuuli == 'true' || needs.changes.outputs.zuuallet_schema == 'true'",
  "    timeout-minutes: 90",
  "    strategy:",
  "      fail-fast: false",
  "      matrix:",
  "        include:",
  "          - os: macos-latest",
  "            target_os: macos",
  "          - os: windows-latest",
  "            target_os: windows",
  "    runs-on: ${{ matrix.os }}",
  "    steps:",
  `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1`,
  "      - name: Fetch librustzcash submodule",
  "        run: git submodule update --init z/zcash/librustzcash",
  "      - name: Resolve the pinned Rust toolchain",
  "        id: rust_toolchain",
  "        shell: bash",
  "        run: |",
  "          set -euo pipefail",
  "          version=$(scripts/check-rust-toolchain.sh --print-channel)",
  '          echo "version=$version" >> "$GITHUB_OUTPUT"',
  "      - uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable",
  "        with:",
  "          toolchain: ${{ steps.rust_toolchain.outputs.version }}",
  "      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2",
  "        with:",
  "          workspaces: wallet/plugins/tauri-plugin-zcash",
  "          key: zuuli-native-tests-${{ matrix.target_os }}",
  "      - name: Test the shared plugin on the native host",
  "        shell: bash",
  "        run: >-",
  "          cargo test --locked",
  "          --all-targets",
  "          --features production-route-probe",
  "          --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml",
];
const REQUIRED_CRYPTO_TARGET_JOB_LINES = [
  "  rust_crypto_targets:",
  "    name: Rust / modern crypto targets (${{ matrix.family }})",
  "    needs: changes",
  "    if: needs.changes.outputs.zuuli == 'true'",
  "    timeout-minutes: 45",
  "    strategy:",
  "      fail-fast: false",
  "      matrix:",
  "        include:",
  "          - family: linux-android",
  "            os: ubuntu-24.04",
  "            targets: x86_64-unknown-linux-gnu,aarch64-linux-android,armv7-linux-androideabi,i686-linux-android,x86_64-linux-android",
  "          - family: apple",
  "            os: macos-26",
  "            targets: aarch64-apple-darwin,x86_64-apple-darwin,aarch64-apple-ios",
  "          - family: windows",
  "            os: windows-2025",
  "            targets: x86_64-pc-windows-msvc",
  "    runs-on: ${{ matrix.os }}",
  "    steps:",
  `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1`,
  "      - name: Resolve the pinned Rust toolchain",
  "        id: rust_toolchain",
  "        shell: bash",
  "        run: |",
  "          set -euo pipefail",
  "          version=$(scripts/check-rust-toolchain.sh --print-channel)",
  '          echo "version=$version" >> "$GITHUB_OUTPUT"',
  "      - name: Install the pinned compiler and release targets",
  "        uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable",
  "        with:",
  "          toolchain: ${{ steps.rust_toolchain.outputs.version }}",
  "          targets: ${{ matrix.targets }}",
  "      - name: Verify exact clean source identity",
  "        shell: bash",
  "        run: |",
  "          set -euo pipefail",
  '          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
  '          test -z "$(git status --porcelain --untracked-files=all)"',
  "      - name: Build the representative crypto probe for every release target",
  "        shell: bash",
  "        run: |",
  "          set -euo pipefail",
  "          IFS=',' read -ra targets <<< '${{ matrix.targets }}'",
  '          for target in "${targets[@]}"; do',
  '            cargo build --locked --release --lib --target "$target" \\',
  "              --manifest-path wallet/zuuli/crypto-target-spike/Cargo.toml",
  "          done",
  "      - name: Execute the representative crypto probe on the hosted OS",
  "        shell: bash",
  "        run: cargo test --locked --manifest-path wallet/zuuli/crypto-target-spike/Cargo.toml -- --nocapture",
];
const REQUIRED_CRYPTO_PROBE_INPUTS = new Map([
  [
    "wallet/zuuli/crypto-target-spike/Cargo.toml",
    "341cd331a35d440ac495f42843a2712fdaf0df84a6f80920c30101c27e37688f",
  ],
  [
    "wallet/zuuli/crypto-target-spike/Cargo.lock",
    "a72f1141ad6803d643c87c44f87ea20b82bd166193818db2919caca444cc1b94",
  ],
  [
    "wallet/zuuli/crypto-target-spike/src/lib.rs",
    "6988d6425fc811739c8fd6f7f71f4f052585ed9d97ceaa80143b03b37f26bc66",
  ],
]);
const REQUIRED_NATIVE_CLIPPY_INPUTS = [
  "Cargo.toml",
  "Cargo.lock",
  ".cargo/config.toml",
  "clippy.toml",
  ".clippy.toml",
  "wallet/Cargo.toml",
  "wallet/Cargo.lock",
  "wallet/.cargo/config.toml",
  "wallet/clippy.toml",
  "wallet/.clippy.toml",
  "wallet/future-crate/src/lib.rs",
  "wallet/future-crate/Cargo.toml",
  "wallet/future-crate/Cargo.lock",
  "wallet/future-crate/.cargo/config.toml",
  "wallet/future-crate/clippy.toml",
  "wallet/future-crate/.clippy.toml",
];
const REQUIRED_CLASSIC_SEED_BOUNDARY_INPUTS = [
  "wallet/shared/sensitive-entry-session.ts",
  "wallet/zuuallet/package.json",
  "wallet/zuuallet/package-lock.json",
  "wallet/zuuallet/src/hooks/useWallet.ts",
  "wallet/zuuallet/src/lib/mnemonic.ts",
  "wallet/zuuallet/src/lib/sensitive-entry.ts",
  "wallet/zuuallet/src/lib/sensitive-seed-session.ts",
  "wallet/zuuallet/src/lib/sensitive-seed.ts",
  "wallet/zuuallet/src/lib/tauri.ts",
  "wallet/zuuallet/src/pages/CreateWallet.tsx",
  "wallet/zuuallet/src/pages/RestoreWallet.tsx",
  "wallet/zuuallet/src/pages/Settings.tsx",
  "wallet/zuuallet/src/pages/Welcome.tsx",
  "wallet/zuuallet/src/pages/sensitive-entry-routes.test.tsx",
  "wallet/zuuallet/src/types/index.ts",
];
const REQUIRED_FRONTEND_PACKAGE_SCRIPTS = new Map([
  [
    "test",
    "vitest run && node --test scripts/safe-area-contract.node-test.mjs scripts/android-device-catalog.node-test.mjs scripts/media-permission-manifests.node-test.mjs scripts/android-release-artifact.node-test.mjs scripts/aab-payload-digest.node-test.mjs scripts/auth-session-boundary.node-test.mjs scripts/mermaid-security.node-test.mjs scripts/send-review-boundary.node-test.mjs scripts/mobile-webview-authority.node-test.mjs scripts/seed-capture-boundary.node-test.mjs scripts/ui-copy-truncation.node-test.mjs scripts/fixture-privacy.node-test.mjs scripts/apple-credential-boundary.node-test.mjs scripts/macos-keychain-entitlements.node-test.mjs scripts/artifact-sbom.node-test.mjs scripts/release-tag-identity.node-test.mjs scripts/status-freshness.node-test.mjs scripts/wasm-boundary.node-test.mjs scripts/messaging-contract.node-test.mjs scripts/rtl-source-policy.node-test.mjs && node scripts/apple-credential-boundary.mjs && node scripts/macos-keychain-entitlements.mjs && node scripts/rtl-source-policy.mjs && playwright test",
  ],
  [
    "build",
    "npm run wasm:build && tsc -p tsconfig.build.json && vite build && npm run wasm:verify-dist",
  ],
  ["typecheck", "tsc --noEmit -p tsconfig.build.json"],
  ["typecheck:tests", "tsc --noEmit"],
  [
    "test:seed-capture",
    "vitest run src/lib/wallet/sensitive-seed.test.ts src/lib/wallet/sensitive-entry.test.ts src/lib/wallet/sensitive-entry-bridges.test.ts src/lib/wallet/sensitive-entry-hooks.test.tsx src/lib/wallet/zuuallet-created-seed.test.ts src/features/wallet/Onboarding.sensitive-entry.test.tsx && npm --prefix ../zuuallet run test:sensitive-entry && node --test scripts/seed-capture-boundary.node-test.mjs && node scripts/seed-capture-boundary.mjs",
  ],
]);
const REQUIRED_CLASSIC_PACKAGE_SCRIPTS = new Map([
  [
    "test:sensitive-entry",
    "vitest run src/pages/sensitive-entry-routes.test.tsx",
  ],
]);
const REQUIRED_FRONTEND_BUILD_TSCONFIG = Object.freeze({
  extends: "./tsconfig.json",
  exclude: Object.freeze(["src/**/*.test.ts", "src/**/*.test.tsx"]),
});
const REQUIRED_FRONTEND_JOB_LINES = [
  "  frontend:",
  "    name: zuuli / frontend",
  "    needs: changes",
  "    if: needs.changes.outputs.zuuli == 'true'",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 35",
  "    defaults:",
  "      run:",
  "        working-directory: wallet/zuuli",
  "    steps:",
  `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1`,
  "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
  "        with:",
  "          node-version: '24'",
  "          cache: npm",
  "          cache-dependency-path: |",
  "            wallet/zuuli/package-lock.json",
  "            wallet/zuuallet/package-lock.json",
  "      - name: Resolve the pinned frontend Rust toolchain",
  "        id: frontend_rust_toolchain",
  "        run: |",
  "          set -euo pipefail",
  "          version=$(../../scripts/check-rust-toolchain.sh --print-channel)",
  '          echo "version=$version" >> "$GITHUB_OUTPUT"',
  "      - name: Install the pinned Rust/WASM compiler",
  "        uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable",
  "        with:",
  "          toolchain: ${{ steps.frontend_rust_toolchain.outputs.version }}",
  "          targets: wasm32-unknown-unknown",
  "      - name: Install locked dependencies",
  "        run: |",
  "          npm ci",
  "          npm ci --prefix ../zuuallet",
  "      - name: Verify release cache security policy",
  "        run: |",
  "          node scripts/verify-ci-cache-policy.mjs --self-test",
  "          node scripts/verify-ci-cache-policy.mjs",
  "      - name: Verify generated app and store icons",
  "        run: npm run icons:check",
  "      - name: Test store listing contract and read-only audit",
  "        run: npm run test:store-listing",
  "      - name: Validate canonical store manifest and media",
  "        run: npm run store:validate",
  "      - name: Test App Store Connect state machine",
  "        run: npm run test:asc-testflight",
  "      - name: Audit dependencies (high and critical)",
  "        run: |",
  "          for attempt in 1 2 3; do",
  "            npm audit --audit-level=high && exit 0",
  '            [ "$attempt" -eq 3 ] && exit 1',
  "            sleep $((attempt * 5))",
  "          done",
  "      - name: Typecheck",
  "        run: |",
  "          npm run typecheck",
  "          npm run typecheck:tests",
  "      - name: Verify RTL source policy",
  "        run: |",
  "          node --test scripts/rtl-source-policy.node-test.mjs",
  "          node scripts/rtl-source-policy.mjs",
  "      - name: Verify the viewport-test browser",
  "        run: google-chrome --version",
  "      - name: Test frontend contracts",
  "        run: |",
  "          npm run test",
  "          npm --prefix ../zuuallet run test:sensitive-entry",
  "      - name: Build production frontend",
  "        run: npm run build",
];
// Environment inheritance can alter Bash and Node before an exact `run:` block
// begins. Required jobs therefore accept only these reviewed data inputs; every
// other workflow/job/step environment entry fails closed.
const REQUIRED_WORKFLOW_ENVIRONMENT = new Map([
  ["CARGO_TERM_COLOR", "always"],
  ["RUST_BACKTRACE", "1"],
]);
const REQUIRED_JOB_ENVIRONMENTS = new Map([
  [
    "zuuallet_schema",
    new Map([["CARGO_TARGET_DIR", "${{ github.workspace }}/target"]]),
  ],
]);
const REQUIRED_JOB_DEFAULT_WORKING_DIRECTORIES = new Map([
  ["frontend", "wallet/zuuli"],
]);
const REQUIRED_STEP_ENVIRONMENTS = new Map([
  [
    "rs_test\0Mutation-test AKD documentation evidence",
    new Map([["GITHUB_TOKEN", "${{ github.token }}"]]),
  ],
  [
    "rs_test\0Verify AKD documentation against locked executable evidence",
    new Map([["GITHUB_TOKEN", "${{ github.token }}"]]),
  ],
  [
    "changes\0Detect release-impacting ZUULI changes",
    new Map([
      [
        "BASE_SHA",
        "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}",
      ],
    ]),
  ],
  [
    "rust_app\0Build ZUULI Tauri backend",
    new Map([
      [
        "TAURI_SCHEMA_GENERATION_NONCE",
        "${{ github.run_id }}-${{ github.run_attempt }}",
      ],
      [
        "TAURI_PERMISSION_GENERATION_NONCE",
        "${{ github.run_id }}-${{ github.run_attempt }}",
      ],
    ]),
  ],
  [
    "zuuallet_schema\0Regenerate Zuuallet permissions and target schema",
    new Map([
      [
        "TAURI_SCHEMA_GENERATION_NONCE",
        "${{ github.run_id }}-${{ github.run_attempt }}",
      ],
      [
        "TAURI_PERMISSION_GENERATION_NONCE",
        "${{ github.run_id }}-${{ github.run_attempt }}",
      ],
    ]),
  ],
  [
    // The messaging plugin's `build.rs` watches the nonce, so a restored Cargo
    // cache cannot turn its permission-drift assertion into a no-op. The relay
    // path binds the real-daemon regression to the binary built in the prior
    // step rather than permitting a PATH substitution. There is no schema
    // nonce: this plugin has no consuming app in the tree yet.
    "rust_msg_plugin\0Build and test the messaging plugin",
    new Map([
      [
        "F2Z_RELAY_BIN",
        "${{ github.workspace }}/rs/target/debug/f2z-relay",
      ],
      [
        "TAURI_PERMISSION_GENERATION_NONCE",
        "${{ github.run_id }}-${{ github.run_attempt }}",
      ],
    ]),
  ],
  [
    "gate\0Verify required jobs succeeded or legitimately skipped",
    new Map([
      ["POLICY_OUTCOME", "${{ steps.policy.outcome }}"],
      ["REQUIRED_JOBS_JSON", "${{ toJSON(needs) }}"],
    ]),
  ],
]);
const REQUIRED_STEP_WORKING_DIRECTORIES = new Map([
  ["rust_clippy\0Verify pinned Linux build image", "/"],
  ["rust_plugin\0Verify pinned Linux build image", "/"],
  ["rust_app\0Verify pinned Linux build image", "/"],
  ["zuuallet_schema\0Verify pinned Linux build image", "/"],
  ["rust_msg_plugin\0Verify pinned Linux build image", "/"],
]);

// Required-gate policy deliberately accepts a small, canonical YAML subset.
// Alternate keys, inline job maps, aliases, and decorators fail closed instead
// of giving a second spelling to controls this checker must recognize.

function yamlFilesBelow(directory) {
  if (!fs.existsSync(directory)) return [];

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...yamlFilesBelow(candidate));
    } else if (/\.ya?ml$/i.test(entry.name)) {
      files.push(candidate);
    }
  }
  return files;
}

function usesFromLine(line) {
  // Keep the policy deliberately smaller than a YAML parser: GitHub's usual
  // block-mapping form is supported below, while alternate key spellings and
  // inline collections that could hide `uses` fail closed. This also covers
  // valid constructs such as `steps: [{ uses: ... }]` and nested flow jobs.
  let keySearchLine = line;
  keySearchLine = keySearchLine.replace(
    /"(?:\\.|[^"])*"|'(?:''|[^'])*'/g,
    (quoted) => {
      let decoded;
      if (quoted[0] === '"') {
        try {
          decoded = JSON.parse(quoted);
        } catch {
          return quoted;
        }
      } else {
        decoded = quoted.slice(1, -1).replaceAll("''", "'");
      }
      // Preserve a decoded `uses` key for policy detection, but mask every
      // other quoted scalar so text such as "documentation uses: ..." cannot
      // be mistaken for a workflow key.
      return decoded === "uses" ? "uses" : '""';
    },
  );
  keySearchLine = keySearchLine.replace(/^\s*#.*$|\s+#.*$/, "");

  // Explicit keys and continued quoted keys can construct the literal key
  // `uses` across multiple source lines. The checker intentionally supports a
  // constrained, reviewable YAML spelling instead of trying to reimplement a
  // complete YAML resolver.
  if (/^\s*(?:-\s*)?\?\s*/.test(keySearchLine)) {
    return {
      error:
        "explicit YAML mapping keys are unsupported; put `uses:` on its own line",
    };
  }
  if (/^\s*(?:-\s*)?"(?:\\.|[^"])*\\\s*$/.test(line)) {
    return {
      error:
        "continued quoted YAML scalars are unsupported because they can construct `uses`",
    };
  }
  if (/[\[,{]\s*(?:"(?:\\.|[^"])*"|'(?:''|[^'])*')\s*:/.test(keySearchLine)) {
    return {
      error:
        "quoted keys in inline YAML mappings are unsupported because they can encode `uses`",
    };
  }

  const match = line.match(/^\s*(?:-\s*)?uses\s*:\s*(.*?)\s*$/);
  let scalar;
  if (match) {
    scalar = match[1];
  } else {
    const quotedKey = line.match(
      /^\s*(?:-\s*)?((?:"(?:\\.|[^"])*")|(?:'(?:''|[^'])*'))\s*:\s*(.*?)\s*$/,
    );
    if (quotedKey) {
      let key;
      if (quotedKey[1][0] === '"') {
        try {
          key = JSON.parse(quotedKey[1]);
        } catch {
          return { error: "quoted YAML mapping key cannot be decoded safely" };
        }
      } else {
        key = quotedKey[1].slice(1, -1).replaceAll("''", "'");
      }
      if (key !== "uses") return null;
      scalar = quotedKey[2];
    }
  }

  if (!match && scalar === undefined) {
    if (
      /(?:^|[\s[,{?])\*[^\s:[\]{},]+\s*:/.test(keySearchLine) ||
      /^\s*(?:-\s*)?\?\s*\*[^\s:[\]{},]+\s*$/.test(keySearchLine)
    ) {
      return {
        error:
          "YAML aliases are unsupported as mapping keys because they can resolve to `uses`",
      };
    }
    if (
      /\buses\s*:/.test(keySearchLine) ||
      /^\s*(?:-\s*)?\??\s*(?:(?:&|!)[^\s]+\s+)*uses\s*$/.test(keySearchLine)
    ) {
      return {
        error:
          "decorated, inline, or explicit `uses` mappings are unsupported; put `uses:` on its own line",
      };
    }
    return null;
  }

  if (!scalar) return { error: "empty `uses:` value" };

  if (scalar[0] === '"' || scalar[0] === "'") {
    const quote = scalar[0];
    const closing = scalar.indexOf(quote, 1);
    if (closing < 0) return { error: "unterminated quoted `uses:` value" };

    const trailing = scalar.slice(closing + 1).trim();
    if (trailing && !trailing.startsWith("#")) {
      return { error: "unexpected content after quoted `uses:` value" };
    }
    return {
      provenance: trailing.startsWith("#") ? trailing.slice(1).trim() : "",
      ref: scalar.slice(1, closing),
    };
  }

  const comment = scalar.search(/\s+#/);
  const ref = (comment < 0 ? scalar : scalar.slice(0, comment)).trim();
  const provenance =
    comment < 0 ? "" : scalar.slice(comment).replace(/^\s+#/, "").trim();
  return ref ? { provenance, ref } : { error: "empty `uses:` value" };
}

function shellCasePatternMatches(pattern, value) {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${regex}$`).test(value);
}

function stripYamlComment(line) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
    } else if (character === "'") {
      singleQuoted = true;
    } else if (
      character === "#" &&
      (index === 0 || /\s/.test(line[index - 1]))
    ) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

function workflowLine(line) {
  const withoutComment = stripYamlComment(line);
  if (!withoutComment.trim()) return null;

  const prefix = withoutComment.match(/^[ \t]*/)?.[0] ?? "";
  if (prefix.includes("\t")) {
    return { error: "tabs are unsupported in YAML indentation" };
  }
  return {
    indent: prefix.length,
    text: withoutComment.slice(prefix.length),
  };
}

function decodeRestrictedYamlScalar(raw, kind) {
  const scalar = raw.trim();
  if (!scalar) return { error: `empty ${kind}` };

  if (scalar[0] === '"') {
    try {
      const decoded = JSON.parse(scalar);
      if (typeof decoded !== "string") throw new Error("not a string");
      return { value: decoded };
    } catch {
      return {
        error: `${kind} uses unsupported double-quoted YAML escaping`,
      };
    }
  }
  if (scalar[0] === "'") {
    if (scalar.at(-1) !== "'" || scalar.length < 2) {
      return { error: `unterminated single-quoted ${kind}` };
    }
    return { value: scalar.slice(1, -1).replaceAll("''", "'") };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(scalar)) {
    return {
      error: `${kind} must use a plain or quoted scalar without YAML decorators`,
    };
  }
  return { value: scalar };
}

function mappingEntry(source, kind) {
  const match = source.match(
    /^((?:"(?:\\.|[^"\\])*")|(?:'(?:''|[^'])*')|(?:[A-Za-z_][A-Za-z0-9_-]*)|<<)\s*:\s*(.*)$/,
  );
  if (!match) {
    return {
      error: `${kind} must use an undecorated block mapping key`,
    };
  }
  if (match[1] === "<<") {
    return {
      error: `${kind} cannot use YAML merge keys or aliases`,
    };
  }
  const decoded = decodeRestrictedYamlScalar(match[1], `${kind} key`);
  if (decoded.error) return decoded;
  return { key: decoded.value, value: match[2].trim() };
}

function defaultRunExecutionFailures(
  relativeFile,
  lines,
  property,
  end,
  owner,
  expectedWorkingDirectory,
) {
  const failures = [];
  if (property.value) {
    failures.push(
      `${relativeFile}:${property.index + 1}: ${owner} defaults must use a canonical block mapping`,
    );
    return failures;
  }

  let run = null;
  for (let index = property.index + 1; index < end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent <= property.indent) break;
    if (line.indent !== property.indent + 2) continue;
    const entry = mappingEntry(line.text, `${owner} defaults property`);
    if (entry.error || entry.key !== "run" || run) {
      failures.push(
        `${relativeFile}:${index + 1}: ${owner} defaults may contain exactly one canonical run mapping`,
      );
      continue;
    }
    run = {
      index,
      indent: line.indent,
      value: entry.value,
    };
  }

  if (!run || run.value) {
    failures.push(
      `${relativeFile}:${property.index + 1}: ${owner} defaults.run must use a canonical block mapping`,
    );
    return failures;
  }

  const runProperties = new Map();
  for (let index = run.index + 1; index < end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent <= run.indent) break;
    if (line.indent !== run.indent + 2) {
      failures.push(
        `${relativeFile}:${index + 1}: ${owner} defaults.run must use canonical indentation`,
      );
      continue;
    }
    const entry = mappingEntry(line.text, `${owner} defaults.run property`);
    if (
      entry.error ||
      !["shell", "working-directory"].includes(entry.key) ||
      runProperties.has(entry.key)
    ) {
      failures.push(
        `${relativeFile}:${index + 1}: ${owner} defaults.run contains an unsupported or duplicate property`,
      );
      continue;
    }
    runProperties.set(entry.key, { index, value: entry.value });
  }

  const shell = runProperties.get("shell");
  if (shell && shell.value !== "bash") {
    failures.push(
      `${relativeFile}:${shell.index + 1}: ${owner} defaults.run.shell must be exactly bash`,
    );
  }
  const workingDirectory = runProperties.get("working-directory");
  if ((workingDirectory?.value ?? undefined) !== expectedWorkingDirectory) {
    failures.push(
      `${relativeFile}:${(workingDirectory?.index ?? property.index) + 1}: ${owner} defaults.run.working-directory differs from its exact reviewed value`,
    );
  }
  return failures;
}

function parseGateNeeds(lines, needsIndex, needsIndent) {
  const source = workflowLine(lines[needsIndex]);
  const entry = mappingEntry(source.text, "gate needs");
  const raw = entry.value;
  const values = [];

  if (raw) {
    let scalars;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inside = raw.slice(1, -1).trim();
      scalars = inside ? inside.split(",") : [];
    } else {
      scalars = [raw];
    }
    for (const scalar of scalars) {
      const decoded = decodeRestrictedYamlScalar(scalar, "gate dependency");
      if (decoded.error) return { error: decoded.error };
      values.push(decoded.value);
    }
  } else {
    let itemIndent = null;
    for (let index = needsIndex + 1; index < lines.length; index += 1) {
      const line = workflowLine(lines[index]);
      if (!line) continue;
      if (line.error) return { error: line.error };
      if (line.indent <= needsIndent) break;
      if (itemIndent === null) itemIndent = line.indent;
      if (line.indent !== itemIndent || !line.text.startsWith("- ")) {
        return {
          error: "gate needs must be a scalar list without YAML decorators",
        };
      }
      const decoded = decodeRestrictedYamlScalar(
        line.text.slice(2),
        "gate dependency",
      );
      if (decoded.error) return { error: decoded.error };
      values.push(decoded.value);
    }
  }

  if (!values.length) return { error: "gate needs must not be empty" };
  if (new Set(values).size !== values.length) {
    return { error: "gate needs contains duplicate dependencies" };
  }
  return { values };
}

function blockScalarCommands(lines, property, end) {
  if (property.value && !/^[|>][+-]?[1-9]?$/.test(property.value)) {
    return [property.value];
  }
  const commands = [];
  for (let index = property.index + 1; index < end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error || line.indent <= property.indent) break;
    if (!line.text.trimStart().startsWith("#")) commands.push(line.text.trim());
  }
  return commands;
}

function policyJobSteps(relativeFile, lines, job, failures, label) {
  const stepsProperty = job.properties.get("steps");
  if (!stepsProperty || stepsProperty.value) {
    failures.push(
      `${relativeFile}:${job.start + 1}: ${label} steps must use a block sequence`,
    );
    return [];
  }

  const firstStepLine = lines
    .slice(stepsProperty.index + 1, job.end)
    .map((line, offset) => ({
      index: stepsProperty.index + 1 + offset,
      line: workflowLine(line),
    }))
    .find(({ line }) => line && !line.error);
  if (
    !firstStepLine ||
    firstStepLine.line.indent !== 6 ||
    !firstStepLine.line.text.startsWith("- ")
  ) {
    failures.push(
      `${relativeFile}:${stepsProperty.index + 1}: ${label} steps must begin with a canonical block-sequence entry`,
    );
    return [];
  }

  const steps = [];
  for (let index = stepsProperty.index + 1; index < job.end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line || line.error || line.indent !== 6) continue;
    if (!line.text.startsWith("- ")) {
      failures.push(
        `${relativeFile}:${index + 1}: ${label} steps must use canonical block-sequence entries`,
      );
      continue;
    }
    const entry = mappingEntry(line.text.slice(2), `${label} step`);
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
      continue;
    }
    const step = { start: index, properties: new Map() };
    step.properties.set(entry.key, {
      index,
      indent: 6,
      value: entry.value,
    });
    steps.push(step);
  }

  for (const [position, step] of steps.entries()) {
    step.end = steps[position + 1]?.start ?? job.end;
    for (let index = step.start + 1; index < step.end; index += 1) {
      const line = workflowLine(lines[index]);
      if (!line || line.error || line.indent !== 8) continue;
      const entry = mappingEntry(line.text, `${label} step property`);
      if (entry.error) {
        failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
        continue;
      }
      if (step.properties.has(entry.key)) {
        failures.push(
          `${relativeFile}:${index + 1}: duplicate ${entry.key} property on ${label} step`,
        );
        continue;
      }
      step.properties.set(entry.key, {
        index,
        indent: 8,
        value: entry.value,
      });
    }
  }
  return steps;
}

function requiredContainerInjectionFailures(relativeFile, lines, job) {
  const failures = [];
  const container = job.properties.get("container");
  if (!container) return failures;
  if (container.value) {
    failures.push(
      `${relativeFile}:${container.index + 1}: required job ${job.id} container must use a canonical block mapping`,
    );
    return failures;
  }

  for (let index = container.index + 1; index < job.end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent <= container.indent) break;
    if (line.indent !== container.indent + 2) continue;
    const entry = mappingEntry(
      line.text,
      `required job ${job.id} container property`,
    );
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
    } else if (["env", "options"].includes(entry.key)) {
      failures.push(
        `${relativeFile}:${index + 1}: required job ${job.id} container cannot inject environment or runtime options`,
      );
    }
  }
  return failures;
}

function requiredJobExecutionFailures(relativeFile, lines, job) {
  const failures = [];
  const requiredMainWorkflow =
    relativeFile.split(path.sep).join("/") === REQUIRED_WORKFLOW_PATH;
  const defaults = job.properties.get("defaults");
  const expectedDefaultWorkingDirectory = requiredMainWorkflow
    ? REQUIRED_JOB_DEFAULT_WORKING_DIRECTORIES.get(job.id)
    : undefined;
  if (defaults) {
    failures.push(
      ...defaultRunExecutionFailures(
        relativeFile,
        lines,
        defaults,
        job.end,
        `required job ${job.id}`,
        expectedDefaultWorkingDirectory,
      ),
    );
  } else if (expectedDefaultWorkingDirectory !== undefined) {
    failures.push(
      `${relativeFile}:${job.start + 1}: required job ${job.id} defaults.run.working-directory differs from its exact reviewed value`,
    );
  }
  const jobEnvironment = job.properties.get("env");
  const expectedJobEnvironment = requiredMainWorkflow
    ? (REQUIRED_JOB_ENVIRONMENTS.get(job.id) ?? new Map())
    : new Map();
  if (jobEnvironment) {
    const actual = environmentMap(
      relativeFile,
      lines,
      jobEnvironment,
      job.end,
      failures,
      `required job ${job.id}`,
    );
    failures.push(
      ...exactEnvironmentFailures(
        relativeFile,
        jobEnvironment.index,
        actual,
        expectedJobEnvironment,
        `required job ${job.id}`,
      ),
    );
  } else if (expectedJobEnvironment.size) {
    failures.push(
      `${relativeFile}:${job.start + 1}: required job ${job.id} environment differs from its exact reviewed allowlist`,
    );
  }
  failures.push(
    ...requiredContainerInjectionFailures(relativeFile, lines, job),
  );

  if (!job.properties.has("steps")) return failures;
  const steps = policyJobSteps(
    relativeFile,
    lines,
    job,
    failures,
    `required job ${job.id}`,
  );
  for (const step of steps) {
    const shell = step.properties.get("shell");
    if (shell && shell.value !== "bash") {
      failures.push(
        `${relativeFile}:${shell.index + 1}: required job ${job.id} step shell must be exactly bash`,
      );
    }
    const stepEnvironmentProperty = step.properties.get("env");
    const stepName = step.properties.get("name")?.value ?? "";
    const stepScope = `${job.id}\0${stepName}`;
    const expectedStepEnvironment = requiredMainWorkflow
      ? (REQUIRED_STEP_ENVIRONMENTS.get(stepScope) ?? new Map())
      : new Map();
    if (stepEnvironmentProperty) {
      const actual = environmentMap(
        relativeFile,
        lines,
        stepEnvironmentProperty,
        step.end,
        failures,
        `required job ${job.id} step`,
      );
      failures.push(
        ...exactEnvironmentFailures(
          relativeFile,
          stepEnvironmentProperty.index,
          actual,
          expectedStepEnvironment,
          `required job ${job.id} step ${stepName || "<unnamed>"}`,
        ),
      );
    } else if (expectedStepEnvironment.size) {
      failures.push(
        `${relativeFile}:${step.start + 1}: required job ${job.id} step ${stepName || "<unnamed>"} environment differs from its exact reviewed allowlist`,
      );
    }
    const workingDirectory = step.properties.get("working-directory");
    const expectedWorkingDirectory = requiredMainWorkflow
      ? REQUIRED_STEP_WORKING_DIRECTORIES.get(stepScope)
      : undefined;
    if ((workingDirectory?.value ?? undefined) !== expectedWorkingDirectory) {
      failures.push(
        `${relativeFile}:${(workingDirectory?.index ?? step.start) + 1}: required job ${job.id} step ${stepName || "<unnamed>"} working-directory differs from its exact reviewed value`,
      );
    }
  }
  return failures;
}

function environmentMap(relativeFile, lines, property, end, failures, owner) {
  const environment = new Map();
  if (property.value) {
    failures.push(
      `${relativeFile}:${property.index + 1}: ${owner} environment must use a canonical block mapping`,
    );
    return environment;
  }

  for (let index = property.index + 1; index < end; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent <= property.indent) break;
    if (line.indent !== property.indent + 2) {
      failures.push(
        `${relativeFile}:${index + 1}: ${owner} environment must use canonical indentation`,
      );
      continue;
    }
    const entry = mappingEntry(line.text, `${owner} environment`);
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
      continue;
    }
    if (environment.has(entry.key)) {
      failures.push(
        `${relativeFile}:${index + 1}: duplicate ${owner} environment key ${entry.key}`,
      );
    } else {
      environment.set(entry.key, entry.value);
    }
  }
  return environment;
}

function stepEnvironment(relativeFile, lines, step, failures) {
  const property = step.properties.get("env");
  if (!property) return new Map();
  return environmentMap(
    relativeFile,
    lines,
    property,
    step.end,
    failures,
    "gate verdict",
  );
}

function exactEnvironmentFailures(
  relativeFile,
  location,
  actual,
  expected,
  owner,
) {
  const failures = [];
  if (
    actual.size !== expected.size ||
    [...expected].some(([key, value]) => actual.get(key) !== value)
  ) {
    failures.push(
      `${relativeFile}:${location + 1}: ${owner} environment differs from its exact reviewed allowlist`,
    );
  }
  return failures;
}

function hasExactKeys(map, keys) {
  return map.size === keys.length && keys.every((key) => map.has(key));
}

function requiredGateControlFailures(relativeFile, lines, gate) {
  const failures = [];
  const steps = policyJobSteps(relativeFile, lines, gate, failures, "gate");
  if (steps.length !== 3) {
    failures.push(
      `${relativeFile}:${gate.start + 1}: gate must contain exactly checkout, policy recheck, and enforcing verdict steps`,
    );
    return failures;
  }

  const [checkout, policy, verdict] = steps;
  if (
    !hasExactKeys(checkout.properties, ["uses"]) ||
    checkout.properties.get("uses")?.value !== GATE_CHECKOUT_REFERENCE
  ) {
    failures.push(
      `${relativeFile}:${checkout.start + 1}: gate checkout must be exact, current-source, and unconditional`,
    );
  }

  const policyCommands = blockScalarCommands(
    lines,
    policy.properties.get("run") ?? {
      index: policy.start,
      indent: 8,
      value: "",
    },
    policy.end,
  );
  if (
    !hasExactKeys(policy.properties, ["name", "id", "run"]) ||
    policy.properties.get("name")?.value !==
      "Recheck immutable actions and fail-closed required jobs" ||
    policy.properties.get("id")?.value !== "policy" ||
    policy.properties.get("run")?.value !== "|" ||
    policyCommands.length !== 4 ||
    policyCommands[0] !== GATE_POLICY_SELF_TEST_COMMAND ||
    policyCommands[1] !== GATE_POLICY_COMMAND ||
    policyCommands[2] !== WORKFLOW_GATES_SELF_TEST_COMMAND ||
    policyCommands[3] !== WORKFLOW_GATES_COMMAND
  ) {
    failures.push(
      `${relativeFile}:${policy.start + 1}: gate policy recheck must be exact, unconditional, and non-soft-failing`,
    );
  }

  const verdictEnvironment = stepEnvironment(
    relativeFile,
    lines,
    verdict,
    failures,
  );
  const verdictCommands = blockScalarCommands(
    lines,
    verdict.properties.get("run") ?? {
      index: verdict.start,
      indent: 8,
      value: "",
    },
    verdict.end,
  );
  if (
    !hasExactKeys(verdict.properties, ["name", "env", "run"]) ||
    verdict.properties.get("name")?.value !==
      "Verify required jobs succeeded or legitimately skipped" ||
    verdict.properties.get("run")?.value !== "|" ||
    !hasExactKeys(verdictEnvironment, [
      "POLICY_OUTCOME",
      "REQUIRED_JOBS_JSON",
    ]) ||
    verdictEnvironment.get("POLICY_OUTCOME") !==
      "${{ steps.policy.outcome }}" ||
    verdictEnvironment.get("REQUIRED_JOBS_JSON") !== "${{ toJSON(needs) }}" ||
    verdictCommands.length !== 2 ||
    verdictCommands[0] !== GATE_POLICY_COMMAND ||
    verdictCommands[1] !== GATE_VERDICT_COMMAND
  ) {
    failures.push(
      `${relativeFile}:${verdict.start + 1}: gate verdict must unconditionally recheck policy and enforce the complete needs context`,
    );
  }
  return failures;
}

function requiredChangesControlFailures(relativeFile, lines, changes) {
  const failures = [];
  const steps = policyJobSteps(
    relativeFile,
    lines,
    changes,
    failures,
    "changes",
  );
  const policySteps = steps.filter(
    (step) =>
      step.properties.get("name")?.value ===
      "Verify immutable actions and fail-closed required jobs",
  );
  if (policySteps.length !== 1) {
    failures.push(
      `${relativeFile}:${changes.start + 1}: changes must contain exactly one immutable-actions policy step`,
    );
    return failures;
  }

  const [policy] = policySteps;
  const commands = blockScalarCommands(
    lines,
    policy.properties.get("run") ?? {
      index: policy.start,
      indent: 8,
      value: "",
    },
    policy.end,
  );
  if (
    !hasExactKeys(policy.properties, ["name", "run"]) ||
    policy.properties.get("run")?.value !== "|" ||
    commands.length !== 6 ||
    commands[0] !== GATE_POLICY_SELF_TEST_COMMAND ||
    commands[1] !== GATE_POLICY_COMMAND ||
    commands[2] !== WORKFLOW_GATES_SELF_TEST_COMMAND ||
    commands[3] !== WORKFLOW_GATES_COMMAND ||
    commands[4] !== LIBRUSTZCASH_POLICY_SELF_TEST_COMMAND ||
    commands[5] !== LIBRUSTZCASH_POLICY_COMMAND
  ) {
    failures.push(
      `${relativeFile}:${policy.start + 1}: changes policy step must exactly self-test and enforce the current-source policy`,
    );
  }

  const wasmPolicySteps = steps.filter(
    (step) =>
      step.properties.get("name")?.value ===
      "Verify the required Rust/WASM build boundary",
  );
  if (wasmPolicySteps.length !== 1) {
    failures.push(
      `${relativeFile}:${changes.start + 1}: changes must contain exactly one Rust/WASM boundary policy step`,
    );
    return failures;
  }
  const [wasmPolicy] = wasmPolicySteps;
  const wasmCommands = blockScalarCommands(
    lines,
    wasmPolicy.properties.get("run") ?? {
      index: wasmPolicy.start,
      indent: 8,
      value: "",
    },
    wasmPolicy.end,
  );
  if (
    !hasExactKeys(wasmPolicy.properties, ["name", "run"]) ||
    wasmPolicy.properties.get("run")?.value !== "|" ||
    wasmCommands.length !== 2 ||
    wasmCommands[0] !== WASM_POLICY_SELF_TEST_COMMAND ||
    wasmCommands[1] !== WASM_POLICY_COMMAND
  ) {
    failures.push(
      `${relativeFile}:${wasmPolicy.start + 1}: changes WASM policy step must exactly self-test and enforce the current-source boundary`,
    );
  }
  return failures;
}

function exactStepSource(lines, step) {
  const source = lines.slice(step.start, step.end);
  while (
    source.length > 1 &&
    (!source.at(-1).trim() || source.at(-1).trimStart().startsWith("#"))
  ) {
    source.pop();
  }
  return source.join("\n").trimEnd();
}

function requiredFrontendWasmControlFailures(relativeFile, lines, frontend) {
  const failures = [];
  const actualFrontendJobLines = lines
    .slice(frontend.start, frontend.end)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .map((line) => line.trimEnd());
  if (
    JSON.stringify(actualFrontendJobLines) !==
    JSON.stringify(REQUIRED_FRONTEND_JOB_LINES)
  ) {
    failures.push(
      `${relativeFile}:${frontend.start + 1}: frontend must match the complete exact current-source execution program`,
    );
  }
  if (
    frontend.properties.get("if")?.value !==
    "needs.changes.outputs.zuuli == 'true'"
  ) {
    failures.push(
      `${relativeFile}:${frontend.start + 1}: frontend must run exactly when the fail-closed ZUULI selector is true`,
    );
  }
  const steps = policyJobSteps(
    relativeFile,
    lines,
    frontend,
    failures,
    "frontend",
  );
  const exactNamedStep = (name, expected, message) => {
    const matches = steps.filter(
      (step) => step.properties.get("name")?.value === name,
    );
    if (
      matches.length !== 1 ||
      exactStepSource(lines, matches[0]) !== expected
    ) {
      failures.push(`${relativeFile}:${frontend.start + 1}: ${message}`);
    }
  };

  const checkouts = steps.filter(
    (step) =>
      step.properties.get("uses")?.value === FRONTEND_CHECKOUT_REFERENCE,
  );
  if (
    checkouts.length !== 1 ||
    exactStepSource(lines, checkouts[0]) !==
      `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1`
  ) {
    failures.push(
      `${relativeFile}:${frontend.start + 1}: frontend must have one exact current-source checkout without a ref override`,
    );
  }

  exactNamedStep(
    "Resolve the pinned frontend Rust toolchain",
    [
      "      - name: Resolve the pinned frontend Rust toolchain",
      "        id: frontend_rust_toolchain",
      "        run: |",
      "          set -euo pipefail",
      "          version=$(../../scripts/check-rust-toolchain.sh --print-channel)",
      '          echo "version=$version" >> "$GITHUB_OUTPUT"',
    ].join("\n"),
    "frontend Rust resolution must be exact, source-derived, unconditional, and non-decorative",
  );
  exactNamedStep(
    "Install the pinned Rust/WASM compiler",
    [
      "      - name: Install the pinned Rust/WASM compiler",
      "        uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable",
      "        with:",
      "          toolchain: ${{ steps.frontend_rust_toolchain.outputs.version }}",
      "          targets: wasm32-unknown-unknown",
    ].join("\n"),
    "frontend Rust/WASM installation must be exact, pinned, unconditional, and non-decorative",
  );
  exactNamedStep(
    "Verify RTL source policy",
    [
      "      - name: Verify RTL source policy",
      "        run: |",
      "          node --test scripts/rtl-source-policy.node-test.mjs",
      "          node scripts/rtl-source-policy.mjs",
    ].join("\n"),
    "RTL source policy must be self-tested and enforced exactly",
  );
  exactNamedStep(
    "Test frontend contracts",
    [
      "      - name: Test frontend contracts",
      "        run: |",
      "          npm run test",
      "          npm --prefix ../zuuallet run test:sensitive-entry",
    ].join("\n"),
    "frontend tests must invoke the exact package contract unconditionally",
  );
  exactNamedStep(
    "Build production frontend",
    [
      "      - name: Build production frontend",
      "        run: npm run build",
    ].join("\n"),
    "frontend production build must invoke the exact package contract unconditionally",
  );
  return failures;
}

function requiredWasmSelectorFailures(relativeFile, lines, changes) {
  const failures = [];
  const steps = policyJobSteps(
    relativeFile,
    lines,
    changes,
    failures,
    "changes",
  );
  const detectors = steps.filter(
    (step) =>
      step.properties.get("name")?.value ===
      "Detect release-impacting ZUULI changes",
  );
  if (detectors.length !== 1) {
    failures.push(
      `${relativeFile}:${changes.start + 1}: the ZUULI selector step is missing`,
    );
    return failures;
  }
  const source = exactStepSource(lines, detectors[0]);
  const zuuliPatternSets = source
    .split("\n")
    .map((line) => line.split("#", 1)[0].trim())
    .filter((line) => line.endsWith(")"))
    .map((line) => new Set(line.slice(0, -1).split("|")))
    .filter((patterns) => patterns.has("wallet/zuuli/*"));
  if (zuuliPatternSets.length !== 1) {
    failures.push(
      `${relativeFile}:${detectors[0].start + 1}: ZUULI selector must contain one active wallet/zuuli/* case pattern`,
    );
    return failures;
  }
  const [zuuliPatterns] = zuuliPatternSets;
  for (const pattern of [
    "wallet/rust-toolchain.toml",
    "scripts/check-rust-toolchain.sh",
    "scripts/check-github-actions-pins.mjs",
    "scripts/check-librustzcash-compat.mjs",
    ".github/workflows/zuuli.yml",
  ]) {
    if (!zuuliPatterns.has(pattern)) {
      failures.push(
        `${relativeFile}:${detectors[0].start + 1}: ZUULI selector must cover ${pattern}`,
      );
    }
  }
  for (const input of REQUIRED_CLASSIC_SEED_BOUNDARY_INPUTS) {
    if (!zuuliPatterns.has(input)) {
      failures.push(
        `${relativeFile}:${detectors[0].start + 1}: ZUULI selector must run the seed boundary for classic input ${input}`,
      );
    }
  }
  const schemaPatternSets = source
    .split("\n")
    .map((line) => line.split("#", 1)[0].trim())
    .filter((line) => line.endsWith(")"))
    .map((line) => new Set(line.slice(0, -1).split("|")))
    .filter((patterns) => patterns.has("wallet/zuuallet/src-tauri/*"));
  if (
    schemaPatternSets.length !== 1 ||
    !schemaPatternSets[0].has("scripts/check-librustzcash-compat.mjs")
  ) {
    failures.push(
      `${relativeFile}:${detectors[0].start + 1}: Zuuallet schema selector must cover scripts/check-librustzcash-compat.mjs`,
    );
  }
  return failures;
}

function policyWorkflowJobs(relativeFile, lines, failures) {
  const topLevel = [];
  const workflowDefaults = [];
  const workflowEnvironments = [];

  for (const [index, rawLine] of lines.entries()) {
    const line = workflowLine(rawLine);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent !== 0 || line.text === "---") continue;
    const entry = mappingEntry(line.text, "top-level workflow property");
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
    } else if (entry.key === "jobs") {
      topLevel.push({ index, value: entry.value });
    } else if (entry.key === "defaults") {
      workflowDefaults.push({ index, indent: 0, value: entry.value });
    } else if (entry.key === "env") {
      workflowEnvironments.push({ index, indent: 0, value: entry.value });
    }
  }

  if (workflowDefaults.length > 1) {
    failures.push(`${relativeFile}: required workflow cannot repeat defaults`);
  }
  for (const defaults of workflowDefaults) {
    failures.push(
      ...defaultRunExecutionFailures(
        relativeFile,
        lines,
        defaults,
        lines.length,
        "required workflow",
        undefined,
      ),
    );
  }
  if (workflowEnvironments.length > 1) {
    failures.push(`${relativeFile}: required workflow cannot repeat env`);
  }
  const normalizedRelativeFile = relativeFile.split(path.sep).join("/");
  const expectedWorkflowEnvironment = [
    REQUIRED_WORKFLOW_PATH,
    ".github/workflows/rs.yml",
  ].includes(normalizedRelativeFile)
    ? REQUIRED_WORKFLOW_ENVIRONMENT
    : new Map();
  for (const environment of workflowEnvironments) {
    const actual = environmentMap(
      relativeFile,
      lines,
      environment,
      lines.length,
      failures,
      "required workflow",
    );
    failures.push(
      ...exactEnvironmentFailures(
        relativeFile,
        environment.index,
        actual,
        expectedWorkflowEnvironment,
        "required workflow",
      ),
    );
  }
  if (!workflowEnvironments.length && expectedWorkflowEnvironment.size) {
    failures.push(
      `${relativeFile}: required workflow environment differs from its exact reviewed allowlist`,
    );
  }

  if (!topLevel.length) {
    failures.push(
      `${relativeFile}: required workflow must contain a jobs block mapping`,
    );
    return new Map();
  }
  if (topLevel.length !== 1) {
    failures.push(
      `${relativeFile}: workflow must contain exactly one jobs mapping`,
    );
    return new Map();
  }
  const jobsEntry = topLevel[0];
  if (jobsEntry.value) {
    failures.push(
      `${relativeFile}:${jobsEntry.index + 1}: jobs must use a block mapping so required-gate policy can inspect it`,
    );
    return new Map();
  }

  let jobsEnd = lines.length;
  for (let index = jobsEntry.index + 1; index < lines.length; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) continue;
    if (line.indent === 0) {
      jobsEnd = index;
      break;
    }
  }

  const firstJobLine = lines
    .slice(jobsEntry.index + 1, jobsEnd)
    .map((line) => workflowLine(line))
    .find((line) => line && !line.error);
  if (!firstJobLine || firstJobLine.indent !== 2) {
    failures.push(
      `${relativeFile}:${jobsEntry.index + 1}: jobs must use canonical two-space block indentation`,
    );
  }

  const jobs = new Map();
  for (let index = jobsEntry.index + 1; index < jobsEnd; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line || line.error || line.indent !== 2) continue;
    const entry = mappingEntry(line.text, "job definition");
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
      continue;
    }
    if (entry.value) {
      failures.push(
        `${relativeFile}:${index + 1}: job ${entry.key} must use a block mapping; ` +
          "inline maps, aliases, and decorated job values are unsupported",
      );
      continue;
    }
    if (jobs.has(entry.key)) {
      failures.push(
        `${relativeFile}:${index + 1}: duplicate job definition: ${entry.key}`,
      );
      continue;
    }
    jobs.set(entry.key, { id: entry.key, start: index, properties: new Map() });
  }

  const orderedJobs = [...jobs.values()].sort(
    (left, right) => left.start - right.start,
  );
  for (const [position, job] of orderedJobs.entries()) {
    job.end = orderedJobs[position + 1]?.start ?? jobsEnd;
    const firstProperty = lines
      .slice(job.start + 1, job.end)
      .map((line) => workflowLine(line))
      .find((line) => line && !line.error);
    if (!firstProperty || firstProperty.indent !== 4) {
      failures.push(
        `${relativeFile}:${job.start + 1}: job ${job.id} must use canonical four-space property indentation`,
      );
    }
    for (let index = job.start + 1; index < job.end; index += 1) {
      const line = workflowLine(lines[index]);
      if (!line || line.error || line.indent !== 4) continue;
      const entry = mappingEntry(line.text, `job ${job.id} property`);
      if (entry.error) {
        failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
        continue;
      }
      if (job.properties.has(entry.key)) {
        failures.push(
          `${relativeFile}:${index + 1}: duplicate ${entry.key} property on job ${job.id}`,
        );
        continue;
      }
      job.properties.set(entry.key, {
        index,
        indent: 4,
        value: entry.value,
      });
    }
  }

  return jobs;
}

// Read one canonical block mapping below a job property. Required selector
// outputs are a security boundary: checking the step body alone is circular if
// the job publishes a different key, reads a different step id, or drops an
// output that downstream `if:` expressions consume.
function policyBlockMapping(
  relativeFile,
  lines,
  property,
  containerEnd,
  failures,
  label,
) {
  const entries = new Map();
  if (!property || property.value) {
    failures.push(
      `${relativeFile}:${(property?.index ?? 0) + 1}: ${label} must use a block mapping`,
    );
    return entries;
  }
  for (let index = property.index + 1; index < containerEnd; index += 1) {
    const line = workflowLine(lines[index]);
    if (!line) continue;
    if (line.error) {
      failures.push(`${relativeFile}:${index + 1}: ${line.error}`);
      continue;
    }
    if (line.indent <= property.indent) break;
    if (line.indent !== property.indent + 2) {
      failures.push(
        `${relativeFile}:${index + 1}: ${label} must use canonical ${property.indent + 2}-space entry indentation`,
      );
      continue;
    }
    const entry = mappingEntry(line.text, `${label} entry`);
    if (entry.error) {
      failures.push(`${relativeFile}:${index + 1}: ${entry.error}`);
      continue;
    }
    if (entries.has(entry.key)) {
      failures.push(
        `${relativeFile}:${index + 1}: duplicate ${label} entry ${entry.key}`,
      );
      continue;
    }
    entries.set(entry.key, entry.value);
  }
  return entries;
}

const rustRootSelectorProbeCache = new Map();
const rustRootSelectorProbeDirectories = new Set();
process.on("exit", () => {
  for (const directory of rustRootSelectorProbeDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runSelectorProbeGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "selector-probe@example.invalid",
      GIT_AUTHOR_NAME: "Rust root selector probe",
      GIT_COMMITTER_EMAIL: "selector-probe@example.invalid",
      GIT_COMMITTER_NAME: "Rust root selector probe",
      HOME: cwd,
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr?.trim() || `status ${result.status}`}`,
    );
  }
  return result.stdout.trim();
}

function rustRootSelectorProbeFixture(probePath) {
  if (rustRootSelectorProbeCache.has(probePath)) {
    return rustRootSelectorProbeCache.get(probePath);
  }

  const repo = fs.mkdtempSync(
    path.join(os.tmpdir(), "rust-root-selector-git-"),
  );
  rustRootSelectorProbeDirectories.add(repo);
  runSelectorProbeGit(repo, ["init", "--quiet"]);
  runSelectorProbeGit(repo, [
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "base",
  ]);
  const base = runSelectorProbeGit(repo, ["rev-parse", "HEAD"]);
  writeFixture(repo, probePath, "selector probe\n");
  runSelectorProbeGit(repo, ["add", "--", probePath]);
  runSelectorProbeGit(repo, ["commit", "--quiet", "-m", "head"]);
  const head = runSelectorProbeGit(repo, ["rev-parse", "HEAD"]);
  const fixture = { base, head, repo };
  rustRootSelectorProbeCache.set(probePath, fixture);
  return fixture;
}

// GitHub applies the last assignment to a step output. Looking for any earlier
// `name=true` line lets a later `name=false` silently skip every guarded job.
// Parse both simple and heredoc output records and return the effective value.
function effectiveGithubOutput(outputFile, name) {
  if (!fs.existsSync(outputFile)) return undefined;
  const lines = fs.readFileSync(outputFile, "utf8").split(/\r?\n/);
  let effective;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const simplePrefix = `${name}=`;
    const heredocPrefix = `${name}<<`;
    if (line.startsWith(simplePrefix)) {
      effective = line.slice(simplePrefix.length);
      continue;
    }
    if (!line.startsWith(heredocPrefix)) continue;
    const delimiter = line.slice(heredocPrefix.length);
    const value = [];
    index += 1;
    while (index < lines.length && lines[index] !== delimiter) {
      value.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) effective = value.join("\n");
  }
  return effective;
}

function executeRustRootSelector(
  body,
  fixture,
  contract,
  head,
  base = fixture.base,
) {
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rust-root-selector-output-"),
  );
  const outputFile = path.join(outputDirectory, "github-output");
  try {
    const result = spawnSync("/bin/bash", ["-c", body], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: {
        BASE_SHA: base,
        GITHUB_SHA: head,
        GITHUB_OUTPUT: outputFile,
        HOME: fixture.repo,
        PATH: "/usr/bin:/bin",
        RUNNER_TEMP: outputDirectory,
      },
    });
    return {
      effective: new Map(
        contract.selectorOutputs.map(({ name }) => [
          name,
          effectiveGithubOutput(outputFile, name),
        ]),
      ),
      status: result.status,
    };
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

function rustRootWorkflowFailures(relativeFile, lines, contract) {
  const failures = [];
  const jobs = policyWorkflowJobs(relativeFile, lines, failures);
  const changes = jobs.get("changes");
  if (!changes) {
    failures.push(
      `${relativeFile}: ${contract.root}/ owner must contain changes`,
    );
    return failures;
  }

  const publishedOutputs = policyBlockMapping(
    relativeFile,
    lines,
    changes.properties.get("outputs"),
    changes.end,
    failures,
    `${contract.root}/ changes outputs`,
  );
  const expectedOutputs = new Map(
    contract.selectorOutputs.map(({ name }) => [
      name,
      "${{ steps." + contract.selectorId + ".outputs." + name + " }}",
    ]),
  );
  if (
    publishedOutputs.size !== expectedOutputs.size ||
    [...expectedOutputs].some(
      ([name, expression]) => publishedOutputs.get(name) !== expression,
    )
  ) {
    failures.push(
      `${relativeFile}:${changes.start + 1}: ${contract.root}/ changes must publish exactly ${[...expectedOutputs].map(([name, expression]) => `${name}: ${expression}`).join(", ")}`,
    );
  }

  const changeSteps = policyJobSteps(
    relativeFile,
    lines,
    changes,
    failures,
    `${contract.root} root owner changes`,
  );
  const toolchainSteps = changeSteps.filter(
    (step) =>
      step.properties.get("name")?.value ===
      "Verify the Rust toolchain pin has not drifted",
  );
  const toolchain = toolchainSteps[0];
  const toolchainRun = toolchain?.properties.get("run");
  const toolchainCommands = toolchainRun
    ? blockScalarCommands(lines, toolchainRun, toolchain.end)
    : [];
  if (
    toolchainSteps.length !== 1 ||
    !hasExactKeys(toolchain?.properties ?? new Map(), ["name", "run"]) ||
    toolchainRun?.value !== "|" ||
    JSON.stringify(toolchainCommands) !==
      JSON.stringify([
        "scripts/check-rust-toolchain.sh --self-test",
        "scripts/check-rust-toolchain.sh",
      ])
  ) {
    failures.push(
      `${relativeFile}:${changes.start + 1}: ${contract.root}/ owner must run one unconditional, non-soft-failing toolchain self-test and live verdict`,
    );
  }

  const selectorSteps = changeSteps.filter(
    (step) => step.properties.get("name")?.value === contract.selectorStep,
  );
  const selector = selectorSteps[0];
  const selectorRun = selector?.properties.get("run");
  if (
    selectorSteps.length !== 1 ||
    !hasExactKeys(selector?.properties ?? new Map(), [
      "name",
      "id",
      "shell",
      "env",
      "run",
    ]) ||
    selector?.properties.get("id")?.value !== contract.selectorId ||
    selectorRun?.value !== "|"
  ) {
    failures.push(
      `${relativeFile}:${changes.start + 1}: ${contract.root}/ owner must retain one live, non-soft-failing selector step`,
    );
  } else {
    const body = lines.slice(selectorRun.index + 1, selector.end).join("\n");
    const selectorArms = [
      ...body.matchAll(
        /^\s*case "\$file" in\s*\n\s*([^\n)]+)\)\s*\n\s*([A-Za-z0-9_]+)=true\s*\n\s*;;\s*\n\s*esac\s*$/gm,
      ),
    ].filter((match) => match[2] === contract.selectorOutput);
    if (selectorArms.length !== 1) {
      failures.push(
        `${relativeFile}:${selector.start + 1}: ${contract.root}/ owner selector must retain exactly one active arm for ${contract.selectorOutput}`,
      );
    }
    try {
      for (const {
        name,
        probeRoot,
        additionalProbePaths = [],
      } of contract.selectorOutputs) {
        const probePaths = [
          `${probeRoot}/ordinary.rs`,
          `${probeRoot}/space name.rs`,
          `${probeRoot}/tab\tname.rs`,
          `${probeRoot}/newline\nname.rs`,
          `${probeRoot}/back\\slash.rs`,
          `${probeRoot}/-dash.rs`,
          ...additionalProbePaths,
        ];
        for (const probePath of probePaths) {
          const fixture = rustRootSelectorProbeFixture(probePath);
          const result = executeRustRootSelector(
            body,
            fixture,
            contract,
            fixture.head,
          );
          if (
            result.status !== 0 ||
            result.effective.get(name) !== "true"
          ) {
            const subject =
              name === contract.selectorOutput
                ? `${contract.root}/ owner selector`
                : `${contract.root}/ owner selector output ${name}`;
            failures.push(
              `${relativeFile}:${selector.start + 1}: ${subject} must actively select ${JSON.stringify(probePath)} as its effective last value`,
            );
          }
        }
      }
      for (const probePath of contract.excludedProbePaths ?? []) {
        const fixture = rustRootSelectorProbeFixture(probePath);
        const result = executeRustRootSelector(
          body,
          fixture,
          contract,
          fixture.head,
        );
        for (const { name } of contract.selectorOutputs) {
          if (result.status !== 0 || result.effective.get(name) !== "false") {
            failures.push(
              `${relativeFile}:${selector.start + 1}: ${contract.root}/ owner selector must leave ${name} false for unrelated input ${JSON.stringify(probePath)}`,
            );
          }
        }
      }
      const fixture = rustRootSelectorProbeFixture(
        `${contract.root}/ordinary.rs`,
      );
      const failedDiff = executeRustRootSelector(
        body,
        fixture,
        contract,
        "f".repeat(40),
      );
      for (const { name } of contract.selectorOutputs) {
        if (
          failedDiff.status !== 0 ||
          failedDiff.effective.get(name) !== "true"
        ) {
          const subject =
            name === contract.selectorOutput
              ? `${contract.root}/ owner selector`
              : `${contract.root}/ owner selector output ${name}`;
          failures.push(
            `${relativeFile}:${selector.start + 1}: ${subject} must fail open to its full gate when the real Git diff fails`,
          );
        }
      }
      const unusableBase = executeRustRootSelector(
        body,
        fixture,
        contract,
        fixture.head,
        "not-a-commit-sha",
      );
      for (const { name } of contract.selectorOutputs) {
        if (
          unusableBase.status !== 0 ||
          unusableBase.effective.get(name) !== "true"
        ) {
          const subject =
            name === contract.selectorOutput
              ? `${contract.root}/ owner selector`
              : `${contract.root}/ owner selector output ${name}`;
          failures.push(
            `${relativeFile}:${selector.start + 1}: ${subject} must fail open to its full gate when no usable base commit exists`,
          );
        }
      }
    } catch (error) {
      failures.push(
        `${relativeFile}:${selector.start + 1}: ${contract.root}/ owner selector real-Git probe failed closed: ${error.message}`,
      );
    }
  }

  for (const [jobId, stepName, command] of contract.jobs) {
    const job = jobs.get(jobId);
    if (!job) {
      failures.push(
        `${relativeFile}: ${contract.root}/ owner is missing required job ${jobId}`,
      );
      continue;
    }
    const expectedIf = `needs.changes.outputs.${contract.selectorOutput} == 'true'`;
    if (job.properties.get("if")?.value !== expectedIf) {
      failures.push(
        `${relativeFile}:${job.start + 1}: ${contract.root}/ owner job ${jobId} must run exactly when its root selector is true`,
      );
    }
    if (job.properties.has("continue-on-error")) {
      failures.push(
        `${relativeFile}:${job.start + 1}: ${contract.root}/ owner job ${jobId} cannot soft-fail`,
      );
    }
    const steps = policyJobSteps(
      relativeFile,
      lines,
      job,
      failures,
      `${contract.root} root owner ${jobId}`,
    );
    const verdicts = steps.filter(
      (step) => step.properties.get("name")?.value === stepName,
    );
    const verdict = verdicts[0];
    if (
      verdicts.length !== 1 ||
      !hasExactKeys(verdict?.properties ?? new Map(), ["name", "run"]) ||
      verdict?.properties.get("run")?.value !== command
    ) {
      failures.push(
        `${relativeFile}:${job.start + 1}: ${contract.root}/ owner job ${jobId} must run exactly one unconditional, non-soft-failing ${command}`,
      );
    }
  }

  if (contract.root === "rs") {
    const job = jobs.get("rs_test");
    const steps = job
      ? policyJobSteps(relativeFile, lines, job, failures, "rs AKD evidence owner")
      : [];
    for (const [stepName, command] of [
      ["Mutation-test AKD documentation evidence", "node scripts/check-akd-doc-evidence.mjs --self-test"],
      ["Verify AKD documentation against locked executable evidence", "node scripts/check-akd-doc-evidence.mjs"],
    ]) {
      const matching = steps.filter((step) => step.properties.get("name")?.value === stepName);
      const step = matching[0];
      if (
        matching.length !== 1 ||
        !hasExactKeys(step?.properties ?? new Map(), ["name", "env", "run"]) ||
        stepEnvironment(relativeFile, lines, step, failures).get("GITHUB_TOKEN") !== "${{ github.token }}" ||
        step?.properties.get("run")?.value !== command
      ) {
        failures.push(
          `${relativeFile}:${job?.start + 1 ?? 1}: rs owner job rs_test must run exactly one unconditional, non-soft-failing ${command}`,
        );
      }
    }
  }

  return failures;
}

function rustRootOwnershipFailures(contracts) {
  const failures = [];
  const roots = contracts.map(({ root }) => root);
  const workflows = contracts.map(({ workflow }) => workflow);
  if (
    JSON.stringify([...roots].sort()) !==
    JSON.stringify([...POLICED_RUST_ROOTS].sort())
  ) {
    failures.push(
      `owner registry must cover exactly the policed Rust roots: ${POLICED_RUST_ROOTS.join(", ")}`,
    );
  }
  if (
    new Set(roots).size !== contracts.length ||
    new Set(workflows).size !== contracts.length
  ) {
    failures.push(
      "policed Rust roots and their owning workflows must form a one-to-one mapping",
    );
  }
  return failures;
}

function requiredJobUsesReference(relativeFile, property, failures) {
  const parsed = usesFromLine(`uses: ${property.value}`);
  if (!parsed || parsed.error) {
    failures.push(
      `${relativeFile}:${property.index + 1}: required reusable workflow reference is invalid: ${parsed?.error ?? property.value}`,
    );
    return null;
  }
  return parsed.ref;
}

function requiredReusableWorkflowFailures(
  repoRoot,
  targetFile,
  validated = new Set(),
  active = new Set(),
) {
  const failures = [];
  const canonical = fs.realpathSync(targetFile);
  const relativeFile = path.relative(repoRoot, canonical);
  if (active.has(canonical)) {
    failures.push(
      `${relativeFile}: required reusable workflow cycle is forbidden`,
    );
    return failures;
  }
  if (validated.has(canonical)) return failures;

  active.add(canonical);
  const lines = fs.readFileSync(canonical, "utf8").split(/\r?\n/);
  const jobs = policyWorkflowJobs(relativeFile, lines, failures);
  for (const job of jobs.values()) {
    failures.push(...requiredJobExecutionFailures(relativeFile, lines, job));
    const softFail = job.properties.get("continue-on-error");
    if (softFail) {
      failures.push(
        `${relativeFile}:${softFail.index + 1}: job-level continue-on-error is forbidden in required reusable workflow job ${job.id}`,
      );
    }

    const uses = job.properties.get("uses");
    if (!uses) continue;
    const reference = requiredJobUsesReference(relativeFile, uses, failures);
    if (!reference) continue;
    if (!/^\.\/\.github\/workflows\/[^/]+\.ya?ml$/.test(reference)) {
      failures.push(
        `${relativeFile}:${uses.index + 1}: required reusable workflow job ${job.id} must call a repository-local workflow`,
      );
      continue;
    }
    const target = localTarget(repoRoot, reference);
    if (target.error) {
      failures.push(`${relativeFile}:${uses.index + 1}: ${target.error}`);
      continue;
    }
    failures.push(
      ...requiredReusableWorkflowFailures(
        repoRoot,
        target.file,
        validated,
        active,
      ),
    );
  }
  active.delete(canonical);
  validated.add(canonical);
  return failures;
}

function nativeClippySelectorFailures(relativeFile, lines, changes) {
  const failures = [];
  const steps = policyJobSteps(
    relativeFile,
    lines,
    changes,
    failures,
    "changes",
  );
  const detectors = steps.filter(
    (step) =>
      step.properties.get("name")?.value ===
      "Detect release-impacting ZUULI changes",
  );
  if (detectors.length !== 1) {
    failures.push(
      `${relativeFile}:${changes.start + 1}: changes must contain exactly one release-impacting change detector`,
    );
    return failures;
  }

  const detector = detectors[0];
  const run = detector.properties.get("run");
  if (run?.value !== "|") {
    failures.push(
      `${relativeFile}:${detector.start + 1}: release-impacting change detector must use a block run script`,
    );
    return failures;
  }
  const body = lines.slice(run.index + 1, detector.end).join("\n");
  const arms = new Map();
  for (const match of body.matchAll(
    /^\s*case "\$file" in\s*\n\s*([^\n)]+)\)\s*\n\s*(zuuli|zuuallet_schema)=true\s*\n\s*;;\s*\n\s*esac\s*$/gm,
  )) {
    const output = match[2];
    if (arms.has(output)) {
      failures.push(
        `${relativeFile}:${detector.start + 1}: release-impacting change detector has duplicate ${output} selector arms`,
      );
    } else {
      arms.set(
        output,
        match[1].split("|").map((pattern) => pattern.trim()),
      );
    }
  }
  if (!arms.has("zuuli") || !arms.has("zuuallet_schema")) {
    failures.push(
      `${relativeFile}:${detector.start + 1}: release-impacting change detector must retain both native lint selector arms`,
    );
    return failures;
  }

  const patterns = [...arms.values()].flat();
  for (const input of REQUIRED_NATIVE_CLIPPY_INPUTS) {
    if (!patterns.some((pattern) => shellCasePatternMatches(pattern, input))) {
      failures.push(
        `${relativeFile}:${detector.start + 1}: native clippy input must select at least one native lint path: ${input}`,
      );
    }
  }
  return failures;
}

function cryptoProbeInputFailures(repoRoot, overrides = new Map()) {
  const failures = [];
  for (const [input, expectedDigest] of REQUIRED_CRYPTO_PROBE_INPUTS) {
    const absoluteInput = path.resolve(repoRoot, input);
    if (!overrides.has(input)) {
      if (
        !fs.existsSync(absoluteInput) ||
        !fs.lstatSync(absoluteInput).isFile()
      ) {
        failures.push(
          `${input}: required crypto probe input must be a regular file`,
        );
        continue;
      }
    }
    const contents = overrides.has(input)
      ? overrides.get(input)
      : fs.readFileSync(absoluteInput);
    const actualDigest = createHash("sha256").update(contents).digest("hex");
    if (actualDigest !== expectedDigest) {
      failures.push(
        `${input}: crypto probe input differs from its reviewed digest`,
      );
    }
  }
  return failures;
}

function librustzcashScopeFailures(scope = reviewedCompatibilityScope()) {
  const failures = [];
  if (scope.lockfiles.length !== REQUIRED_LIBRUSTZCASH_LOCKFILE_COUNT) {
    failures.push(
      `librustzcash source contract must guard exactly ${REQUIRED_LIBRUSTZCASH_LOCKFILE_COUNT} shipping locks, got ${scope.lockfiles.length}`,
    );
  }
  if (scope.packages.size !== REQUIRED_LIBRUSTZCASH_PACKAGE_COUNT) {
    failures.push(
      `librustzcash source contract must guard exactly ${REQUIRED_LIBRUSTZCASH_PACKAGE_COUNT} packages, got ${scope.packages.size}`,
    );
  }
  const actualDigest = createHash("sha256")
    .update(compatibilityScopeIdentity(scope))
    .digest("hex");
  if (actualDigest !== REQUIRED_LIBRUSTZCASH_SCOPE_DIGEST) {
    failures.push(
      `librustzcash lock/package inventory differs from its independently reviewed digest: ${actualDigest}`,
    );
  }
  return failures;
}

function gatePolicyFailures(repoRoot, relativeFile, lines) {
  const failures = [];
  const jobs = policyWorkflowJobs(relativeFile, lines, failures);

  const gate = jobs.get("gate");
  if (!gate) {
    failures.push(
      `${relativeFile}: required workflow must contain the gate job`,
    );
    return failures;
  }
  const needsProperty = gate.properties.get("needs");
  if (!needsProperty) {
    failures.push(
      `${relativeFile}:${gate.start + 1}: required gate must declare needs`,
    );
    return failures;
  }
  const parsedNeeds = parseGateNeeds(lines, needsProperty.index, 4);
  if (parsedNeeds.error) {
    failures.push(
      `${relativeFile}:${needsProperty.index + 1}: ${parsedNeeds.error}`,
    );
    return failures;
  }

  for (const dependency of parsedNeeds.values) {
    if (!jobs.has(dependency)) {
      failures.push(
        `${relativeFile}:${needsProperty.index + 1}: gate depends on undefined job ${dependency}`,
      );
    }
  }

  const enforceNativeClippy =
    path.resolve(repoRoot) === POLICY_REPO_ROOT &&
    relativeFile.split(path.sep).join("/") === REQUIRED_WORKFLOW_PATH;
  const enforceWasmBoundary = enforceNativeClippy;
  if (enforceNativeClippy) {
    failures.push(...librustzcashScopeFailures());
  }
  if (
    enforceNativeClippy &&
    !parsedNeeds.values.includes("rust_native_clippy")
  ) {
    failures.push(
      `${relativeFile}:${needsProperty.index + 1}: gate must await rust_native_clippy`,
    );
  }
  if (
    enforceNativeClippy &&
    !parsedNeeds.values.includes("rust_native_tests")
  ) {
    failures.push(
      `${relativeFile}:${needsProperty.index + 1}: gate must await rust_native_tests`,
    );
  }
  if (
    enforceNativeClippy &&
    !parsedNeeds.values.includes("rust_crypto_targets")
  ) {
    failures.push(
      `${relativeFile}:${needsProperty.index + 1}: gate must await rust_crypto_targets`,
    );
  }

  const nativeTests = jobs.get("rust_native_tests");
  if (enforceNativeClippy && !nativeTests) {
    failures.push(
      `${relativeFile}: required workflow must contain rust_native_tests`,
    );
  } else if (enforceNativeClippy) {
    const actualNativeTestsJobLines = lines
      .slice(nativeTests.start, nativeTests.end)
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .map((line) => line.trimEnd());
    if (
      JSON.stringify(actualNativeTestsJobLines) !==
      JSON.stringify(REQUIRED_NATIVE_TESTS_JOB_LINES)
    ) {
      failures.push(
        `${relativeFile}:${nativeTests.start + 1}: rust_native_tests must match the exact current-source native execution contract`,
      );
    }
  }

  const nativeClippy = jobs.get("rust_native_clippy");
  if (enforceNativeClippy && !nativeClippy) {
    failures.push(
      `${relativeFile}: required workflow must contain rust_native_clippy`,
    );
  } else if (enforceNativeClippy) {
    const actualNativeClippyJobLines = lines
      .slice(nativeClippy.start, nativeClippy.end)
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .map((line) => line.trimEnd());
    if (
      JSON.stringify(actualNativeClippyJobLines) !==
      JSON.stringify(REQUIRED_NATIVE_CLIPPY_JOB_LINES)
    ) {
      failures.push(
        `${relativeFile}:${nativeClippy.start + 1}: rust_native_clippy must match the exact current-source native job contract`,
      );
    }

    const expectedProperties = new Map([
      ["name", "Rust / native lints (${{ matrix.target_os }})"],
      ["needs", "changes"],
      [
        "if",
        "needs.changes.outputs.zuuli == 'true' || needs.changes.outputs.zuuallet_schema == 'true'",
      ],
      ["timeout-minutes", "90"],
      ["runs-on", "${{ matrix.os }}"],
    ]);
    for (const [property, expected] of expectedProperties) {
      if (nativeClippy.properties.get(property)?.value !== expected) {
        failures.push(
          `${relativeFile}:${nativeClippy.start + 1}: rust_native_clippy ${property} differs from its required value`,
        );
      }
    }

    const nativeLines = lines.slice(nativeClippy.start, nativeClippy.end);
    const targetOperatingSystems = nativeLines
      .map((line) => /^\s+target_os:\s+(\S+)\s*$/.exec(line)?.[1])
      .filter(Boolean);
    const runnerOperatingSystems = nativeLines
      .map((line) => /^\s+- os:\s+(\S+)\s*$/.exec(line)?.[1])
      .filter(Boolean);
    if (
      JSON.stringify(targetOperatingSystems) !==
        JSON.stringify(["macos", "windows"]) ||
      JSON.stringify(runnerOperatingSystems) !==
        JSON.stringify(["macos-latest", "windows-latest"])
    ) {
      failures.push(
        `${relativeFile}:${nativeClippy.start + 1}: rust_native_clippy must use the exact macOS/Windows native matrix`,
      );
    }

    const nativeSteps = policyJobSteps(
      relativeFile,
      lines,
      nativeClippy,
      failures,
      "rust_native_clippy",
    );
    const stepsByName = (name) =>
      nativeSteps.filter((step) => step.properties.get("name")?.value === name);
    const selfTests = stepsByName(
      "Prove native target selection and -D warnings",
    );
    const selfTest = selfTests[0];
    if (
      selfTests.length !== 1 ||
      !hasExactKeys(selfTest?.properties ?? new Map(), [
        "name",
        "shell",
        "run",
      ]) ||
      selfTest?.properties.get("shell")?.value !== "bash" ||
      selfTest?.properties.get("run")?.value !==
        'scripts/check-rust-clippy.sh --self-test "${{ matrix.target_os }}"'
    ) {
      failures.push(
        `${relativeFile}:${nativeClippy.start + 1}: rust_native_clippy must run exactly one unconditional target-bound negative control`,
      );
    }
    const lints = stepsByName(
      "Lint every Rust crate under wallet/ at -D warnings",
    );
    const lint = lints[0];
    if (
      lints.length !== 1 ||
      !hasExactKeys(lint?.properties ?? new Map(), ["name", "shell", "run"]) ||
      lint?.properties.get("shell")?.value !== "bash" ||
      lint?.properties.get("run")?.value !==
        "scripts/check-rust-clippy.sh --root wallet"
    ) {
      failures.push(
        `${relativeFile}:${nativeClippy.start + 1}: rust_native_clippy must run exactly one unconditional all-wallet lint entrypoint`,
      );
    }
  }

  const cryptoTargets = jobs.get("rust_crypto_targets");
  if (enforceNativeClippy && !cryptoTargets) {
    failures.push(
      `${relativeFile}: required workflow must contain rust_crypto_targets`,
    );
  } else if (enforceNativeClippy) {
    const actualCryptoTargetJobLines = lines
      .slice(cryptoTargets.start, cryptoTargets.end)
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .map((line) => line.trimEnd());
    if (
      JSON.stringify(actualCryptoTargetJobLines) !==
      JSON.stringify(REQUIRED_CRYPTO_TARGET_JOB_LINES)
    ) {
      failures.push(
        `${relativeFile}:${cryptoTargets.start + 1}: rust_crypto_targets must match the exact reviewed target/source/test contract`,
      );
    }

    failures.push(...cryptoProbeInputFailures(repoRoot));
  }

  const validatedReusableWorkflows = new Set();
  for (const dependency of parsedNeeds.values) {
    const job = jobs.get(dependency);
    const uses = job?.properties.get("uses");
    if (!uses) continue;
    const reference = requiredJobUsesReference(relativeFile, uses, failures);
    if (!reference) continue;
    if (!/^\.\/\.github\/workflows\/[^/]+\.ya?ml$/.test(reference)) {
      failures.push(
        `${relativeFile}:${uses.index + 1}: required-gate job ${dependency} must call a repository-local reusable workflow`,
      );
      continue;
    }
    const target = localTarget(repoRoot, reference);
    if (target.error) {
      failures.push(`${relativeFile}:${uses.index + 1}: ${target.error}`);
      continue;
    }
    failures.push(
      ...requiredReusableWorkflowFailures(
        repoRoot,
        target.file,
        validatedReusableWorkflows,
      ),
    );
  }

  for (const jobId of [...parsedNeeds.values, "gate"]) {
    const requiredJob = jobs.get(jobId);
    if (requiredJob) {
      failures.push(
        ...requiredJobExecutionFailures(relativeFile, lines, requiredJob),
      );
    }
    const property = requiredJob?.properties.get("continue-on-error");
    if (property) {
      failures.push(
        `${relativeFile}:${property.index + 1}: job-level continue-on-error is forbidden on required-gate job ${jobId}`,
      );
    }
  }

  if (gate.properties.get("if")?.value !== "always()") {
    failures.push(
      `${relativeFile}:${gate.start + 1}: required gate must run with if: always()`,
    );
  }
  const changes = jobs.get("changes");
  if (!changes) {
    failures.push(
      `${relativeFile}: required workflow must contain the changes job`,
    );
  } else {
    failures.push(
      ...requiredChangesControlFailures(relativeFile, lines, changes),
    );
    if (enforceWasmBoundary) {
      failures.push(
        ...requiredWasmSelectorFailures(relativeFile, lines, changes),
      );
    }
    if (enforceNativeClippy) {
      failures.push(
        ...nativeClippySelectorFailures(relativeFile, lines, changes),
      );
    }
  }
  const frontend = jobs.get("frontend");
  if (enforceWasmBoundary && frontend) {
    failures.push(
      ...requiredFrontendWasmControlFailures(relativeFile, lines, frontend),
    );
  }
  failures.push(...requiredGateControlFailures(relativeFile, lines, gate));

  return failures;
}

function selectorResult(value, name) {
  if (value === "true") return "success";
  if (value === "false") return "skipped";
  throw new Error(
    `invalid or missing ${name} change-detector output: ${value}`,
  );
}

function verifyGateResults(policyOutcome, serializedNeeds) {
  if (policyOutcome !== "success") {
    throw new Error(
      `gate-local policy recheck did not pass: ${policyOutcome || "missing"}`,
    );
  }

  let needs;
  try {
    needs = JSON.parse(serializedNeeds);
  } catch {
    throw new Error("required jobs context is not valid JSON");
  }
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    throw new Error("required jobs context must be a JSON object");
  }
  const entries = Object.entries(needs);
  if (!entries.length || !needs.changes) {
    throw new Error("required jobs context must include changes");
  }

  const changes = needs.changes;
  if (changes.result !== "success") {
    throw new Error(
      `change detection did not pass: ${changes.result || "missing"}`,
    );
  }
  if (!changes.outputs || typeof changes.outputs !== "object") {
    throw new Error("change detection outputs are missing");
  }
  const zuuliExpected = selectorResult(changes.outputs.zuuli, "ZUULI");
  const schemaExpected = selectorResult(
    changes.outputs.zuuallet_schema,
    "Zuuallet schema",
  );
  // The two native macOS/Windows jobs share one selector because they judge one
  // body of code: rust_native_clippy compiles it and rust_native_tests executes
  // it. Deriving both expectations from the same value here means the gate can
  // never accept a skip from one that it would reject from the other.
  const nativeExpected =
    zuuliExpected === "success" || schemaExpected === "success"
      ? "success"
      : "skipped";
  const NATIVE_JOBS = new Set(["rust_native_clippy", "rust_native_tests"]);

  const verdicts = [];
  for (const [job, state] of entries) {
    if (
      !state ||
      typeof state !== "object" ||
      typeof state.result !== "string"
    ) {
      throw new Error(`required job ${job} has no result`);
    }
    const expected =
      job === "changes"
        ? "success"
        : job === "zuuallet_schema"
          ? schemaExpected
          : NATIVE_JOBS.has(job)
            ? nativeExpected
            : zuuliExpected;
    if (state.result !== expected) {
      throw new Error(
        `required job ${job} must be ${expected}, got ${state.result}`,
      );
    }
    verdicts.push(`${job}=${state.result}`);
  }
  return verdicts;
}

function localTarget(repoRoot, reference) {
  const relative = reference.slice(2);
  const candidate = path.resolve(repoRoot, relative);
  const relativeCandidate = path.relative(repoRoot, candidate);
  if (
    relativeCandidate.startsWith("..") ||
    path.isAbsolute(relativeCandidate)
  ) {
    return { error: `local action escapes the repository: ${reference}` };
  }
  if (!fs.existsSync(candidate)) {
    return { error: `local action or workflow does not exist: ${reference}` };
  }
  const canonical = fs.realpathSync(candidate);
  const relativeCanonical = path.relative(repoRoot, canonical);
  if (
    relativeCanonical.startsWith("..") ||
    path.isAbsolute(relativeCanonical)
  ) {
    return {
      error: `local action resolves outside the repository: ${reference}`,
    };
  }
  if (fs.statSync(candidate).isFile()) return { file: candidate };

  const actionFiles = ["action.yml", "action.yaml"]
    .map((name) => path.join(candidate, name))
    .filter((file) => fs.existsSync(file));
  if (actionFiles.length !== 1) {
    return {
      error: `local action directory must contain exactly one action.yml or action.yaml: ${reference}`,
    };
  }
  return { file: actionFiles[0] };
}

function reviewedJson(repoRoot, relative, overrides, failures) {
  const absolute = path.join(repoRoot, relative);
  let source;
  if (overrides?.has(relative)) {
    source = overrides.get(relative);
  } else {
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile()) {
        failures.push(`${relative}: must be a regular reviewed JSON file`);
        return null;
      }
      source = fs.readFileSync(absolute, "utf8");
    } catch (error) {
      failures.push(`${relative}: cannot read reviewed JSON: ${error.message}`);
      return null;
    }
  }
  try {
    const parsed = JSON.parse(source);
    if (
      parsed === null ||
      Array.isArray(parsed) ||
      typeof parsed !== "object"
    ) {
      failures.push(`${relative}: reviewed JSON root must be an object`);
      return null;
    }
    return parsed;
  } catch (error) {
    failures.push(`${relative}: invalid reviewed JSON: ${error.message}`);
    return null;
  }
}

function frontendBuildContractFailures(repoRoot, overrides = null) {
  const failures = [];
  const packageContracts = [
    ["wallet/zuuli/package.json", REQUIRED_FRONTEND_PACKAGE_SCRIPTS],
    ["wallet/zuuallet/package.json", REQUIRED_CLASSIC_PACKAGE_SCRIPTS],
  ];
  for (const [relative, requiredScripts] of packageContracts) {
    const manifest = reviewedJson(repoRoot, relative, overrides, failures);
    if (!manifest) continue;
    if (
      manifest.scripts === null ||
      Array.isArray(manifest.scripts) ||
      typeof manifest.scripts !== "object"
    ) {
      failures.push(`${relative}: scripts must be an object`);
      continue;
    }
    for (const [name, required] of requiredScripts) {
      if (manifest.scripts[name] !== required) {
        failures.push(
          `${relative}: package script ${JSON.stringify(name)} must equal ${JSON.stringify(required)}`,
        );
      }
    }
  }

  const tsconfigRelative = "wallet/zuuli/tsconfig.build.json";
  const tsconfig = reviewedJson(
    repoRoot,
    tsconfigRelative,
    overrides,
    failures,
  );
  if (tsconfig) {
    const keys = Object.keys(tsconfig).sort();
    const requiredKeys = ["exclude", "extends"];
    if (JSON.stringify(keys) !== JSON.stringify(requiredKeys)) {
      failures.push(
        `${tsconfigRelative}: must contain exactly the reviewed extends and exclude keys`,
      );
    }
    if (tsconfig.extends !== REQUIRED_FRONTEND_BUILD_TSCONFIG.extends) {
      failures.push(
        `${tsconfigRelative}: extends must equal ${JSON.stringify(REQUIRED_FRONTEND_BUILD_TSCONFIG.extends)}`,
      );
    }
    if (
      !Array.isArray(tsconfig.exclude) ||
      JSON.stringify(tsconfig.exclude) !==
        JSON.stringify(REQUIRED_FRONTEND_BUILD_TSCONFIG.exclude)
    ) {
      failures.push(
        `${tsconfigRelative}: exclude must equal ${JSON.stringify(REQUIRED_FRONTEND_BUILD_TSCONFIG.exclude)}`,
      );
    }
  }
  return failures;
}

function scanRepository(
  repoRoot,
  {
    enforceRustRootOwners = true,
    rustRootOwnerOverrides = null,
    rustRootContracts = RUST_ROOT_CONTRACTS,
    enforceFrontendBuildContracts = true,
    frontendBuildContractOverrides = null,
  } = {},
) {
  repoRoot = fs.realpathSync(repoRoot);
  const queued = [
    ...yamlFilesBelow(path.join(repoRoot, ".github", "workflows")),
    ...yamlFilesBelow(path.join(repoRoot, ".github", "actions")),
  ];
  const seen = new Set();
  const failures = [];
  let externalReferences = 0;

  if (enforceFrontendBuildContracts) {
    failures.push(
      ...frontendBuildContractFailures(
        repoRoot,
        frontendBuildContractOverrides,
      ),
    );
  }

  if (enforceRustRootOwners) {
    failures.push(...rustRootOwnershipFailures(rustRootContracts));
    for (const contract of rustRootContracts) {
      const owner = path.join(repoRoot, contract.workflow);
      const overridden = rustRootOwnerOverrides?.has(contract.workflow);
      if (!overridden && !fs.existsSync(owner)) {
        failures.push(
          `${contract.root}/ owning workflow is missing: ${contract.workflow}`,
        );
        continue;
      }
      const ownerSource = overridden
        ? rustRootOwnerOverrides.get(contract.workflow)
        : fs.readFileSync(owner, "utf8");
      if (ownerSource === null) {
        failures.push(
          `${contract.root}/ owning workflow is missing: ${contract.workflow}`,
        );
        continue;
      }
      failures.push(
        ...rustRootWorkflowFailures(
          contract.workflow,
          ownerSource.split(/\r?\n/),
          contract,
        ),
      );
    }
  }

  while (queued.length) {
    const file = queued.shift();
    const canonical = fs.realpathSync(file);
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const relativeFile = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    if (relativeFile.split(path.sep).join("/") === REQUIRED_WORKFLOW_PATH) {
      failures.push(...gatePolicyFailures(repoRoot, relativeFile, lines));
    }
    for (const [index, line] of lines.entries()) {
      const parsed = usesFromLine(line);
      if (!parsed) continue;
      const location = `${relativeFile}:${index + 1}`;
      if (parsed.error) {
        failures.push(`${location}: ${parsed.error}`);
        continue;
      }

      const reference = parsed.ref;
      if (reference.startsWith("./")) {
        const target = localTarget(repoRoot, reference);
        if (target.error) failures.push(`${location}: ${target.error}`);
        else queued.push(target.file);
        continue;
      }

      externalReferences += 1;
      const external = reference.match(EXTERNAL_USES);
      if (!external) {
        failures.push(
          `${location}: invalid external \`uses:\` reference: ${reference}`,
        );
      } else if (!FULL_COMMIT_SHA.test(external[1])) {
        failures.push(
          `${location}: external \`uses:\` reference must end in a full lowercase 40-character commit SHA: ${reference}`,
        );
      } else if (!parsed.provenance) {
        failures.push(
          `${location}: commit-pinned external \`uses:\` reference needs a nonempty trailing version/provenance comment: ${reference}`,
        );
      }
    }
  }

  return {
    externalReferences,
    failures,
    scannedFiles: seen.size,
  };
}

function writeFixture(root, relative, contents) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function runRustRootWorkflowMutationTests(repoRoot) {
  let cases = 0;

  // Enter through the same default-enabled repository scan as live mode.  The
  // detailed controls below deliberately inject owner policy, so they cannot
  // prove that the production entry point retains its default enforcement.
  const productionContract = RUST_ROOT_CONTRACTS[0];
  const productionSource = fs.readFileSync(
    path.join(repoRoot, productionContract.workflow),
    "utf8",
  );
  const productionMutant = productionSource.replace(
    "        run: scripts/check-rust-fmt.sh --root wallet",
    "        run: scripts/check-rust-fmt.sh --root rs",
  );
  if (productionMutant === productionSource) {
    throw new Error("live Rust-root owner scan: mutation target was not found");
  }
  const productionFailures = scanRepository(repoRoot, {
    rustRootOwnerOverrides: new Map([
      [productionContract.workflow, productionMutant],
    ]),
  }).failures;
  const productionNeedle =
    "wallet/ owner job rust_fmt must run exactly one unconditional";
  if (
    !productionFailures.some((failure) => failure.includes(productionNeedle))
  ) {
    throw new Error(
      `live Rust-root owner scan: expected ${JSON.stringify(productionNeedle)}, got ${productionFailures.join("; ")}`,
    );
  }
  console.log(
    "self-test: live repository scan enforces its default Rust-root owner policy: passed",
  );
  cases += 1;

  const assertOwnershipFailure = (name, contracts, needle) => {
    const failures = scanRepository(repoRoot, {
      rustRootContracts: contracts,
    }).failures;
    if (!failures.some((failure) => failure.includes(needle))) {
      throw new Error(
        `${name}: expected ${JSON.stringify(needle)}, got ${failures.join("; ")}`,
      );
    }
    console.log(`self-test: ${name}: passed`);
    cases += 1;
  };
  assertOwnershipFailure(
    "Rust-root registry rejects a missing owner",
    RUST_ROOT_CONTRACTS.slice(0, 1),
    "cover exactly",
  );
  assertOwnershipFailure(
    "Rust-root registry rejects a duplicate owner workflow",
    RUST_ROOT_CONTRACTS.map((contract, index) =>
      index === 1
        ? { ...contract, workflow: RUST_ROOT_CONTRACTS[0].workflow }
        : contract,
    ),
    "one-to-one",
  );
  assertOwnershipFailure(
    "Rust-root registry rejects a substituted root",
    RUST_ROOT_CONTRACTS.map((contract, index) =>
      index === 1 ? { ...contract, root: "third" } : contract,
    ),
    "cover exactly",
  );

  const jobSlice = (source, jobId) => {
    const start = source.indexOf(`\n  ${jobId}:`);
    if (start < 0) return null;
    const nextJob = /\n  [A-Za-z0-9_-]+:\s*(?:\n|$)/g;
    nextJob.lastIndex = start + 1;
    const match = nextJob.exec(source);
    return { start, end: match ? match.index : source.length };
  };
  const mutateJob = (source, jobId, target, replacement) => {
    const slice = jobSlice(source, jobId);
    if (!slice) return source;
    const body = source.slice(slice.start, slice.end);
    const changed = body.replace(target, replacement);
    return source.slice(0, slice.start) + changed + source.slice(slice.end);
  };
  const parkPrimarySelector = (source, contract) => {
    const slice = jobSlice(source, "changes");
    if (!slice) return source;
    const body = source.slice(slice.start, slice.end);
    const marker = '            case "$file" in';
    const start = body.indexOf(marker);
    const endMarker = "            esac";
    const endStart = body.indexOf(endMarker, start);
    if (start < 0 || endStart < 0) return source;
    const end = endStart + endMarker.length;
    const primary = body.slice(start, end);
    if (!primary.includes(`${contract.selectorOutput}=true`)) {
      return source;
    }
    const parked = [
      "            if false; then",
      primary,
      "            fi",
      '            case "${file}" in',
      `              ${contract.root}/known/*)`,
      `                ${contract.selectorOutput}=true`,
      "                ;;",
      "            esac",
    ].join("\n");
    const changed = body.slice(0, start) + parked + body.slice(end);
    return source.slice(0, slice.start) + changed + source.slice(slice.end);
  };
  const assertWorkflowFailure = (contract, source, name, mutate, needle) => {
    const changed = mutate(source);
    if (changed === source)
      throw new Error(`${name}: mutation target was not found`);
    const failures = scanRepository(repoRoot, {
      rustRootOwnerOverrides: new Map([[contract.workflow, changed]]),
    }).failures;
    if (!failures.some((failure) => failure.includes(needle))) {
      throw new Error(
        `${name}: expected ${JSON.stringify(needle)}, got ${failures.join("; ")}`,
      );
    }
    console.log(`self-test: ${name}: passed`);
    cases += 1;
  };

  for (const contract of RUST_ROOT_CONTRACTS) {
    const source = fs.readFileSync(
      path.join(repoRoot, contract.workflow),
      "utf8",
    );
    const baseline = rustRootWorkflowFailures(
      contract.workflow,
      source.split(/\r?\n/),
      contract,
    );
    if (baseline.length) {
      throw new Error(
        `${contract.root}/ owner is not a valid mutation base: ${baseline.join("; ")}`,
      );
    }

    const ownerPrefix = `${contract.root}/ owner`;
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects deleting its owner workflow`,
      () => null,
      `${contract.root}/ owning workflow is missing`,
    );
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects deleting the live toolchain verdict`,
      (value) => value.replace("        scripts/check-rust-toolchain.sh\n", ""),
      `${ownerPrefix} must run one unconditional`,
    );
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects a dead toolchain guard`,
      (value) =>
        value.replace(
          "      - name: Verify the Rust toolchain pin has not drifted",
          "      - name: Verify the Rust toolchain pin has not drifted\n        if: false",
        ),
      `${ownerPrefix} must run one unconditional`,
    );
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects a soft-failing toolchain guard`,
      (value) =>
        value.replace(
          "      - name: Verify the Rust toolchain pin has not drifted",
          "      - name: Verify the Rust toolchain pin has not drifted\n        continue-on-error: true",
        ),
      `${ownerPrefix} must run one unconditional`,
    );
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects a renamed selector step id`,
      (value) =>
        mutateJob(
          value,
          "changes",
          `        id: ${contract.selectorId}`,
          "        id: renamed_filter",
        ),
      `${ownerPrefix} must retain one live`,
    );
    for (const { name } of contract.selectorOutputs) {
      const publication = `      ${name}: \${{ steps.${contract.selectorId}.outputs.${name} }}`;
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/ rejects renaming published selector output ${name}`,
        (value) =>
          mutateJob(
            value,
            "changes",
            publication,
            `      renamed_${name}: \${{ steps.${contract.selectorId}.outputs.${name} }}`,
          ),
        `${contract.root}/ changes must publish exactly`,
      );
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/ rejects repointing published selector output ${name}`,
        (value) =>
          mutateJob(
            value,
            "changes",
            publication,
            `      ${name}: \${{ steps.${contract.selectorId}.outputs.missing_${name} }}`,
          ),
        `${contract.root}/ changes must publish exactly`,
      );
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/ rejects duplicate published selector output ${name}`,
        (value) =>
          mutateJob(
            value,
            "changes",
            publication,
            `${publication}\n${publication}`,
        ),
        `duplicate ${contract.root}/ changes outputs entry ${name}`,
      );
      const failOpenVouch = `            echo "${name}=true" >> "$GITHUB_OUTPUT"`;
      const failOpenNeedle =
        name === contract.selectorOutput
          ? `${ownerPrefix} selector must fail open to its full gate when no usable base commit exists`
          : `${ownerPrefix} selector output ${name} must fail open to its full gate when no usable base commit exists`;
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/ rejects a false ${name} output for an unusable base`,
        (value) =>
          mutateJob(
            value,
            "changes",
            failOpenVouch,
            `            echo "${name}=false" >> "$GITHUB_OUTPUT"`,
          ),
        failOpenNeedle,
      );
    }
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects a line-delimited real Git diff`,
      (value) =>
        mutateJob(
          value,
          "changes",
          "git diff --name-only -z --no-renames",
          "git diff --name-only --no-renames",
        ),
      `${ownerPrefix} selector must actively select`,
    );
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects a line-delimited diff consumer`,
      (value) =>
        mutateJob(
          value,
          "changes",
          "while IFS= read -r -d '' file; do",
          "while IFS= read -r file; do",
      ),
      `${ownerPrefix} selector must actively select`,
    );
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects an inverted real Git diff-failure guard`,
      (value) =>
        mutateJob(
          value,
          "changes",
          "if ! git diff --name-only -z --no-renames",
          "if git diff --name-only -z --no-renames",
        ),
      `${ownerPrefix} selector must fail open`,
    );
    if (contract.root !== "wallet") {
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/ rejects a narrowed root selector`,
        (value) =>
          mutateJob(
            value,
            "changes",
            `${contract.root}/*|`,
            `${contract.root}/known/*|`,
          ),
        `${ownerPrefix} selector must actively select`,
      );
    }
    if (contract.root === "rs") {
      const additionalProbePaths = contract.selectorOutputs.find(
        ({ name }) => name === contract.selectorOutput,
      )?.additionalProbePaths ?? [];
      for (const probePath of additionalProbePaths) {
        assertWorkflowFailure(
          contract,
          source,
          `${contract.root}/ rejects dropping selector coverage for ${probePath}`,
          (value) =>
            mutateJob(
              value,
              "changes",
              probePath.startsWith("docs/e2ee/")
                ? "docs/e2ee/*|"
                : "scripts/check-akd-doc-evidence.mjs|",
              "",
            ),
          `${ownerPrefix} selector must actively select`,
        );
      }
      assertWorkflowFailure(
        contract,
        source,
        "rs rejects narrowing AKD documentation coverage to KT and benchmark only",
        (value) =>
          mutateJob(
            value,
            "changes",
            "docs/e2ee/*|",
            "docs/e2ee/KT.md|docs/e2ee/evidence/akd-benchmark.json|",
          ),
        `${ownerPrefix} selector must actively select`,
      );
    }
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects a dead broad selector beside a narrowed live selector`,
      (value) => parkPrimarySelector(value, contract),
      `${ownerPrefix} selector must actively select`,
    );
    if (contract.root === "wallet") {
      const selectorPatternMutations = [
        [
          "wallet Rust source selector",
          "wallet/*.rs|",
          "",
          "must actively select \"wallet/ordinary.rs\"",
        ],
        [
          "wallet Rust source selector",
          "wallet/*.rs|",
          "wallet/*|",
          'must leave zuuli false for unrelated input "wallet/README.md"',
        ],
        [
          "wallet root Cargo manifest selector",
          "wallet/Cargo.toml|",
          "",
          "must actively select \"wallet/Cargo.toml\"",
        ],
        [
          "wallet root Cargo manifest selector",
          "wallet/Cargo.toml|",
          "wallet/*|",
          'must leave zuuli false for unrelated input "wallet/README.md"',
        ],
        [
          "wallet nested Cargo manifest selector",
          "wallet/*/Cargo.toml|",
          "",
          "must actively select \"wallet/nested/future/Cargo.toml\"",
        ],
        [
          "wallet nested Cargo manifest selector",
          "wallet/*/Cargo.toml|",
          "wallet/*|",
          'must leave zuuli false for unrelated input "wallet/README.md"',
        ],
        [
          "messaging client-contract selector",
          "docs/e2ee/CLIENT-CONTRACT.md|",
          "",
          'must actively select "docs/e2ee/CLIENT-CONTRACT.md"',
        ],
        [
          "messaging wire-contract selector",
          "docs/e2ee/WIRE.md|",
          "",
          'must actively select "docs/e2ee/WIRE.md"',
        ],
      ];
      // The markdown-only guard is a *negative* selector: it exists to keep
      // `wallet/zuuli/*` from dragging prose into the native matrix. Its two
      // failure directions are deleting it and narrowing it to the top level,
      // so both are exercised against the live workflow.
      assertWorkflowFailure(
        contract,
        source,
        "wallet/ rejects deleting the ZUULI markdown-only guard",
        (value) =>
          mutateJob(
            value,
            "changes",
            '            if [[ "$file" == wallet/zuuli/*.md ]]; then\n' +
              "              continue\n" +
              "            fi\n",
            "",
          ),
        'must leave zuuli false for unrelated input "wallet/zuuli/STATUS.md"',
      );
      assertWorkflowFailure(
        contract,
        source,
        "wallet/ rejects a ZUULI markdown-only guard that misses nested prose",
        (value) =>
          mutateJob(
            value,
            "changes",
            '"$file" == wallet/zuuli/*.md',
            '"$file" == wallet/zuuli/STATUS.md',
          ),
        'must leave zuuli false for unrelated input "wallet/zuuli/docs/e2ee/notes.md"',
      );
      for (const [guard, target, replacement, needle] of
        selectorPatternMutations) {
        const action = replacement ? "broadened" : "removed";
        assertWorkflowFailure(
          contract,
          source,
          `${contract.root}/ rejects a ${action} ${guard}`,
          (value) => mutateJob(value, "changes", target, replacement),
          needle,
        );
      }
    }
    const outputVouch = `          echo "${contract.selectorOutput}=$${contract.selectorOutput}" >> "$GITHUB_OUTPUT"`;
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects a selector that exits after writing its vouch`,
      (value) =>
        mutateJob(
          value,
          "changes",
          outputVouch,
          `${outputVouch}\n          false`,
        ),
      `${ownerPrefix} selector must actively select`,
    );
    assertWorkflowFailure(
      contract,
      source,
      `${contract.root}/ rejects a true selector output overwritten false`,
      (value) =>
        mutateJob(
          value,
          "changes",
          outputVouch,
          `${outputVouch}\n          echo "${contract.selectorOutput}=false" >> "$GITHUB_OUTPUT"`,
        ),
      `${ownerPrefix} selector must actively select`,
    );
    for (const { name } of contract.selectorOutputs) {
      if (name === contract.selectorOutput) continue;
      const additionalVouch = `          echo "${name}=$${name}" >> "$GITHUB_OUTPUT"`;
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/ rejects a true ${name} output overwritten false`,
        (value) =>
          mutateJob(
            value,
            "changes",
            additionalVouch,
            `${additionalVouch}\n          echo "${name}=false" >> "$GITHUB_OUTPUT"`,
          ),
        `${ownerPrefix} selector output ${name} must actively select`,
      );
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/ rejects a true ${name} heredoc output overwritten false`,
        (value) =>
          mutateJob(
            value,
            "changes",
            additionalVouch,
            `${additionalVouch}\n          echo '${name}<<OVERRIDE' >> "$GITHUB_OUTPUT"\n          echo false >> "$GITHUB_OUTPUT"\n          echo OVERRIDE >> "$GITHUB_OUTPUT"`,
          ),
        `${ownerPrefix} selector output ${name} must actively select`,
      );
    }

    for (const [jobId, stepName, command] of contract.jobs) {
      const exactIf = `    if: needs.changes.outputs.${contract.selectorOutput} == 'true'`;
      const verdictNeedle = `${ownerPrefix} job ${jobId} must run exactly one`;
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/${jobId} rejects selector bypass`,
        (value) => mutateJob(value, jobId, exactIf, "    if: true"),
        `${ownerPrefix} job ${jobId} must run exactly when`,
      );
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/${jobId} rejects job-level soft failure`,
        (value) =>
          mutateJob(
            value,
            jobId,
            `  ${jobId}:`,
            `  ${jobId}:\n    continue-on-error: true`,
          ),
        `${ownerPrefix} job ${jobId} cannot soft-fail`,
      );
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/${jobId} rejects deleting its live verdict`,
        (value) =>
          mutateJob(
            value,
            jobId,
            `        run: ${command}`,
            "        run: echo checked",
          ),
        verdictNeedle,
      );
      const otherRoot = contract.root === "wallet" ? "rs" : "wallet";
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/${jobId} rejects a wrong-root verdict`,
        (value) =>
          mutateJob(
            value,
            jobId,
            `        run: ${command}`,
            `        run: ${command.replace(`--root ${contract.root}`, `--root ${otherRoot}`)}`,
          ),
        verdictNeedle,
      );
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/${jobId} rejects a dead live verdict`,
        (value) =>
          mutateJob(
            value,
            jobId,
            `      - name: ${stepName}`,
            `      - name: ${stepName}\n        if: false`,
          ),
        verdictNeedle,
      );
      assertWorkflowFailure(
        contract,
        source,
        `${contract.root}/${jobId} rejects a soft-failing live verdict`,
        (value) =>
          mutateJob(
            value,
            jobId,
            `      - name: ${stepName}`,
            `      - name: ${stepName}\n        continue-on-error: true`,
          ),
        verdictNeedle,
      );
    }
    if (contract.root === "rs") {
      for (const [stepName, command] of [
        ["Mutation-test AKD documentation evidence", "node scripts/check-akd-doc-evidence.mjs --self-test"],
        ["Verify AKD documentation against locked executable evidence", "node scripts/check-akd-doc-evidence.mjs"],
      ]) {
        const needle = "rs owner job rs_test must run exactly one unconditional";
        const stepWithToken = `      - name: ${stepName}\n        env:\n          GITHUB_TOKEN: \${{ github.token }}\n        run: ${command}`;
        const stepWithoutToken = `      - name: ${stepName}\n        run: ${command}`;
        assertWorkflowFailure(
          contract,
          source,
          `rs/rs_test rejects deleting ${stepName}`,
          (value) => mutateJob(value, "rs_test", `        run: ${command}`, "        run: echo skipped"),
          needle,
        );
        assertWorkflowFailure(
          contract,
          source,
          `rs/rs_test rejects parking ${stepName}`,
          (value) => mutateJob(value, "rs_test", `      - name: ${stepName}`, `      - name: ${stepName}\n        if: false`),
          needle,
        );
        assertWorkflowFailure(
          contract,
          source,
          `rs/rs_test rejects soft-failing ${stepName}`,
          (value) => mutateJob(value, "rs_test", `      - name: ${stepName}`, `      - name: ${stepName}\n        continue-on-error: true`),
          needle,
        );
        assertWorkflowFailure(
          contract,
          source,
          `rs/rs_test rejects unauthenticated ${stepName}`,
          (value) => mutateJob(value, "rs_test", stepWithToken, stepWithoutToken),
          needle,
        );
        assertWorkflowFailure(
          contract,
          source,
          `rs/rs_test rejects a substituted token for ${stepName}`,
          (value) => mutateJob(
            value,
            "rs_test",
            stepWithToken,
            stepWithToken.replace("\${{ github.token }}", "untrusted"),
          ),
          needle,
        );
      }
    }
  }
  return cases;
}

function runCurrentWorkflowMutationTests(repoRoot) {
  const relative = path.join(".github", "workflows", "zuuli.yml");
  const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
  const baseline = gatePolicyFailures(
    repoRoot,
    relative,
    source.split(/\r?\n/),
  );
  if (baseline.length) {
    throw new Error(
      `current required workflow is not a valid mutation base: ${baseline.join("; ")}`,
    );
  }
  const replaceLast = (value, target, replacement) => {
    const index = value.lastIndexOf(target);
    if (index < 0) return value;
    return (
      value.slice(0, index) + replacement + value.slice(index + target.length)
    );
  };
  const replaceFrontend = (target, replacement) => {
    const start = source.indexOf("\n  frontend:");
    const end = source.indexOf("\n  rust_fmt:", start);
    if (start < 0 || end < 0) return source;
    const before = source.slice(0, start);
    const frontend = source.slice(start, end);
    return before + frontend.replace(target, replacement) + source.slice(end);
  };

  const checkoutLine = `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1\n`;
  const policyName =
    "      - name: Recheck immutable actions and fail-closed required jobs";
  const policyBlock = [
    policyName,
    "        id: policy",
    "        run: |",
    `          ${GATE_POLICY_SELF_TEST_COMMAND}`,
    `          ${GATE_POLICY_COMMAND}`,
    `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}`,
    `          ${WORKFLOW_GATES_COMMAND}`,
    "",
  ].join("\n");
  const verdictName =
    "      - name: Verify required jobs succeeded or legitimately skipped";
  const mutations = [
    {
      name: "real workflow rejects native clippy detached from gate",
      needle: "gate must await rust_native_clippy",
      source: source.replace(", rust_native_clippy", ""),
    },
    {
      name: "real workflow rejects a stale native checkout",
      needle: "must match the exact current-source native job contract",
      source: source.replace(
        `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1\n\n      - name: Fetch librustzcash submodule`,
        `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1\n        with:\n          ref: 0123456789abcdef0123456789abcdef01234567\n\n      - name: Fetch librustzcash submodule`,
      ),
    },
    {
      name: "real workflow rejects a native source reset step",
      needle: "must match the exact current-source native job contract",
      source: source.replace(
        "      - name: Prove native target selection and -D warnings",
        "      - name: Reset to an earlier clean source\n        run: git checkout 0123456789abcdef0123456789abcdef01234567\n\n      - name: Prove native target selection and -D warnings",
      ),
    },
    {
      name: "real workflow rejects a non-native target matrix",
      needle: "must use the exact macOS/Windows native matrix",
      source: source.replace(
        "            target_os: windows",
        "            target_os: linux",
      ),
    },
    {
      name: "real workflow rejects a weakened native clippy selector",
      needle: "rust_native_clippy if differs from its required value",
      source: source.replace(
        "    if: needs.changes.outputs.zuuli == 'true' || needs.changes.outputs.zuuallet_schema == 'true'",
        "    if: needs.changes.outputs.zuuli == 'true'",
      ),
    },
    {
      name: "real workflow rejects native tests detached from gate",
      needle: "gate must await rust_native_tests",
      source: source.replace(", rust_native_tests", ""),
    },
    {
      name: "real workflow rejects a weakened native test command",
      needle:
        "rust_native_tests must match the exact current-source native execution contract",
      // Unique in the file: rust_plugin runs the same command on one line, so
      // only the folded form belongs to rust_native_tests. Dropping --locked is
      // the realistic weakening — it makes a stale lockfile build anyway.
      source: source.replace(
        "          cargo test --locked\n          --all-targets\n",
        "          cargo test\n          --all-targets\n",
      ),
    },
    {
      name: "real workflow rejects a weakened native test selector",
      needle:
        "rust_native_tests must match the exact current-source native execution contract",
      // replaceLast, not replace: rust_native_clippy carries the identical
      // selector earlier in the file, and mutating that one would prove the
      // clippy contract rather than this one.
      source: replaceLast(
        source,
        "    if: needs.changes.outputs.zuuli == 'true' || needs.changes.outputs.zuuallet_schema == 'true'",
        "    if: needs.changes.outputs.zuuli == 'true'",
      ),
    },
    {
      name: "real workflow rejects dropping the Windows native test leg",
      needle:
        "rust_native_tests must match the exact current-source native execution contract",
      source: replaceLast(
        source,
        "          - os: windows-latest\n            target_os: windows\n",
        "",
      ),
    },
    {
      name: "real workflow rejects crypto targets detached from gate",
      needle: "gate must await rust_crypto_targets",
      source: source.replace(", rust_crypto_targets", ""),
    },
    {
      name: "real workflow rejects a stale crypto source reset",
      needle:
        "rust_crypto_targets must match the exact reviewed target/source/test contract",
      source: source.replace(
        "      - name: Verify exact clean source identity",
        "      - name: Substitute an earlier clean source\n        run: git reset --hard HEAD~1\n\n      - name: Verify exact clean source identity",
      ),
    },
    {
      name: "real workflow rejects a removed crypto target",
      needle:
        "rust_crypto_targets must match the exact reviewed target/source/test contract",
      source: source.replace(",i686-linux-android", ""),
    },
    {
      name: "real workflow rejects crypto type-check substituted for code generation",
      needle:
        "rust_crypto_targets must match the exact reviewed target/source/test contract",
      source: source.replace(
        "            cargo build --locked --release --lib --target",
        "            cargo check --locked --release --lib --target",
      ),
    },
    {
      name: "real workflow rejects a skipped crypto host runtime test",
      needle:
        "rust_crypto_targets must match the exact reviewed target/source/test contract",
      source: source.replace(
        "      - name: Execute the representative crypto probe on the hosted OS\n        shell: bash",
        "      - name: Execute the representative crypto probe on the hosted OS\n        if: false\n        shell: bash",
      ),
    },
    {
      name: "real workflow rejects deletion of crypto source identity",
      needle:
        "rust_crypto_targets must match the exact reviewed target/source/test contract",
      source: source.replace(
        '          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"\n',
        "",
      ),
    },
    {
      name: "real workflow selects root Cargo workspace inputs for native clippy",
      needle:
        "native clippy input must select at least one native lint path: Cargo.toml",
      source: source.replaceAll("Cargo.toml|Cargo.lock|", ""),
    },
    {
      name: "real workflow selects root Cargo configuration for native clippy",
      needle:
        "native clippy input must select at least one native lint path: .cargo/config.toml",
      source: source.replaceAll(".cargo/*|", ""),
    },
    {
      name: "real workflow selects root Clippy configuration for native clippy",
      needle:
        "native clippy input must select at least one native lint path: clippy.toml",
      source: source.replaceAll("clippy.toml|.clippy.toml|", ""),
    },
    {
      name: "real workflow selects wallet parent workspace manifests for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/Cargo.toml",
      source: source
        .replaceAll("wallet/*|", "")
        .replaceAll("wallet/Cargo.toml|wallet/Cargo.lock|", ""),
    },
    {
      name: "real workflow selects wallet parent lint configuration for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/.cargo/config.toml",
      source: source
        .replaceAll("wallet/*|", "")
        .replaceAll(
          "wallet/.cargo/*|wallet/clippy.toml|wallet/.clippy.toml|",
          "",
        ),
    },
    {
      name: "real workflow selects future wallet Rust sources for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/future-crate/src/lib.rs",
      source: source.replaceAll("wallet/*|", "").replaceAll("wallet/*.rs|", ""),
    },
    {
      name: "real workflow selects future wallet manifests for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/future-crate/Cargo.toml",
      source: source
        .replaceAll("wallet/*|", "")
        .replaceAll("wallet/*/Cargo.toml|wallet/*/Cargo.lock|", ""),
    },
    {
      name: "real workflow selects future wallet Cargo configuration for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/future-crate/.cargo/config.toml",
      source: source
        .replaceAll("wallet/*|", "")
        .replaceAll("wallet/*/.cargo/*|", ""),
    },
    {
      name: "real workflow selects future wallet Clippy configuration for native clippy",
      needle:
        "native clippy input must select at least one native lint path: wallet/future-crate/clippy.toml",
      source: source
        .replaceAll("wallet/*|", "")
        .replaceAll("wallet/*/clippy.toml|wallet/*/.clippy.toml|", ""),
    },
    {
      name: "real workflow rejects a decorative native negative control",
      needle:
        "must run exactly one unconditional target-bound negative control",
      source: source.replace(
        '        run: scripts/check-rust-clippy.sh --self-test "${{ matrix.target_os }}"',
        '        run: echo "native clippy self-test"',
      ),
    },
    {
      name: "real workflow rejects a skipped native negative control",
      needle:
        "must run exactly one unconditional target-bound negative control",
      source: source.replace(
        '        run: scripts/check-rust-clippy.sh --self-test "${{ matrix.target_os }}"',
        '        run: scripts/check-rust-clippy.sh --self-test "${{ matrix.target_os }}"\n        if: false',
      ),
    },
    {
      name: "real workflow rejects a decorative native lint verdict",
      needle: "must run exactly one unconditional all-wallet lint entrypoint",
      source: source.replace(
        "      - name: Lint every Rust crate under wallet/ at -D warnings\n        shell: bash\n        run: scripts/check-rust-clippy.sh --root wallet",
        "      - name: Lint every Rust crate under wallet/ at -D warnings\n        shell: bash\n        run: echo clean",
      ),
    },
    {
      name: "real workflow rejects a skipped native lint verdict",
      needle: "must run exactly one unconditional all-wallet lint entrypoint",
      source: source.replace(
        "      - name: Lint every Rust crate under wallet/ at -D warnings\n        shell: bash\n        run: scripts/check-rust-clippy.sh --root wallet",
        "      - name: Lint every Rust crate under wallet/ at -D warnings\n        shell: bash\n        run: scripts/check-rust-clippy.sh --root wallet\n        if: false",
      ),
    },
    {
      name: "real workflow rejects log-only needs consumption",
      needle:
        "must unconditionally recheck policy and enforce the complete needs context",
      source: source.replace(
        `          ${GATE_VERDICT_COMMAND}\n`,
        '          echo "$REQUIRED_JOBS_JSON"\n',
      ),
    },
    {
      name: "real workflow rejects a dynamically dead verdict",
      needle:
        "must unconditionally recheck policy and enforce the complete needs context",
      source: source.replace(
        verdictName,
        `${verdictName}\n        if: github.event_name == '__never__'`,
      ),
    },
    {
      name: "real workflow rejects deleted gate checkout",
      needle:
        "must contain exactly checkout, policy recheck, and enforcing verdict steps",
      source: replaceLast(source, checkoutLine, ""),
    },
    {
      name: "real workflow rejects skipped gate checkout",
      needle: "gate checkout must be exact, current-source, and unconditional",
      source: replaceLast(
        source,
        checkoutLine,
        `${checkoutLine.trimEnd()}\n        if: false\n`,
      ),
    },
    {
      name: "real workflow rejects deleted policy recheck",
      needle:
        "must contain exactly checkout, policy recheck, and enforcing verdict steps",
      source: source.replace(policyBlock, ""),
    },
    {
      name: "real workflow rejects dynamically dead policy recheck",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: source.replace(
        policyName,
        `${policyName}\n        if: github.event_name == '__never__'`,
      ),
    },
    {
      name: "real workflow rejects soft-failing policy recheck",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: source.replace(
        policyName,
        `${policyName}\n        continue-on-error: true`,
      ),
    },
    {
      name: "real workflow rejects a missing gate policy self-test",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(
        source,
        `          ${GATE_POLICY_SELF_TEST_COMMAND}\n`,
        "",
      ),
    },
    {
      name: "real workflow rejects a missing gate workflow-policy self-test",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(
        source,
        `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}\n`,
        "",
      ),
    },
    {
      name: "real workflow rejects a missing gate workflow-policy verdict",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(source, `          ${WORKFLOW_GATES_COMMAND}\n`, ""),
    },
    {
      name: "real workflow rejects a reordered gate workflow-policy self-test",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(
        source,
        [
          `          ${GATE_POLICY_COMMAND}`,
          `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}`,
        ].join("\n"),
        [
          `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}`,
          `          ${GATE_POLICY_COMMAND}`,
        ].join("\n"),
      ),
    },
    {
      name: "real workflow rejects a reordered gate workflow-policy verdict",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(
        source,
        [
          `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}`,
          `          ${WORKFLOW_GATES_COMMAND}`,
        ].join("\n"),
        [
          `          ${WORKFLOW_GATES_COMMAND}`,
          `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}`,
        ].join("\n"),
      ),
    },
    {
      name: "real workflow rejects a soft-failing workflow-policy self-test",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(
        source,
        `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}\n`,
        `          ${WORKFLOW_GATES_SELF_TEST_COMMAND} || true\n`,
      ),
    },
    {
      name: "real workflow rejects a dynamically dead workflow-policy verdict",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(
        source,
        `          ${WORKFLOW_GATES_COMMAND}\n`,
        `          false && ${WORKFLOW_GATES_COMMAND}\n`,
      ),
    },
    {
      name: "real workflow rejects a dynamically dead workflow-policy self-test",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(
        source,
        `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}\n`,
        `          false && ${WORKFLOW_GATES_SELF_TEST_COMMAND}\n`,
      ),
    },
    {
      name: "real workflow rejects a soft-failing workflow-policy verdict",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(
        source,
        `          ${WORKFLOW_GATES_COMMAND}\n`,
        `          ${WORKFLOW_GATES_COMMAND} || true\n`,
      ),
    },
    {
      name: "real workflow rejects an extra decorative gate policy command",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      source: replaceLast(
        source,
        `          ${WORKFLOW_GATES_COMMAND}\n`,
        `          ${WORKFLOW_GATES_COMMAND}\n          echo checked\n`,
      ),
    },
    {
      name: "real workflow rejects a replaced changes policy invocation",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      source: source.replace(
        [
          "      - name: Verify immutable actions and fail-closed required jobs",
          "        run: |",
          `          ${GATE_POLICY_SELF_TEST_COMMAND}`,
          `          ${GATE_POLICY_COMMAND}`,
          `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}`,
          `          ${WORKFLOW_GATES_COMMAND}`,
          `          ${LIBRUSTZCASH_POLICY_SELF_TEST_COMMAND}`,
          `          ${LIBRUSTZCASH_POLICY_COMMAND}`,
        ].join("\n"),
        [
          "      - name: Verify immutable actions and fail-closed required jobs",
          "        run: true",
        ].join("\n"),
      ),
    },
    {
      name: "real workflow rejects a dynamically dead changes policy",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      source: source.replace(
        "      - name: Verify immutable actions and fail-closed required jobs",
        "      - name: Verify immutable actions and fail-closed required jobs\n        if: false",
      ),
    },
    {
      name: "real workflow rejects a missing workflow-gates policy self-test",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      source: source.replace(
        `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}\n`,
        "",
      ),
    },
    {
      name: "real workflow rejects a missing workflow-gates policy verdict",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      source: source.replace(`          ${WORKFLOW_GATES_COMMAND}\n`, ""),
    },
    {
      name: "real workflow rejects a missing librustzcash policy self-test",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      source: source.replace(
        `          ${LIBRUSTZCASH_POLICY_SELF_TEST_COMMAND}\n`,
        "",
      ),
    },
    {
      name: "real workflow rejects a missing librustzcash policy verdict",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      source: source.replace(`          ${LIBRUSTZCASH_POLICY_COMMAND}\n`, ""),
    },
    {
      name: "real workflow rejects a missing WASM boundary policy",
      needle: "changes must contain exactly one Rust/WASM boundary policy step",
      source: source.replace(
        [
          "      - name: Verify the required Rust/WASM build boundary",
          "        run: |",
          `          ${WASM_POLICY_SELF_TEST_COMMAND}`,
          `          ${WASM_POLICY_COMMAND}`,
          "",
        ].join("\n"),
        "",
      ),
    },
    {
      name: "real workflow rejects a replaced WASM boundary verdict",
      needle:
        "changes WASM policy step must exactly self-test and enforce the current-source boundary",
      source: source.replace(
        `          ${WASM_POLICY_COMMAND}\n`,
        "          true\n",
      ),
    },
    {
      name: "real workflow rejects a dynamically dead WASM boundary policy",
      needle:
        "changes WASM policy step must exactly self-test and enforce the current-source boundary",
      source: source.replace(
        "      - name: Verify the required Rust/WASM build boundary",
        "      - name: Verify the required Rust/WASM build boundary\n        if: false",
      ),
    },
    {
      name: "real workflow rejects environment injection around the WASM policy",
      needle:
        "changes WASM policy step must exactly self-test and enforce the current-source boundary",
      source: source.replace(
        "      - name: Verify the required Rust/WASM build boundary\n        run: |",
        "      - name: Verify the required Rust/WASM build boundary\n        env:\n          NODE_OPTIONS: --import=./bypass.mjs\n        run: |",
      ),
    },
    {
      name: "real workflow rejects a decorative command around the WASM policy",
      needle:
        "changes WASM policy step must exactly self-test and enforce the current-source boundary",
      source: source.replace(
        `          ${WASM_POLICY_SELF_TEST_COMMAND}\n`,
        `          true\n          ${WASM_POLICY_SELF_TEST_COMMAND}\n`,
      ),
    },
    {
      name: "real workflow selector cannot narrow away future nested WASM Rust source",
      needle:
        "ZUULI selector must contain one active wallet/zuuli/* case pattern",
      source: source.replace(
        "wallet/zuuli/*|wallet/plugins/*",
        "wallet/zuuli/src/*|wallet/plugins/*",
      ),
    },
    {
      name: "real workflow selector cannot launder nested WASM coverage through a comment",
      needle:
        "ZUULI selector must contain one active wallet/zuuli/* case pattern",
      source: source.replace(
        "wallet/zuuli/*|wallet/plugins/*",
        "wallet/zuuli/src/*|wallet/plugins/* # wallet/zuuli/*|",
      ),
    },
    {
      name: "real workflow selector cannot omit the canonical toolchain verifier",
      needle: "ZUULI selector must cover scripts/check-rust-toolchain.sh",
      source: source.replace("|scripts/check-rust-toolchain.sh", ""),
    },
    {
      name: "real workflow selector cannot omit the librustzcash verifier",
      needle: "ZUULI selector must cover scripts/check-librustzcash-compat.mjs",
      source: source.replace("|scripts/check-librustzcash-compat.mjs", ""),
    },
    {
      name: "real workflow schema selector cannot omit the librustzcash verifier",
      needle:
        "Zuuallet schema selector must cover scripts/check-librustzcash-compat.mjs",
      source: replaceLast(source, "|scripts/check-librustzcash-compat.mjs", ""),
    },
    ...REQUIRED_CLASSIC_SEED_BOUNDARY_INPUTS.map((input) => ({
      name: `real workflow selects classic seed-boundary input ${input}`,
      needle: `ZUULI selector must run the seed boundary for classic input ${input}`,
      source: source.replace(`|${input}`, ""),
    })),
    {
      name: "real workflow rejects a deleted RTL policy self-test",
      needle: "RTL source policy must be self-tested and enforced exactly",
      source: replaceFrontend(
        "          node --test scripts/rtl-source-policy.node-test.mjs\n",
        "",
      ),
    },
    {
      name: "real workflow rejects a deleted RTL policy verdict",
      needle: "RTL source policy must be self-tested and enforced exactly",
      source: replaceFrontend(
        "          node scripts/rtl-source-policy.mjs\n",
        "",
      ),
    },
    {
      name: "real workflow rejects deletion of both RTL policy invocations",
      needle: "RTL source policy must be self-tested and enforced exactly",
      source: replaceFrontend(
        [
          "      - name: Verify RTL source policy",
          "        run: |",
          "          node --test scripts/rtl-source-policy.node-test.mjs",
          "          node scripts/rtl-source-policy.mjs",
          "",
        ].join("\n"),
        "",
      ),
    },
    {
      name: "real workflow rejects a soft-failing RTL policy step",
      needle: "RTL source policy must be self-tested and enforced exactly",
      source: replaceFrontend(
        "      - name: Verify RTL source policy",
        "      - name: Verify RTL source policy\n        continue-on-error: true",
      ),
    },
    {
      name: "real workflow rejects a decorative RTL policy verdict",
      needle: "RTL source policy must be self-tested and enforced exactly",
      source: replaceFrontend(
        "          node scripts/rtl-source-policy.mjs",
        "          true # node scripts/rtl-source-policy.mjs",
      ),
    },
    {
      name: "real workflow requires the unique frontend display context",
      needle:
        "frontend must match the complete exact current-source execution program",
      source: replaceFrontend("    name: zuuli / frontend\n", ""),
    },
    {
      name: "real workflow rejects a dynamically dead frontend job",
      needle:
        "frontend must run exactly when the fail-closed ZUULI selector is true",
      source: replaceFrontend(
        "    if: needs.changes.outputs.zuuli == 'true'",
        "    if: false",
      ),
    },
    {
      name: "real workflow rejects a stale frontend checkout ref",
      needle:
        "frontend must have one exact current-source checkout without a ref override",
      source: replaceFrontend(
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1`,
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1\n        with:\n          ref: stale-release`,
      ),
    },
    {
      name: "real workflow rejects a stale-source reset after frontend checkout",
      needle:
        "frontend must match the complete exact current-source execution program",
      source: replaceFrontend(
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1`,
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1\n      - name: Substitute stale frontend source after checkout\n        run: cd ../.. && git reset --hard HEAD~1`,
      ),
    },
    {
      name: "real workflow rejects a stale-source checkout after frontend checkout",
      needle:
        "frontend must match the complete exact current-source execution program",
      source: replaceFrontend(
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1`,
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1\n      - name: Check out stale frontend source\n        run: cd ../.. && git checkout HEAD~1`,
      ),
    },
    {
      name: "real workflow rejects frontend source overwrite after checkout",
      needle:
        "frontend must match the complete exact current-source execution program",
      source: replaceFrontend(
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1`,
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1\n      - name: Overwrite checked-out frontend source\n        run: printf stale > src/main.tsx`,
      ),
    },
    {
      name: "real workflow rejects frontend build-script substitution after checkout",
      needle:
        "frontend must match the complete exact current-source execution program",
      source: replaceFrontend(
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1`,
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1\n      - name: Substitute the WASM build script\n        run: cp package.json scripts/wasm-build.mjs`,
      ),
    },
    {
      name: "real workflow rejects an extra unnamed frontend step",
      needle:
        "frontend must match the complete exact current-source execution program",
      source: replaceFrontend(
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1`,
        `      - uses: ${FRONTEND_CHECKOUT_REFERENCE} # v7.0.1\n      - run: true`,
      ),
    },
    {
      name: "real workflow rejects stale-source substitution inside dependency install",
      needle:
        "frontend must match the complete exact current-source execution program",
      source: replaceFrontend(
        "      - name: Install locked dependencies\n        run: |\n          npm ci\n          npm ci --prefix ../zuuallet",
        "      - name: Install locked dependencies\n        run: |\n          cd ../.. && git reset --hard HEAD~1 && cd wallet/zuuli && npm ci\n          npm ci --prefix ../zuuallet",
      ),
    },
    {
      name: "real workflow rejects a skipped Rust/WASM compiler install",
      needle:
        "frontend Rust/WASM installation must be exact, pinned, unconditional, and non-decorative",
      source: replaceFrontend(
        "      - name: Install the pinned Rust/WASM compiler",
        "      - name: Install the pinned Rust/WASM compiler\n        if: false",
      ),
    },
    {
      name: "real workflow rejects a skipped production WASM build",
      needle:
        "frontend production build must invoke the exact package contract unconditionally",
      source: replaceFrontend(
        "      - name: Build production frontend",
        "      - name: Build production frontend\n        if: false",
      ),
    },
    {
      name: "real workflow rejects a decorative production build wrapper",
      needle:
        "frontend production build must invoke the exact package contract unconditionally",
      source: replaceFrontend(
        "      - name: Build production frontend\n        run: npm run build",
        "      - name: Build production frontend\n        run: |\n          npm run build\n          true",
      ),
    },
    {
      name: "real workflow rejects environment injection around the production build",
      needle:
        "frontend production build must invoke the exact package contract unconditionally",
      source: replaceFrontend(
        "      - name: Build production frontend\n        run: npm run build",
        "      - name: Build production frontend\n        env:\n          BASH_ENV: ./bypass.sh\n        run: npm run build",
      ),
    },
    {
      name: "real workflow rejects alternate frontend working-directory defaults",
      needle:
        "required job frontend defaults.run.working-directory differs from its exact reviewed value",
      source: replaceFrontend(
        "        working-directory: wallet/zuuli",
        "        working-directory: wallet/zuuli/wasm-spike",
      ),
    },
    {
      name: "real workflow rejects a soft-failing changes policy",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      source: source.replace(
        "      - name: Verify immutable actions and fail-closed required jobs",
        "      - name: Verify immutable actions and fail-closed required jobs\n        continue-on-error: true",
      ),
    },
    {
      name: "real workflow rejects a soft-failing required gate",
      needle:
        "job-level continue-on-error is forbidden on required-gate job gate",
      source: source.replace(
        "  gate:\n",
        "  gate:\n    continue-on-error: true\n",
      ),
    },
    {
      name: "real workflow rejects a syntax-only gate default shell",
      needle: "required job gate defaults.run.shell must be exactly bash",
      source: source.replace(
        "    timeout-minutes: 5\n    steps:\n      # Re-run the workflow policy here",
        [
          "    timeout-minutes: 5",
          "    defaults:",
          "      run:",
          "        shell: bash -n {0}",
          "    steps:",
          "      # Re-run the workflow policy here",
        ].join("\n"),
      ),
    },
    {
      name: "real workflow rejects a syntax-only workflow default shell",
      needle: "required workflow defaults.run.shell must be exactly bash",
      source: source.replace(
        "permissions:\n  contents: read",
        [
          "defaults:",
          "  run:",
          "    shell: sh -n {0}",
          "",
          "permissions:",
          "  contents: read",
        ].join("\n"),
      ),
    },
    {
      name: "real workflow rejects a syntax-only required step shell",
      needle: "required job changes step shell must be exactly bash",
      source: source.replace(
        "        shell: bash\n",
        "        shell: bash -n {0}\n",
      ),
    },
    {
      name: "real workflow rejects workflow-level SHELLOPTS noexec",
      needle:
        "required workflow environment differs from its exact reviewed allowlist",
      source: source.replace(
        "env:\n  CARGO_TERM_COLOR: always\n",
        "env:\n  SHELLOPTS: noexec\n  CARGO_TERM_COLOR: always\n",
      ),
    },
    {
      name: "real workflow rejects gate-level NODE_OPTIONS startup injection",
      needle:
        "required job gate environment differs from its exact reviewed allowlist",
      source: source.replace(
        "  gate:\n",
        '  gate:\n    env:\n      NODE_OPTIONS: "--import=data:text/javascript,process.exit(0)"\n',
      ),
    },
    {
      name: "real workflow rejects gate-step imported node function",
      needle:
        "required job gate step Verify required jobs succeeded or legitimately skipped environment differs from its exact reviewed allowlist",
      source: source.replace(
        "        env:\n          POLICY_OUTCOME: ${{ steps.policy.outcome }}\n",
        "        env:\n          'BASH_FUNC_node%%': '() { return 0; }'\n          POLICY_OUTCOME: ${{ steps.policy.outcome }}\n",
      ),
    },
    {
      name: "real workflow rejects PATH injection on a required step",
      needle:
        "required job changes step Detect release-impacting ZUULI changes environment differs from its exact reviewed allowlist",
      source: source.replace(
        "        env:\n          BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}\n",
        "        env:\n          BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}\n          PATH: ./ci-shims\n",
      ),
    },
    {
      name: "real workflow requires its reviewed environment",
      needle:
        "required workflow environment differs from its exact reviewed allowlist",
      source: source.replace(
        "env:\n  CARGO_TERM_COLOR: always\n  RUST_BACKTRACE: 1\n\n",
        "",
      ),
    },
    {
      name: "real workflow requires the schema job environment",
      needle:
        "required job zuuallet_schema environment differs from its exact reviewed allowlist",
      source: source.replace(
        "    env:\n      CARGO_TARGET_DIR: ${{ github.workspace }}/target\n",
        "",
      ),
    },
    {
      name: "real workflow requires the ZUULI build nonce environment",
      needle:
        "required job rust_app step Build ZUULI Tauri backend environment differs from its exact reviewed allowlist",
      source: source.replace(
        [
          "        env:",
          "          # The build script watches this value. Changing it on every attempt",
          "          # forces schema generation even when Cargo artifacts were restored.",
          "          TAURI_SCHEMA_GENERATION_NONCE: ${{ github.run_id }}-${{ github.run_attempt }}",
          "          TAURI_PERMISSION_GENERATION_NONCE: ${{ github.run_id }}-${{ github.run_attempt }}",
        ].join("\n") + "\n",
        "",
      ),
    },
    {
      name: "real workflow requires the Zuuallet schema nonce environment",
      needle:
        "required job zuuallet_schema step Regenerate Zuuallet permissions and target schema environment differs from its exact reviewed allowlist",
      source: source.replace(
        [
          "        env:",
          "          # These values are build-script inputs, so restored Cargo artifacts",
          "          # cannot turn this freshness assertion into a no-op.",
          "          TAURI_SCHEMA_GENERATION_NONCE: ${{ github.run_id }}-${{ github.run_attempt }}",
          "          TAURI_PERMISSION_GENERATION_NONCE: ${{ github.run_id }}-${{ github.run_attempt }}",
        ].join("\n") + "\n",
        "",
      ),
    },
    {
      name: "real workflow requires the change-detector environment",
      needle:
        "required job changes step Detect release-impacting ZUULI changes environment differs from its exact reviewed allowlist",
      source: source.replace(
        "        env:\n          BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}\n",
        "",
      ),
    },
    {
      name: "real workflow requires the gate verdict environment",
      needle:
        "required job gate step Verify required jobs succeeded or legitimately skipped environment differs from its exact reviewed allowlist",
      source: source.replace(
        "        env:\n          POLICY_OUTCOME: ${{ steps.policy.outcome }}\n          REQUIRED_JOBS_JSON: ${{ toJSON(needs) }}\n",
        "",
      ),
    },
    {
      name: "real workflow rejects Android job-level SHELLOPTS noexec",
      needle:
        "required job rust_android_32 environment differs from its exact reviewed allowlist",
      source: source.replace(
        "  rust_android_32:\n",
        "  rust_android_32:\n    env:\n      SHELLOPTS: noexec\n",
      ),
    },
    {
      name: "real workflow rejects Android typecheck-step SHELLOPTS noexec",
      needle:
        "required job rust_android_32 step Type-check the shared plugin on 32-bit Android environment differs from its exact reviewed allowlist",
      source: source.replace(
        "      - name: Type-check the shared plugin on 32-bit Android\n        run: |\n",
        "      - name: Type-check the shared plugin on 32-bit Android\n        env:\n          SHELLOPTS: noexec\n        run: |\n",
      ),
    },
    {
      name: "real workflow rejects required-container environment options",
      needle:
        "required job rust_clippy container cannot inject environment or runtime options",
      source: source.replace(
        "      image: ghcr.io/free2z/zuuli-linux-ci@sha256:e94d8795fd3c3265caec0f5fc2fa814391e22d2d6e574649a75e686e6e967406\n      credentials:\n",
        "      image: ghcr.io/free2z/zuuli-linux-ci@sha256:e94d8795fd3c3265caec0f5fc2fa814391e22d2d6e574649a75e686e6e967406\n      options: --env SHELLOPTS=noexec\n      credentials:\n",
      ),
    },
    {
      name: "real workflow rejects redirected Rust plugin tests",
      needle:
        "required job rust_plugin step Build and test shared Zcash plugin working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Build and test shared Zcash plugin\n        run: cargo test --locked --all-targets --features production-route-probe --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml\n",
        "      - name: Build and test shared Zcash plugin\n        working-directory: bypass\n        run: cargo test --locked --all-targets --features production-route-probe --manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml\n",
      ),
    },
    {
      name: "real workflow rejects a changes-job default working directory",
      needle:
        "required job changes defaults.run.working-directory differs from its exact reviewed value",
      source: source.replace(
        "    timeout-minutes: 5\n    outputs:\n",
        "    timeout-minutes: 5\n    defaults:\n      run:\n        working-directory: bypass\n    outputs:\n",
      ),
    },
    {
      name: "real workflow rejects a redirected changes policy step",
      needle:
        "required job changes step Verify immutable actions and fail-closed required jobs working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Verify immutable actions and fail-closed required jobs\n        run: |\n",
        "      - name: Verify immutable actions and fail-closed required jobs\n        working-directory: bypass\n        run: |\n",
      ),
    },
    {
      name: "real workflow rejects a gate-job default working directory",
      needle:
        "required job gate defaults.run.working-directory differs from its exact reviewed value",
      source: source.replace(
        "    timeout-minutes: 5\n    steps:\n      # Re-run the workflow policy here",
        "    timeout-minutes: 5\n    defaults:\n      run:\n        working-directory: bypass\n    steps:\n      # Re-run the workflow policy here",
      ),
    },
    {
      name: "real workflow rejects a redirected gate policy step",
      needle:
        "required job gate step Recheck immutable actions and fail-closed required jobs working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Recheck immutable actions and fail-closed required jobs\n        id: policy\n",
        "      - name: Recheck immutable actions and fail-closed required jobs\n        id: policy\n        working-directory: bypass\n",
      ),
    },
    {
      name: "real workflow rejects an Android-job default working directory",
      needle:
        "required job rust_android_32 defaults.run.working-directory differs from its exact reviewed value",
      source: source.replace(
        "  rust_android_32:\n    name: Rust / Android 32-bit\n",
        "  rust_android_32:\n    name: Rust / Android 32-bit\n    defaults:\n      run:\n        working-directory: bypass\n",
      ),
    },
    {
      name: "real workflow rejects a redirected Android policy-control step",
      needle:
        "required job changes step Verify the required 32-bit Android type-check policy working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Verify the required 32-bit Android type-check policy\n        run: |\n",
        "      - name: Verify the required 32-bit Android type-check policy\n        working-directory: bypass\n        run: |\n",
      ),
    },
    {
      name: "real workflow rejects a redirected Android typecheck step",
      needle:
        "required job rust_android_32 step Type-check the shared plugin on 32-bit Android working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Type-check the shared plugin on 32-bit Android\n        run: |\n",
        "      - name: Type-check the shared plugin on 32-bit Android\n        working-directory: bypass\n        run: |\n",
      ),
    },
    {
      name: "real workflow rejects a workflow default working directory",
      needle:
        "required workflow defaults.run.working-directory differs from its exact reviewed value",
      source: source.replace(
        "permissions:\n  contents: read",
        "defaults:\n  run:\n    working-directory: bypass\n\npermissions:\n  contents: read",
      ),
    },
    {
      name: "real workflow requires the reviewed frontend default working directory",
      needle:
        "required job frontend defaults.run.working-directory differs from its exact reviewed value",
      source: source.replace("        working-directory: wallet/zuuli\n", ""),
    },
    {
      name: "real workflow requires reviewed image-verification working directories",
      needle:
        "required job rust_clippy step Verify pinned Linux build image working-directory differs from its exact reviewed value",
      source: source.replace(
        "      - name: Verify pinned Linux build image\n        working-directory: /\n",
        "      - name: Verify pinned Linux build image\n",
      ),
    },
    {
      name: "real workflow rejects a syntax-only dependency default shell",
      needle:
        "required job zuuallet_schema defaults.run.shell must be exactly bash",
      source: source.replace(
        "    defaults:\n      run:\n        shell: bash\n    env:\n      CARGO_TARGET_DIR: ${{ github.workspace }}/target",
        "    defaults:\n      run:\n        shell: bash -n {0}\n    env:\n      CARGO_TARGET_DIR: ${{ github.workspace }}/target",
      ),
    },
    {
      name: "real workflow rejects soft-failing required dependency",
      needle:
        "job-level continue-on-error is forbidden on required-gate job rust_app",
      source: source.replace(
        "  rust_app:\n",
        "  rust_app:\n    continue-on-error: true\n",
      ),
    },
  ];

  for (const mutation of mutations) {
    if (mutation.source === source) {
      throw new Error(`${mutation.name}: mutation target was not found`);
    }
    const failures = gatePolicyFailures(
      repoRoot,
      relative,
      mutation.source.split(/\r?\n/),
    );
    if (!failures.some((failure) => failure.includes(mutation.needle))) {
      throw new Error(
        `${mutation.name}: expected ${JSON.stringify(mutation.needle)}, got ${failures.join("; ")}`,
      );
    }
    console.log(`self-test: ${mutation.name}: passed`);
  }
  let cryptoInputMutations = 0;
  for (const input of REQUIRED_CRYPTO_PROBE_INPUTS.keys()) {
    const original = fs.readFileSync(path.resolve(repoRoot, input));
    const failures = cryptoProbeInputFailures(
      repoRoot,
      new Map([[input, Buffer.concat([original, Buffer.from("\nmutated")])]]),
    );
    if (
      !failures.some((failure) =>
        failure.includes("differs from its reviewed digest"),
      )
    ) {
      throw new Error(`crypto input mutation escaped policy: ${input}`);
    }
    cryptoInputMutations += 1;
    console.log(
      `self-test: crypto input digest rejects mutation: ${input}: passed`,
    );
  }
  const reviewedScope = reviewedCompatibilityScope();
  const baselineScopeFailures = librustzcashScopeFailures(reviewedScope);
  if (baselineScopeFailures.length) {
    throw new Error(
      `reviewed librustzcash scope is not a valid mutation base: ${baselineScopeFailures.join("; ")}`,
    );
  }
  const scopeMutants = [
    ...reviewedScope.lockfiles.map((lockfile) => ({
      name: `external scope contract rejects deleting lock ${lockfile}`,
      scope: {
        lockfiles: reviewedScope.lockfiles.filter(
          (candidate) => candidate !== lockfile,
        ),
        packages: new Map(reviewedScope.packages),
      },
      needle: "must guard exactly 3 shipping locks",
    })),
    ...[...reviewedScope.packages].map(([name]) => ({
      name: `external scope contract rejects deleting package ${name}`,
      scope: {
        lockfiles: [...reviewedScope.lockfiles],
        packages: new Map(
          [...reviewedScope.packages].filter(
            ([candidate]) => candidate !== name,
          ),
        ),
      },
      needle: "must guard exactly 11 packages",
    })),
    {
      name: "external scope digest rejects a package change with stable counts",
      scope: {
        lockfiles: [...reviewedScope.lockfiles],
        packages: new Map(
          [...reviewedScope.packages].map(([name, version]) => [
            name,
            name === "orchard" ? `${version}-scope-mutant` : version,
          ]),
        ),
      },
      needle: "inventory differs from its independently reviewed digest",
    },
  ];
  for (const mutation of scopeMutants) {
    const failures = librustzcashScopeFailures(mutation.scope);
    if (!failures.some((failure) => failure.includes(mutation.needle))) {
      throw new Error(
        `${mutation.name}: expected ${JSON.stringify(mutation.needle)}, got ${failures.join("; ")}`,
      );
    }
    console.log(`self-test: ${mutation.name}: passed`);
  }
  return mutations.length + cryptoInputMutations + scopeMutants.length;
}

function runFrontendBuildContractMutationTests(repoRoot) {
  const relativeFiles = [
    "wallet/zuuli/package.json",
    "wallet/zuuallet/package.json",
    "wallet/zuuli/tsconfig.build.json",
  ];
  const sources = new Map(
    relativeFiles.map((relative) => [
      relative,
      fs.readFileSync(path.join(repoRoot, relative), "utf8"),
    ]),
  );
  const baseline = scanRepository(repoRoot).failures;
  if (baseline.length) {
    throw new Error(
      `current frontend build inputs are not a valid mutation base: ${baseline.join("; ")}`,
    );
  }

  const mutations = [];
  const mutateJson = (relative, mutate) => {
    const value = JSON.parse(sources.get(relative));
    mutate(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  };
  const addMutation = (name, relative, mutate, needle) => {
    mutations.push({
      name,
      needle,
      overrides: new Map([[relative, mutateJson(relative, mutate)]]),
    });
  };

  for (const script of REQUIRED_FRONTEND_PACKAGE_SCRIPTS.keys()) {
    addMutation(
      `live frontend package contract rejects no-op ${script}`,
      "wallet/zuuli/package.json",
      (manifest) => {
        manifest.scripts[script] = "true";
      },
      `package script ${JSON.stringify(script)} must equal`,
    );
  }
  addMutation(
    "live frontend package contract rejects narrowed Vitest and Playwright discovery",
    "wallet/zuuli/package.json",
    (manifest) => {
      manifest.scripts.test =
        "vitest run src/lib/format.test.ts && playwright test tests/fonts.pw.ts";
    },
    'package script "test" must equal',
  );
  addMutation(
    "live classic package contract rejects a no-op mounted route test",
    "wallet/zuuallet/package.json",
    (manifest) => {
      manifest.scripts["test:sensitive-entry"] = "true";
    },
    'package script "test:sensitive-entry" must equal',
  );
  addMutation(
    "live classic package contract rejects a substituted test path",
    "wallet/zuuallet/package.json",
    (manifest) => {
      manifest.scripts["test:sensitive-entry"] =
        "vitest run src/pages/Settings.tsx";
    },
    'package script "test:sensitive-entry" must equal',
  );
  addMutation(
    "live production tsconfig rejects noCheck",
    "wallet/zuuli/tsconfig.build.json",
    (tsconfig) => {
      tsconfig.compilerOptions = { noCheck: true };
    },
    "must contain exactly the reviewed extends and exclude keys",
  );
  addMutation(
    "live production tsconfig rejects a missing exclude contract",
    "wallet/zuuli/tsconfig.build.json",
    (tsconfig) => {
      delete tsconfig.exclude;
    },
    "must contain exactly the reviewed extends and exclude keys",
  );
  addMutation(
    "live production tsconfig rejects narrowed test excludes",
    "wallet/zuuli/tsconfig.build.json",
    (tsconfig) => {
      tsconfig.exclude = [tsconfig.exclude[0]];
    },
    "exclude must equal",
  );
  addMutation(
    "live production tsconfig rejects widened test excludes",
    "wallet/zuuli/tsconfig.build.json",
    (tsconfig) => {
      tsconfig.exclude.push("src/**/*.tsx");
    },
    "exclude must equal",
  );
  addMutation(
    "live production tsconfig rejects reordered test excludes",
    "wallet/zuuli/tsconfig.build.json",
    (tsconfig) => {
      tsconfig.exclude.reverse();
    },
    "exclude must equal",
  );
  addMutation(
    "live production tsconfig rejects a substituted base config",
    "wallet/zuuli/tsconfig.build.json",
    (tsconfig) => {
      tsconfig.extends = "./tsconfig.node.json";
    },
    "extends must equal",
  );

  for (const mutation of mutations) {
    const failures = scanRepository(repoRoot, {
      frontendBuildContractOverrides: mutation.overrides,
    }).failures;
    if (!failures.some((failure) => failure.includes(mutation.needle))) {
      throw new Error(
        `${mutation.name}: expected ${JSON.stringify(mutation.needle)}, got ${failures.join("; ") || "success"}`,
      );
    }
    console.log(`self-test: ${mutation.name}: passed`);
  }
  return mutations.length;
}

function runSelfTest(repoRoot) {
  const fullSha = "0123456789abcdef0123456789abcdef01234567";
  const gateFixture = (contents) => ({
    ".github/workflows/zuuli.yml": contents,
  });
  const gateCheckoutLines = [
    `      - uses: ${GATE_CHECKOUT_REFERENCE} # v7.0.1`,
  ];
  const gatePolicyLines = [
    "      - name: Recheck immutable actions and fail-closed required jobs",
    "        id: policy",
    "        run: |",
    `          ${GATE_POLICY_SELF_TEST_COMMAND}`,
    `          ${GATE_POLICY_COMMAND}`,
    `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}`,
    `          ${WORKFLOW_GATES_COMMAND}`,
  ];
  const gateVerdictLines = [
    "      - name: Verify required jobs succeeded or legitimately skipped",
    "        env:",
    "          POLICY_OUTCOME: ${{ steps.policy.outcome }}",
    "          REQUIRED_JOBS_JSON: ${{ toJSON(needs) }}",
    "        run: |",
    `          ${GATE_POLICY_COMMAND}`,
    `          ${GATE_VERDICT_COMMAND}`,
  ];
  const validGateWorkflow = [
    "name: required gate fixture",
    "on: pull_request",
    "env:",
    "  CARGO_TERM_COLOR: always",
    "  RUST_BACKTRACE: 1",
    "jobs:",
    "  changes:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Verify immutable actions and fail-closed required jobs",
    "        run: |",
    `          ${GATE_POLICY_SELF_TEST_COMMAND}`,
    `          ${GATE_POLICY_COMMAND}`,
    `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}`,
    `          ${WORKFLOW_GATES_COMMAND}`,
    `          ${LIBRUSTZCASH_POLICY_SELF_TEST_COMMAND}`,
    `          ${LIBRUSTZCASH_POLICY_COMMAND}`,
    "      - name: Verify the required Rust/WASM build boundary",
    "        run: |",
    `          ${WASM_POLICY_SELF_TEST_COMMAND}`,
    `          ${WASM_POLICY_COMMAND}`,
    "  advisory:",
    "    continue-on-error: true",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: exit 1",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: a legitimate best-effort step",
    "        continue-on-error: true",
    "        run: echo 'step-level continue-on-error: true is allowed'",
    "  gate:",
    "    needs: [changes, build]",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...gateCheckoutLines,
    ...gatePolicyLines,
    ...gateVerdictLines,
    "",
  ].join("\n");
  const withGatePolicyLines = (lines) =>
    validGateWorkflow.replace(gatePolicyLines.join("\n"), lines.join("\n"));
  const reusableBuildJob = [
    "  build:",
    "    uses: ./.github/workflows/required-build.yml",
  ].join("\n");
  const reusableGateWorkflow = validGateWorkflow.replace(
    [
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: a legitimate best-effort step",
      "        continue-on-error: true",
      "        run: echo 'step-level continue-on-error: true is allowed'",
    ].join("\n"),
    reusableBuildJob,
  );
  const reusableBuildWorkflow = [
    "name: required reusable build",
    "on:",
    "  workflow_call:",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: npm test",
    "",
  ].join("\n");
  const cases = [
    {
      name: "valid pinned, quoted, reusable, and nested-local references",
      valid: true,
      files: {
        ".github/workflows/gate.yml": `steps:\n  - uses: ./.github/actions/outer\n  - uses: owner/action@${fullSha} # v1.2.3\n  - uses: "owner/repo/.github/workflows/reuse.yml@${fullSha}" # v4\n`,
        ".github/actions/outer/action.yml":
          "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/inner\n",
        ".github/actions/inner/action.yaml": `runs:\n  using: composite\n  steps:\n    - uses: 'owner/nested@${fullSha}' # v2\n`,
      },
    },
    {
      name: "valid required gate permits advisory jobs and best-effort steps",
      valid: true,
      files: gateFixture(validGateWorkflow),
    },
    {
      name: "valid required gate may call a local reusable workflow without environment blocks",
      valid: true,
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow,
      },
    },
    {
      name: "required reusable workflow rejects workflow-level BASH_ENV",
      needle:
        "required workflow environment differs from its exact reviewed allowlist",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "jobs:\n",
          "env:\n  BASH_ENV: bypass-gate.sh\njobs:\n",
        ),
      },
    },
    {
      name: "required reusable workflow rejects job-level SHELLOPTS",
      needle:
        "required job build environment differs from its exact reviewed allowlist",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "  build:\n",
          "  build:\n    env:\n      SHELLOPTS: noexec\n",
        ),
      },
    },
    {
      name: "required reusable workflow rejects step-level PATH replacement",
      needle:
        "required job build step <unnamed> environment differs from its exact reviewed allowlist",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "      - run: npm test\n",
          "      - env:\n          PATH: ./ci-shims\n        run: npm test\n",
        ),
      },
    },
    {
      name: "nested required reusable workflow rejects NODE_OPTIONS",
      needle:
        "required job nested environment differs from its exact reviewed allowlist",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "    runs-on: ubuntu-latest\n    steps:\n      - run: npm test",
          "    uses: ./.github/workflows/nested-build.yml",
        ),
        ".github/workflows/nested-build.yml": [
          "on:",
          "  workflow_call:",
          "jobs:",
          "  nested:",
          "    env:",
          '      NODE_OPTIONS: "--import=data:text/javascript,process.exit(0)"',
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: cargo test",
          "",
        ].join("\n"),
      },
    },
    {
      name: "quoted BASH_FUNC key cannot hide required-job environment injection",
      needle:
        "required job build environment differs from its exact reviewed allowlist",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    env:\n      'BASH_FUNC_node%%': '() { return 0; }'\n",
        ),
      ),
    },
    {
      name: "inline required-job environment maps fail closed",
      needle:
        "required job build environment must use a canonical block mapping",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    env: { SHELLOPTS: noexec }\n",
        ),
      ),
    },
    {
      name: "required-step environment merge aliases fail closed",
      needle: "cannot use YAML merge keys or aliases",
      files: gateFixture(
        validGateWorkflow.replace(
          "      - name: a legitimate best-effort step\n",
          "      - name: a legitimate best-effort step\n        env:\n          <<: *execution-environment\n",
        ),
      ),
    },
    {
      name: "required reusable workflow rejects a default working directory",
      needle:
        "required job build defaults.run.working-directory differs from its exact reviewed value",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "    runs-on: ubuntu-latest\n",
          "    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: bypass\n",
        ),
      },
    },
    {
      name: "required reusable workflow rejects a step working directory",
      needle:
        "required job build step <unnamed> working-directory differs from its exact reviewed value",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "      - run: npm test\n",
          "      - working-directory: bypass\n        run: npm test\n",
        ),
      },
    },
    {
      name: "quoted working-directory keys remain policy-visible",
      needle:
        "required job build step a legitimate best-effort step working-directory differs from its exact reviewed value",
      files: gateFixture(
        validGateWorkflow.replace(
          "      - name: a legitimate best-effort step\n",
          "      - name: a legitimate best-effort step\n        'working-directory': bypass\n",
        ),
      ),
    },
    {
      name: "inline required-job defaults fail closed",
      needle: "required job build defaults must use a canonical block mapping",
      files: gateFixture(
        validGateWorkflow.replace(
          "    runs-on: ubuntu-latest\n    steps:\n      - name: a legitimate best-effort step\n",
          "    runs-on: ubuntu-latest\n    defaults: { run: { working-directory: bypass } }\n    steps:\n      - name: a legitimate best-effort step\n",
        ),
      ),
    },
    {
      name: "required-job default working-directory merge aliases fail closed",
      needle: "defaults.run contains an unsupported or duplicate property",
      files: gateFixture(
        validGateWorkflow.replace(
          "    runs-on: ubuntu-latest\n    steps:\n      - name: a legitimate best-effort step\n",
          "    runs-on: ubuntu-latest\n    defaults:\n      run:\n        <<: *redirected-defaults\n    steps:\n      - name: a legitimate best-effort step\n",
        ),
      ),
    },
    {
      name: "required reusable workflow cannot inherit a syntax-only shell",
      needle: "required job build defaults.run.shell must be exactly bash",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "    runs-on: ubuntu-latest\n",
          [
            "    runs-on: ubuntu-latest",
            "    defaults:",
            "      run:",
            "        shell: bash -n {0}",
            "",
          ].join("\n"),
        ),
      },
    },
    {
      name: "required workflow cannot select a dynamic default shell",
      needle: "required workflow defaults.run.shell must be exactly bash",
      files: gateFixture(
        validGateWorkflow.replace(
          "on: pull_request\n",
          [
            "on: pull_request",
            "defaults:",
            "  run:",
            "    shell: ${{ inputs.shell }}",
            "",
          ].join("\n"),
        ),
      ),
    },
    {
      name: "required dependency cannot override a step with a non-bash shell",
      needle: "required job build step shell must be exactly bash",
      files: gateFixture(
        validGateWorkflow.replace(
          "      - name: a legitimate best-effort step\n",
          "      - name: a legitimate best-effort step\n        shell: python {0}\n",
        ),
      ),
    },
    {
      name: "reindented required steps cannot hide a shell override",
      needle:
        "required job build steps must begin with a canonical block-sequence entry",
      files: gateFixture(
        validGateWorkflow.replace(
          [
            "    steps:",
            "      - name: a legitimate best-effort step",
            "        continue-on-error: true",
            "        run: echo 'step-level continue-on-error: true is allowed'",
          ].join("\n"),
          [
            "    steps:",
            "        - name: a legitimate best-effort step",
            "          shell: bash -n {0}",
            "          run: echo hidden",
          ].join("\n"),
        ),
      ),
    },
    {
      name: "required reusable workflow cannot soft-fail an internal job",
      needle:
        "job-level continue-on-error is forbidden in required reusable workflow job build",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "  build:\n",
          "  build:\n    continue-on-error: true\n",
        ),
      },
    },
    {
      name: "nested required reusable workflow cannot hide a soft-failing job",
      needle:
        "job-level continue-on-error is forbidden in required reusable workflow job nested",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "    runs-on: ubuntu-latest\n    steps:\n      - run: npm test",
          "    uses: ./.github/workflows/nested-build.yml",
        ),
        ".github/workflows/nested-build.yml": [
          "on:",
          "  workflow_call:",
          "jobs:",
          "  nested:",
          "    continue-on-error: true",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: cargo test",
          "",
        ].join("\n"),
      },
    },
    {
      name: "external reusable workflow is forbidden as a gate dependency",
      needle:
        "required-gate job build must call a repository-local reusable workflow",
      files: gateFixture(
        reusableGateWorkflow.replace(
          "./.github/workflows/required-build.yml",
          `owner/repo/.github/workflows/build.yml@${fullSha} # reviewed`,
        ),
      ),
    },
    {
      name: "external reusable workflow is forbidden behind a local callee",
      needle:
        "required reusable workflow job build must call a repository-local workflow",
      files: {
        ...gateFixture(reusableGateWorkflow),
        ".github/workflows/required-build.yml": reusableBuildWorkflow.replace(
          "    runs-on: ubuntu-latest\n    steps:\n      - run: npm test",
          `    uses: owner/repo/.github/workflows/build.yml@${fullSha} # reviewed`,
        ),
      },
    },
    {
      name: "non-required workflows may use valid noncanonical indentation",
      valid: true,
      files: {
        ".github/workflows/formatted.yml": [
          "name: formatter output",
          "on: pull_request",
          "jobs:",
          "   formatted:",
          "      runs-on: ubuntu-latest",
          "      steps:",
          "      - run: true",
          "",
        ].join("\n"),
      },
    },
    {
      name: "tab-indented required control fails closed",
      needle: "tabs are unsupported in YAML indentation",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n\tcontinue-on-error: true\n",
        ),
      ),
    },
    {
      name: "changes policy invocation cannot be replaced",
      needle:
        "changes policy step must exactly self-test and enforce the current-source policy",
      files: gateFixture(
        validGateWorkflow.replace(
          `        run: |\n          ${GATE_POLICY_SELF_TEST_COMMAND}\n          ${GATE_POLICY_COMMAND}\n          ${WORKFLOW_GATES_SELF_TEST_COMMAND}\n          ${WORKFLOW_GATES_COMMAND}\n          ${LIBRUSTZCASH_POLICY_SELF_TEST_COMMAND}\n          ${LIBRUSTZCASH_POLICY_COMMAND}\n`,
          "        run: true\n",
        ),
      ),
    },
    {
      name: "gate dependency cannot use job-level continue-on-error",
      needle:
        "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    continue-on-error: true\n",
        ),
      ),
    },
    {
      name: "false job-level continue-on-error is still forbidden",
      needle:
        "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    continue-on-error: false\n",
        ),
      ),
    },
    {
      name: "escaped quoted key cannot hide job-level continue-on-error",
      needle:
        "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          '  build:\n    "continue-\\u006fn-error": true\n',
        ),
      ),
    },
    {
      name: "single-quoted key cannot hide job-level continue-on-error",
      needle:
        "job-level continue-on-error is forbidden on required-gate job build",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    'continue-on-error': true\n",
        ),
      ),
    },
    {
      name: "decorated job property fails closed",
      needle: "must use an undecorated block mapping key",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    &policy continue-on-error: true\n",
        ),
      ),
    },
    {
      name: "explicit job property fails closed",
      needle: "must use an undecorated block mapping key",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    ? continue-on-error\n    : true\n",
        ),
      ),
    },
    {
      name: "job merge aliases fail closed",
      needle: "cannot use YAML merge keys or aliases",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n",
          "  build:\n    <<: *soft-failure\n",
        ),
      ),
    },
    {
      name: "inline job maps fail closed",
      needle: "must use a block mapping",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: a legitimate best-effort step\n        continue-on-error: true\n        run: echo 'step-level continue-on-error: true is allowed'\n",
          "  build: { runs-on: ubuntu-latest, continue-on-error: true }\n",
        ),
      ),
    },
    {
      name: "reindented direct job properties fail closed",
      needle: "job build must use canonical four-space property indentation",
      files: gateFixture(
        validGateWorkflow.replace(
          "  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: a legitimate best-effort step\n        continue-on-error: true\n        run: echo 'step-level continue-on-error: true is allowed'\n",
          "  build:\n      continue-on-error: true\n      runs-on: ubuntu-latest\n      steps:\n        - run: exit 1\n",
        ),
      ),
    },
    {
      name: "required gate itself cannot ignore failures",
      needle:
        "job-level continue-on-error is forbidden on required-gate job gate",
      files: gateFixture(
        validGateWorkflow.replace(
          "  gate:\n",
          "  gate:\n    continue-on-error: true\n",
        ),
      ),
    },
    {
      name: "block-sequence gate needs remain supported",
      valid: true,
      files: gateFixture(
        validGateWorkflow.replace(
          "    needs: [changes, build]\n",
          "    needs:\n      - changes\n      - build\n",
        ),
      ),
    },
    {
      name: "future gate dependency is covered by the complete needs context",
      valid: true,
      files: gateFixture(
        validGateWorkflow
          .replace(
            "  gate:\n",
            "  rust_android_32:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cargo check\n  gate:\n",
          )
          .replace(
            "    needs: [changes, build]\n",
            "    needs: [changes, build, rust_android_32]\n",
          ),
      ),
    },
    {
      name: "logging the needs context cannot replace the enforcing verdict",
      needle:
        "must unconditionally recheck policy and enforce the complete needs context",
      files: gateFixture(
        validGateWorkflow.replace(
          `          ${GATE_VERDICT_COMMAND}\n`,
          '          echo "$REQUIRED_JOBS_JSON"\n',
        ),
      ),
    },
    {
      name: "dynamically dead verdict use fails closed",
      needle:
        "must unconditionally recheck policy and enforce the complete needs context",
      files: gateFixture(
        validGateWorkflow.replace(
          gateVerdictLines[0],
          `${gateVerdictLines[0]}\n        if: github.event_name == '__never__'`,
        ),
      ),
    },
    {
      name: "deleted gate checkout fails closed",
      needle:
        "must contain exactly checkout, policy recheck, and enforcing verdict steps",
      files: gateFixture(
        validGateWorkflow.replace(`${gateCheckoutLines.join("\n")}\n`, ""),
      ),
    },
    {
      name: "skipped gate checkout fails closed",
      needle: "gate checkout must be exact, current-source, and unconditional",
      files: gateFixture(
        validGateWorkflow.replace(
          gateCheckoutLines[0],
          `${gateCheckoutLines[0]}\n        if: false`,
        ),
      ),
    },
    {
      name: "deleted gate policy recheck fails closed",
      needle:
        "must contain exactly checkout, policy recheck, and enforcing verdict steps",
      files: gateFixture(
        validGateWorkflow.replace(`${gatePolicyLines.join("\n")}\n`, ""),
      ),
    },
    {
      name: "dynamically dead gate policy recheck fails closed",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      files: gateFixture(
        validGateWorkflow.replace(
          gatePolicyLines[0],
          `${gatePolicyLines[0]}\n        if: github.event_name == '__never__'`,
        ),
      ),
    },
    {
      name: "soft-failing gate policy recheck fails closed",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      files: gateFixture(
        validGateWorkflow.replace(
          gatePolicyLines[0],
          `${gatePolicyLines[0]}\n        continue-on-error: true`,
        ),
      ),
    },
    {
      name: "deleted gate workflow-policy self-test fails closed",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      files: gateFixture(
        withGatePolicyLines(
          gatePolicyLines.filter(
            (line) => line !== `          ${WORKFLOW_GATES_SELF_TEST_COMMAND}`,
          ),
        ),
      ),
    },
    {
      name: "deleted gate workflow-policy verdict fails closed",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      files: gateFixture(
        withGatePolicyLines(
          gatePolicyLines.filter(
            (line) => line !== `          ${WORKFLOW_GATES_COMMAND}`,
          ),
        ),
      ),
    },
    {
      name: "reordered gate workflow-policy commands fail closed",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      files: gateFixture(
        withGatePolicyLines([
          ...gatePolicyLines.slice(0, 5),
          gatePolicyLines[6],
          gatePolicyLines[5],
        ]),
      ),
    },
    {
      name: "extra decorative gate policy command fails closed",
      needle:
        "gate policy recheck must be exact, unconditional, and non-soft-failing",
      files: gateFixture(
        withGatePolicyLines([...gatePolicyLines, "          echo checked"]),
      ),
    },
    {
      name: "tag",
      needle: "owner/action@v1",
      files: {
        ".github/workflows/gate.yml": "steps:\n  - uses: owner/action@v1\n",
      },
    },
    {
      name: "branch",
      needle: "owner/action@main",
      files: {
        ".github/workflows/gate.yml": "steps:\n  - uses: owner/action@main\n",
      },
    },
    {
      name: "short SHA",
      needle: "owner/action@0123456",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - uses: owner/action@0123456\n",
      },
    },
    {
      name: "commit pin without readable provenance",
      needle: "version/provenance comment",
      files: {
        ".github/workflows/gate.yml": `steps:\n  - uses: owner/action@${fullSha}\n`,
      },
    },
    {
      name: "mutable reusable workflow",
      needle: "owner/repo/.github/workflows/reuse.yml@release",
      files: {
        ".github/workflows/gate.yml":
          "jobs:\n  call:\n    uses: owner/repo/.github/workflows/reuse.yml@release\n",
      },
    },
    {
      name: "quoted mutable reference",
      needle: "owner/action@v2",
      files: {
        ".github/workflows/gate.yml":
          'steps:\n  - uses: "owner/action@v2" # mutable\n',
      },
    },
    {
      name: "quoted uses key cannot hide a mutable reference",
      needle: "owner/action@v4",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - \"uses\": owner/action@v4\n  - 'uses': owner/other@main\n",
      },
    },
    {
      name: "escaped quoted uses key cannot hide a mutable reference",
      needle: "owner/action@main",
      files: {
        ".github/workflows/gate.yml":
          'steps:\n  - "\\u0075ses": owner/action@main\n',
      },
    },
    {
      name: "nested local action is scanned",
      needle: "owner/nested@nightly",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - uses: ./.github/actions/nested\n",
        ".github/actions/nested/action.yml":
          "runs:\n  using: composite\n  steps:\n    - uses: owner/nested@nightly\n",
      },
    },
    {
      name: "missing local action fails closed",
      needle: "does not exist",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - uses: ./.github/actions/missing\n",
      },
    },
    {
      name: "expression reference fails closed",
      needle: "invalid external",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - uses: owner/action@${{ inputs.ref }}\n",
      },
    },
    {
      name: "flow-style step reference fails closed",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml": `steps:\n  - { uses: owner/action@${fullSha}, name: hidden }\n`,
      },
    },
    {
      name: "inline steps sequence cannot hide a mutable reference",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml": "steps: [{ uses: owner/action@v1 }]\n",
      },
    },
    {
      name: "nested inline jobs cannot hide a mutable reusable workflow",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml":
          "jobs: { call: { uses: owner/repo/.github/workflows/reuse.yml@main } }\n",
      },
    },
    {
      name: "quoted inline key cannot hide a mutable reference",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml":
          'steps: [{ "\\u0075ses": owner/action@v2 }]\n',
      },
    },
    {
      name: "explicit mapping key cannot hide a mutable reference",
      needle: "explicit YAML mapping keys",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - ? uses\n    : owner/action@v3\n",
      },
    },
    {
      name: "anchored step cannot hide a mutable reference",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - &shared uses: owner/action@main\n",
      },
    },
    {
      name: "tagged step cannot hide a mutable reference",
      needle: "decorated, inline, or explicit",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - !!str uses: owner/action@main\n",
      },
    },
    {
      name: "explicit anchored key cannot hide a mutable reference",
      needle: "explicit YAML mapping keys",
      files: {
        ".github/workflows/gate.yml":
          "steps:\n  - ? &action-key uses\n    : owner/action@v3\n",
      },
    },
    {
      name: "alias-resolved key cannot hide a mutable reference",
      needle: "aliases are unsupported as mapping keys",
      files: {
        ".github/workflows/gate.yml":
          "env:\n  ACTION_KEY: &action-key uses\nsteps:\n  - *action-key: owner/action@main\n",
      },
    },
    {
      name: "explicit alias key cannot hide a mutable reference",
      needle: "explicit YAML mapping keys",
      files: {
        ".github/workflows/gate.yml":
          "env:\n  ACTION_KEY: &action-key uses\nsteps:\n  - ? *action-key\n    : owner/action@v1\n",
      },
    },
    {
      name: "continued quoted key cannot hide a mutable reference",
      needle: "continued quoted YAML scalars",
      files: {
        ".github/workflows/gate.yml":
          'steps:\n  - "us\\\n      es": owner/action@main\n',
      },
    },
    {
      name: "explicit continued key cannot hide a mutable reference",
      needle: "explicit YAML mapping keys",
      files: {
        ".github/workflows/gate.yml":
          'steps:\n  - ? "us\\\n        es"\n    : owner/action@main\n',
      },
    },
    {
      name: "YAML-only escape in quoted flow key cannot hide a mutable reference",
      needle: "quoted keys in inline YAML mappings",
      files: {
        ".github/workflows/gate.yml":
          'steps: [{ "u\\x73es": owner/action@main }]\n',
      },
    },
    {
      name: "comments and quoted documentation are not workflow keys",
      valid: true,
      files: {
        ".github/workflows/gate.yml":
          'name: "documentation uses: examples"\n# uses: owner/action@main\nenv:\n  NOTE: "uses: is documentation" # uses: owner/action@v1\n',
      },
    },
  ];

  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "zuu-action-pins-"),
  );
  try {
    for (const testCase of cases) {
      const fixture = path.join(
        temporaryRoot,
        testCase.name.replaceAll(/[^a-z0-9]+/gi, "-"),
      );
      for (const [relative, contents] of Object.entries(testCase.files)) {
        writeFixture(fixture, relative, contents);
      }
      const result = scanRepository(fixture, {
        enforceRustRootOwners: false,
        enforceFrontendBuildContracts: false,
      });
      if (testCase.valid) {
        if (result.failures.length) {
          throw new Error(
            `${testCase.name}: expected success, got ${result.failures.join("; ")}`,
          );
        }
      } else if (
        result.failures.length === 0 ||
        !result.failures.some((failure) => failure.includes(testCase.needle))
      ) {
        throw new Error(
          `${testCase.name}: expected failure containing ${JSON.stringify(testCase.needle)}, got ${result.failures.join("; ")}`,
        );
      }
      console.log(`self-test: ${testCase.name}: passed`);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const gateResultCases = [
    {
      name: "all changed jobs including future Android 32-bit succeed",
      policyOutcome: "success",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "true", zuuallet_schema: "false" },
        },
        build: { result: "success", outputs: {} },
        rust_android_32: { result: "success", outputs: {} },
        zuuallet_schema: { result: "skipped", outputs: {} },
      },
    },
    {
      name: "independent schema selector is enforced",
      policyOutcome: "success",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "false", zuuallet_schema: "true" },
        },
        build: { result: "skipped", outputs: {} },
        rust_native_clippy: { result: "success", outputs: {} },
        zuuallet_schema: { result: "success", outputs: {} },
      },
    },
    {
      name: "native clippy cannot skip a Zuuallet-only Rust change",
      policyOutcome: "success",
      needle: "required job rust_native_clippy must be success, got skipped",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "false", zuuallet_schema: "true" },
        },
        rust_native_clippy: { result: "skipped", outputs: {} },
        zuuallet_schema: { result: "success", outputs: {} },
      },
    },
    {
      name: "native tests cannot skip a Zuuallet-only Rust change",
      policyOutcome: "success",
      needle: "required job rust_native_tests must be success, got skipped",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "false", zuuallet_schema: "true" },
        },
        rust_native_tests: { result: "skipped", outputs: {} },
        zuuallet_schema: { result: "success", outputs: {} },
      },
    },
    {
      name: "native tests follow the shared native selector when neither is set",
      policyOutcome: "success",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "false", zuuallet_schema: "false" },
        },
        rust_native_clippy: { result: "skipped", outputs: {} },
        rust_native_tests: { result: "skipped", outputs: {} },
        zuuallet_schema: { result: "skipped", outputs: {} },
      },
    },
    {
      name: "a failed native test run is rejected",
      policyOutcome: "success",
      needle: "required job rust_native_tests must be success, got failure",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "true", zuuallet_schema: "false" },
        },
        rust_native_tests: { result: "failure", outputs: {} },
      },
    },
    {
      name: "soft-failed policy outcome is rejected",
      policyOutcome: "failure",
      needle: "gate-local policy recheck did not pass",
      needs: {},
    },
    {
      name: "failed ordinary dependency is rejected",
      policyOutcome: "success",
      needle: "required job build must be success, got failure",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "true", zuuallet_schema: "false" },
        },
        build: { result: "failure", outputs: {} },
      },
    },
    {
      name: "schema result cannot follow the general selector",
      policyOutcome: "success",
      needle: "required job zuuallet_schema must be skipped, got success",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "true", zuuallet_schema: "false" },
        },
        zuuallet_schema: { result: "success", outputs: {} },
      },
    },
    {
      name: "invalid change selector fails closed",
      policyOutcome: "success",
      needle: "invalid or missing ZUULI change-detector output",
      needs: {
        changes: {
          result: "success",
          outputs: { zuuli: "", zuuallet_schema: "false" },
        },
      },
    },
  ];
  for (const testCase of gateResultCases) {
    let error = null;
    try {
      verifyGateResults(testCase.policyOutcome, JSON.stringify(testCase.needs));
    } catch (caught) {
      error = caught;
    }
    if (testCase.needle) {
      if (!error?.message.includes(testCase.needle)) {
        throw new Error(
          `${testCase.name}: expected failure containing ${JSON.stringify(testCase.needle)}, got ${error?.message ?? "success"}`,
        );
      }
    } else if (error) {
      throw new Error(
        `${testCase.name}: expected success, got ${error.message}`,
      );
    }
    console.log(`self-test: gate verdict: ${testCase.name}: passed`);
  }
  const currentWorkflowMutations = runCurrentWorkflowMutationTests(repoRoot);
  const frontendBuildMutations =
    runFrontendBuildContractMutationTests(repoRoot);
  const rustRootWorkflowMutations = runRustRootWorkflowMutationTests(repoRoot);
  console.log(
    `self-test: ${cases.length} source-policy, ${gateResultCases.length} gate-verdict, ` +
      `${currentWorkflowMutations} current-workflow, ${frontendBuildMutations} frontend-build, ` +
      `and ${rustRootWorkflowMutations} Rust-root ownership mutation case(s) passed.`,
  );
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const args = process.argv.slice(2);
const mode = args[0];
if (
  args.length > 1 ||
  (args.length === 1 &&
    !["--self-test", "--verify-gate-results"].includes(mode))
) {
  console.error(
    "usage: scripts/check-github-actions-pins.mjs [--self-test|--verify-gate-results]",
  );
  process.exit(2);
}

if (mode === "--self-test") {
  runSelfTest(repoRoot);
} else if (mode === "--verify-gate-results") {
  try {
    const verdicts = verifyGateResults(
      process.env.POLICY_OUTCOME,
      process.env.REQUIRED_JOBS_JSON,
    );
    console.log(`The full-stack gate passed: ${verdicts.join(", ")}`);
  } catch (error) {
    console.error(`Required-gate verdict failed: ${error.message}`);
    process.exit(1);
  }
} else {
  const result = scanRepository(repoRoot);
  if (result.failures.length) {
    console.error("GitHub Actions fail-closed policy failed:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    console.error(
      `${result.failures.length} failure(s); scanned ${result.scannedFiles} workflow/action file(s) and ${result.externalReferences} external reference(s).`,
    );
    process.exit(1);
  }
  console.log(
    "GitHub Actions policy passed: every external action/reusable workflow is immutably pinned, " +
      `and every required-gate dependency is bound to the enforcing verdict (${result.externalReferences} ` +
      `external reference(s), ${result.scannedFiles} file(s)).`,
  );
}
