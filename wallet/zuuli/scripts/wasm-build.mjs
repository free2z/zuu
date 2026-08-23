#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const zuuliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const walletRoot = path.resolve(zuuliRoot, "..");
const crateRoot = path.join(zuuliRoot, "wasm-spike");
const generatedRoot = path.join(crateRoot, "generated");
const generatedWasm = path.join(generatedRoot, "zuu_wasm_spike.wasm");
const generatedMetadata = path.join(generatedRoot, "artifact.json");
const target = "wasm32-unknown-unknown";
const builtWasm = path.join(
  crateRoot,
  "target",
  target,
  "release",
  "zuu_wasm_spike.wasm",
);
const sourceFiles = ["Cargo.toml", "Cargo.lock", "src/lib.rs"];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sourceDigest() {
  const hash = createHash("sha256");
  for (const relative of sourceFiles) {
    const bytes = fs.readFileSync(path.join(crateRoot, relative));
    hash.update(`${relative}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function rustChannel() {
  const toolchain = fs.readFileSync(
    path.join(walletRoot, "rust-toolchain.toml"),
    "utf8",
  );
  const match = toolchain.match(
    /^channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/m,
  );
  if (!match)
    throw new Error("wallet/rust-toolchain.toml has no exact Rust channel");
  return match[1];
}

function validateWasm(bytes) {
  if (
    bytes.length < 8 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))
  ) {
    throw new Error("generated artifact is not a WebAssembly module");
  }
  const module = new WebAssembly.Module(bytes);
  const exports = WebAssembly.Module.exports(module);
  if (
    exports.length !== 2 ||
    exports[0]?.name !== "memory" ||
    exports[0]?.kind !== "memory" ||
    exports[1]?.name !== "zuu_wasm_spike_add" ||
    exports[1]?.kind !== "function"
  ) {
    throw new Error(`unexpected WASM exports: ${JSON.stringify(exports)}`);
  }
  const instance = new WebAssembly.Instance(module);
  const add = instance.exports.zuu_wasm_spike_add;
  if (typeof add !== "function" || add(19, 23) !== 42) {
    throw new Error("generated WASM did not return the expected result");
  }
}

function metadataFor(bytes, elapsedMilliseconds) {
  return {
    schema: 1,
    target,
    rustChannel: rustChannel(),
    sourceSha256: sourceDigest(),
    wasmSha256: sha256(bytes),
    byteLength: bytes.length,
    elapsedMilliseconds,
  };
}

function writeAtomic(destination, bytes) {
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, destination);
}

function build() {
  fs.rmSync(generatedRoot, { recursive: true, force: true });
  fs.mkdirSync(generatedRoot, { recursive: true });

  const channel = rustChannel();
  const start = process.hrtime.bigint();
  const result = spawnSync(
    "cargo",
    [
      `+${channel}`,
      "build",
      "--locked",
      "--release",
      "--target",
      target,
      "--manifest-path",
      path.join(crateRoot, "Cargo.toml"),
    ],
    {
      cwd: walletRoot,
      env: { ...process.env, CARGO_INCREMENTAL: "0" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const elapsedMilliseconds =
    Number(process.hrtime.bigint() - start) / 1_000_000;

  const bytes = fs.readFileSync(builtWasm);
  validateWasm(bytes);
  writeAtomic(generatedWasm, bytes);
  writeAtomic(
    generatedMetadata,
    `${JSON.stringify(metadataFor(bytes, Math.round(elapsedMilliseconds)), null, 2)}\n`,
  );
  console.log(
    `WASM build: ${bytes.length} bytes, ${elapsedMilliseconds.toFixed(0)} ms, sha256 ${sha256(bytes)}`,
  );
}

function verifyGenerated() {
  const bytes = fs.readFileSync(generatedWasm);
  validateWasm(bytes);
  const metadata = JSON.parse(fs.readFileSync(generatedMetadata, "utf8"));
  if (
    !Number.isInteger(metadata.elapsedMilliseconds) ||
    metadata.elapsedMilliseconds < 0
  ) {
    throw new Error(
      "generated WASM metadata has an invalid build-time measurement",
    );
  }
  const expected = metadataFor(bytes, metadata.elapsedMilliseconds);
  if (JSON.stringify(metadata) !== JSON.stringify(expected)) {
    throw new Error(
      "generated WASM metadata is stale or does not match the source, toolchain, target, and bytes",
    );
  }
  console.log(
    `Fresh WASM artifact verified: ${bytes.length} bytes, sha256 ${expected.wasmSha256}`,
  );
  return { bytes, metadata };
}

function filesBelow(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(candidate));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}

function verifyDist() {
  const { bytes } = verifyGenerated();
  const distRoot = path.join(zuuliRoot, "dist");
  const distFiles = filesBelow(distRoot);
  const matchingArtifacts = distFiles.filter((file) => {
    if (path.extname(file) !== ".wasm") return false;
    return fs.readFileSync(file).equals(bytes);
  });
  if (matchingArtifacts.length !== 1) {
    throw new Error(
      `production bundle must contain exactly one byte-identical fresh WASM artifact; found ${matchingArtifacts.length}`,
    );
  }
  const emittedName = path.basename(matchingArtifacts[0]);
  const referenced = distFiles
    .filter((file) => /\.m?js$/.test(file))
    .some((file) => fs.readFileSync(file, "utf8").includes(emittedName));
  if (!referenced) {
    throw new Error(
      `production JavaScript does not reference emitted WASM ${emittedName}`,
    );
  }
  console.log(
    `Production bundle contains and references fresh WASM: ${emittedName}`,
  );
}

const [mode = "--build", ...extra] = process.argv.slice(2);
if (
  extra.length ||
  !["--build", "--verify-generated", "--verify-dist"].includes(mode)
) {
  console.error(
    "usage: node scripts/wasm-build.mjs [--build|--verify-generated|--verify-dist]",
  );
  process.exit(2);
}

try {
  if (mode === "--build") build();
  else if (mode === "--verify-generated") verifyGenerated();
  else verifyDist();
} catch (error) {
  console.error(
    `WASM build contract failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
