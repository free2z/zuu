#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const currentRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const requiredFiles = [
  ".github/workflows/zuuli.yml",
  "wallet/rust-toolchain.toml",
  "wallet/zuuli/.gitignore",
  "wallet/zuuli/docs/wasm-spike.md",
  "wallet/zuuli/package.json",
  "wallet/zuuli/scripts/wasm-build.mjs",
  "wallet/zuuli/src-tauri/tauri.conf.json",
  "wallet/zuuli/src/lib/wasm-spike.ts",
  "wallet/zuuli/src/main.tsx",
  "wallet/zuuli/tests/wasm-spike.pw.ts",
  "wallet/zuuli/wasm-spike/Cargo.toml",
  "wallet/zuuli/wasm-spike/Cargo.lock",
  "wallet/zuuli/wasm-spike/src/lib.rs",
];

const exactNeedles = new Map([
  [
    "wallet/zuuli/docs/wasm-spike.md",
    [
      "Use this path for future shared Rust logic in `wallet/zuuli`.",
      "Do not add a parallel integration to `ts/react/free2z`",
      "The release module is **116 bytes** before transport compression.",
    ],
  ],
  [
    "wallet/zuuli/src-tauri/tauri.conf.json",
    ["script-src 'self' 'wasm-unsafe-eval'"],
  ],
  ["wallet/rust-toolchain.toml", ['targets = ["wasm32-unknown-unknown"]']],
  ["wallet/zuuli/.gitignore", ["wasm-spike/generated/", "wasm-spike/target/"]],
  [
    "wallet/zuuli/scripts/wasm-build.mjs",
    [
      'const sourceFiles = ["Cargo.toml", "Cargo.lock", "src/lib.rs"];',
      "fs.rmSync(generatedRoot, { recursive: true, force: true });",
      '"--locked",',
      '"--release",',
      '"--target",',
      "sourceSha256: sourceDigest(),",
      "wasmSha256: sha256(bytes),",
      "production bundle must contain exactly one byte-identical fresh WASM artifact",
      "production JavaScript does not reference emitted WASM",
    ],
  ],
  [
    "wallet/zuuli/src/lib/wasm-spike.ts",
    [
      'zuu_wasm_spike.wasm?init&no-inline";',
      "return exports.zuu_wasm_spike_add(19, 23);",
    ],
  ],
  [
    "wallet/zuuli/src/main.tsx",
    [
      "void runWasmSpike()",
      "document.documentElement.dataset.wasmSpike = String(value);",
    ],
  ],
  [
    "wallet/zuuli/tests/wasm-spike.pw.ts",
    ['toHaveAttribute("data-wasm-spike", "42")'],
  ],
  [
    "wallet/zuuli/wasm-spike/Cargo.toml",
    [
      'name = "zuu-wasm-spike"',
      'rust-version = "1.97"',
      'crate-type = ["cdylib", "rlib"]',
      'panic = "abort"',
    ],
  ],
  [
    "wallet/zuuli/wasm-spike/src/lib.rs",
    [
      "#[unsafe(no_mangle)]",
      'pub extern "C" fn zuu_wasm_spike_add(left: i32, right: i32) -> i32',
    ],
  ],
  [
    ".github/workflows/zuuli.yml",
    [
      "node wallet/zuuli/scripts/wasm-boundary.mjs --self-test",
      "version=$(../../scripts/check-rust-toolchain.sh --print-channel)",
      "toolchain: ${{ steps.frontend_rust_toolchain.outputs.version }}",
      "targets: wasm32-unknown-unknown",
    ],
  ],
]);

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function occurrenceCount(contents, needle) {
  return contents.split(needle).length - 1;
}

