import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const zuuliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function copy(relative, destinationRoot) {
  const destination = path.join(destinationRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(zuuliRoot, relative), destination);
}

function verificationFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zuu-wasm-artifact-"));
  for (const relative of [
    "scripts/wasm-build.mjs",
    "wasm-spike/Cargo.toml",
    "wasm-spike/Cargo.lock",
    "wasm-spike/src/lib.rs",
    "wasm-spike/generated/zuu_wasm_spike.wasm",
    "wasm-spike/generated/artifact.json",
  ])
    copy(relative, path.join(root, "zuuli"));
  fs.copyFileSync(
    path.join(zuuliRoot, "../rust-toolchain.toml"),
    path.join(root, "rust-toolchain.toml"),
  );
  return root;
}

function verify(root, mode = "--verify-generated") {
  return spawnSync(
    "node",
    [path.join(root, "zuuli/scripts/wasm-build.mjs"), mode],
    {
      cwd: path.join(root, "zuuli"),
      encoding: "utf8",
    },
  );
}

test("fresh generated WASM is bound to its exact Rust source", () => {
  const root = verificationFixture();
  try {
    assert.equal(verify(root).status, 0);
    fs.appendFileSync(
      path.join(root, "zuuli/wasm-spike/src/lib.rs"),
      "\n// stale mutation\n",
    );
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /metadata is stale/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tampered generated WASM is rejected", () => {
  const root = verificationFixture();
  try {
    const artifact = path.join(
      root,
      "zuuli/wasm-spike/generated/zuu_wasm_spike.wasm",
    );
    const bytes = fs.readFileSync(artifact);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(artifact, bytes);
    assert.notEqual(verify(root).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production verification requires byte identity and a JavaScript reference", () => {
  const root = verificationFixture();
  try {
    const dist = path.join(root, "zuuli/dist/assets");
    fs.mkdirSync(dist, { recursive: true });
    const emitted = "zuu_wasm_spike-proof.wasm";
    fs.copyFileSync(
      path.join(root, "zuuli/wasm-spike/generated/zuu_wasm_spike.wasm"),
      path.join(dist, emitted),
    );
    fs.writeFileSync(
      path.join(dist, "index.js"),
      `const wasm = ${JSON.stringify(emitted)};\n`,
    );
    assert.equal(verify(root, "--verify-dist").status, 0);
    fs.writeFileSync(
      path.join(dist, "index.js"),
      "const wasm = 'stale.wasm';\n",
    );
    const result = verify(root, "--verify-dist");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not reference emitted WASM/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