export function inspectWasmBoundary(
  root = currentRepoRoot,
  { checkGit = true } = {},
) {
  const failures = [];
  for (const relative of requiredFiles) {
    if (!fs.existsSync(path.join(root, relative)))
      failures.push(`${relative} is missing`);
  }
  if (failures.length) return failures;

  for (const [relative, needles] of exactNeedles) {
    const contents = read(root, relative);
    for (const needle of needles) {
      const count = occurrenceCount(contents, needle);
      if (count !== 1) {
        failures.push(
          `${relative} must contain exactly one ${JSON.stringify(needle)}; found ${count}`,
        );
      }
    }
  }

  const packageJson = JSON.parse(read(root, "wallet/zuuli/package.json"));
  const expectedScripts = new Map([
    ["pretest", "npm run wasm:build"],
    ["dev", "npm run wasm:build && vite"],
    [
      "build",
      "npm run wasm:build && tsc -p tsconfig.build.json && vite build && npm run wasm:verify-dist && npm run runtime-target:verify",
    ],
    ["wasm:build", "node scripts/wasm-build.mjs --build"],
    ["wasm:verify", "node scripts/wasm-build.mjs --verify-generated"],
    ["wasm:verify-dist", "node scripts/wasm-build.mjs --verify-dist"],
    ["test:wasm-boundary", "node --test scripts/wasm-boundary.node-test.mjs"],
  ]);
  for (const [name, expected] of expectedScripts) {
    if (packageJson.scripts?.[name] !== expected) {
      failures.push(
        `wallet/zuuli/package.json script ${name} must be exactly ${JSON.stringify(expected)}`,
      );
    }
  }
  if (
    !packageJson.scripts?.test?.includes("scripts/wasm-boundary.node-test.mjs")
  ) {
    failures.push(
      "the main frontend test command must run the WASM boundary mutation tests",
    );
  }

  const workflow = read(root, ".github/workflows/zuuli.yml");
  const policyBlock = [
    "      - name: Verify the required Rust/WASM build boundary",
    "        run: |",
    "          node wallet/zuuli/scripts/wasm-boundary.mjs --self-test",
    "          node wallet/zuuli/scripts/wasm-boundary.mjs",
  ].join("\n");
  if (occurrenceCount(workflow, policyBlock) !== 1) {
    failures.push(
      "the always-required changes job must exactly self-test and enforce the WASM boundary",
    );
  }
  const toolchainBlock = [
    "      - name: Resolve the pinned frontend Rust toolchain",
    "        id: frontend_rust_toolchain",
    "        run: |",
    "          set -euo pipefail",
    "          version=$(../../scripts/check-rust-toolchain.sh --print-channel)",
    '          echo "version=$version" >> "$GITHUB_OUTPUT"',
    "",
    "      - name: Install the pinned Rust/WASM compiler",
    "        uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable",
    "        with:",
    "          toolchain: ${{ steps.frontend_rust_toolchain.outputs.version }}",
    "          targets: wasm32-unknown-unknown",
  ].join("\n");
  if (occurrenceCount(workflow, toolchainBlock) !== 1) {
    failures.push(
      "the required frontend job must install the source-derived Rust/WASM toolchain exactly",
    );
  }

  if (checkGit) {
    const tracked = spawnSync(
      "git",
      ["ls-files", "--", "wallet/zuuli/wasm-spike/generated"],
      { cwd: root, encoding: "utf8" },
    );
    if (tracked.status !== 0)
      failures.push("git could not inspect generated WASM tracking state");
    else if (tracked.stdout.trim()) {
      failures.push(
        `generated WASM must not be committed: ${tracked.stdout.trim()}`,
      );
    }
    const ignored = spawnSync(
      "git",
      ["check-ignore", "-q", "wallet/zuuli/wasm-spike/generated/probe.wasm"],
      { cwd: root },
    );
    if (ignored.status !== 0)
      failures.push("generated WASM directory is not ignored by Git");
  }
  return failures;
}

function copyPolicyTree(destination) {
  for (const relative of requiredFiles) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(currentRepoRoot, relative), target);
  }
}

function selfTest() {
  const baseline = inspectWasmBoundary(currentRepoRoot);
  if (baseline.length)
    throw new Error(
      `current tree is not a valid policy base: ${baseline.join("; ")}`,
    );
  const cases = [
    {
      name: "the packaged WebView cannot lose WASM compilation authority",
      file: "wallet/zuuli/src-tauri/tauri.conf.json",
      from: "script-src 'self' 'wasm-unsafe-eval'",
      to: "script-src 'self'",
    },
    {
      name: "the production build cannot fall back to the unscoped TypeScript config",
      file: "wallet/zuuli/package.json",
      from: "npm run wasm:build && tsc -p tsconfig.build.json && vite build && npm run wasm:verify-dist && npm run runtime-target:verify",
      to: "npm run wasm:build && tsc && vite build && npm run wasm:verify-dist && npm run runtime-target:verify",
      expectedFailure:
        "wallet/zuuli/package.json script build must be exactly",
    },
    {
      name: "a decorative production build cannot excuse the old unscoped command",
      file: "wallet/zuuli/package.json",
      from: '    "build": "npm run wasm:build && tsc -p tsconfig.build.json && vite build && npm run wasm:verify-dist && npm run runtime-target:verify",',
      to: '    "wasmBuildContract": "npm run wasm:build && tsc -p tsconfig.build.json && vite build && npm run wasm:verify-dist && npm run runtime-target:verify",\n    "build": "npm run wasm:build && tsc && vite build && npm run wasm:verify-dist && npm run runtime-target:verify",',
      expectedFailure:
        "wallet/zuuli/package.json script build must be exactly",
    },
    {
      name: "stale generated output cannot replace a fresh build",
      file: "wallet/zuuli/package.json",
      from: "npm run wasm:build && tsc -p tsconfig.build.json && vite build && npm run wasm:verify-dist && npm run runtime-target:verify",
      to: "tsc -p tsconfig.build.json && vite build",
      expectedFailure:
        "wallet/zuuli/package.json script build must be exactly",
    },
    {
      name: "generated output cannot become committed source",
      file: "wallet/zuuli/.gitignore",
      from: "wasm-spike/generated/",
      to: "wasm-spike/not-generated/",
    },
    {
      name: "the source-to-artifact binding cannot be deleted",
      file: "wallet/zuuli/scripts/wasm-build.mjs",
      from: "sourceSha256: sourceDigest(),",
      to: 'sourceSha256: "decorative",',
    },
    {
      name: "the dist byte-identity verdict cannot be deleted",
      file: "wallet/zuuli/scripts/wasm-build.mjs",
      from: "production bundle must contain exactly one byte-identical fresh WASM artifact",
      to: "production bundle looks fine",
    },
    {
      name: "the browser call cannot become a decorative asset import",
      file: "wallet/zuuli/src/main.tsx",
      from: "void runWasmSpike()",
      to: "void Promise.resolve(42)",
    },
    {
      name: "the real-browser assertion cannot be removed",
      file: "wallet/zuuli/tests/wasm-spike.pw.ts",
      from: 'toHaveAttribute("data-wasm-spike", "42")',
      to: "toBeTruthy()",
    },
    {
      name: "the CI WASM target cannot drift",
      file: ".github/workflows/zuuli.yml",
      from: "          targets: wasm32-unknown-unknown",
      to: "          targets: x86_64-unknown-linux-gnu",
    },
    {
      name: "the always-required policy invocation cannot disappear",
      file: ".github/workflows/zuuli.yml",
      from: "          node wallet/zuuli/scripts/wasm-boundary.mjs --self-test",
      to: "          true",
    },
  ];

  for (const testCase of cases) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zuu-wasm-policy-"));
    try {
      copyPolicyTree(scratch);
      const target = path.join(scratch, testCase.file);
      const before = fs.readFileSync(target, "utf8");
      if (!before.includes(testCase.from))
        throw new Error(`${testCase.name}: mutation target missing`);
      fs.writeFileSync(target, before.replace(testCase.from, testCase.to));
      const failures = inspectWasmBoundary(scratch, { checkGit: false });
      if (!failures.length)
        throw new Error(`${testCase.name}: mutation was accepted`);
      if (
        testCase.expectedFailure &&
        !failures.some((failure) =>
          failure.includes(testCase.expectedFailure),
        )
      ) {
        throw new Error(
          `${testCase.name}: failed for the wrong reason: ${failures.join("; ")}`,
        );
      }
      console.log(`self-test: ${testCase.name}: passed`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  console.log(`self-test: ${cases.length} WASM boundary mutations rejected`);
}

const [mode, ...extra] = process.argv.slice(2);
if (extra.length || ![undefined, "--self-test"].includes(mode)) {
  console.error(
    "usage: node wallet/zuuli/scripts/wasm-boundary.mjs [--self-test]",
  );
  process.exit(2);
}

try {
  if (mode === "--self-test") selfTest();
  else {
    const failures = inspectWasmBoundary();
    if (failures.length) throw new Error(failures.join("\n"));
    console.log(
      "Rust/WASM source, build, Vite, browser, generated-output, and CI boundaries agree.",
    );
  }
} catch (error) {
  console.error(
    `WASM boundary failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
