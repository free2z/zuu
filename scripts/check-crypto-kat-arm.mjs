#!/usr/bin/env node

// Runtime and Cargo-artifact evidence for the aarch64 libcrux KAT lane.
// --self-test uses in-memory fixtures only; production evidence is always
// collected by check-crypto-kats.sh from the immediately preceding Cargo run.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rsRoot = resolve(scriptDir, "../rs");
const args = process.argv.slice(2);

function fail(message) {
  throw new Error(message);
}

function requireHostEvidence(evidence) {
  if (evidence.os !== "Linux") fail("ARM KAT lane requires a Linux host");
  if (evidence.uname !== "aarch64") {
    fail(`ARM KAT lane requires a native aarch64 host, got ${evidence.uname || "missing"}`);
  }
  if (evidence.rustcHost !== "aarch64-unknown-linux-gnu") {
    fail(`ARM KAT lane requires the aarch64-unknown-linux-gnu Rust host, got ${evidence.rustcHost || "missing"}`);
  }
  for (const variable of [
    "CARGO_BUILD_TARGET",
    "RUSTFLAGS",
    "CARGO_ENCODED_RUSTFLAGS",
    "LIBCRUX_DISABLE_SIMD128",
    "RUSTC_BOOTSTRAP",
    "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS",
    "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUNNER",
  ]) {
    if (evidence.overrides?.[variable]) {
      fail(`ARM KAT lane refuses target/feature overrides through ${variable}`);
    }
  }
  if (!evidence.cfg?.includes('target_arch="aarch64"')) {
    fail("rustc host configuration is not aarch64");
  }
  if (!evidence.cfg?.includes('target_feature="neon"')) {
    fail("rustc host configuration does not select the NEON target feature");
  }
  const featureRows = evidence.cpuFeatures ?? [];
  if (featureRows.length === 0 || featureRows.some((row) => !row.some((feature) => feature === "asimd" || feature === "neon"))) {
    fail("Linux CPU feature report does not expose ASIMD/NEON on every CPU");
  }
}

function requireEmulatedTargetEvidence(evidence) {
  if (evidence.cargoBuildTarget !== "aarch64-unknown-linux-gnu") {
    fail("emulated ARM KAT mode requires CARGO_BUILD_TARGET=aarch64-unknown-linux-gnu");
  }
  if (evidence.rustcHost === "aarch64-unknown-linux-gnu") {
    fail("emulated ARM KAT mode is only for a non-aarch64 Rust host");
  }
  if (!evidence.targetCfg?.includes('target_arch="aarch64"') || !evidence.targetCfg?.includes('target_feature="neon"')) {
    fail("Rust target configuration does not select aarch64 NEON");
  }
  if (!evidence.runner || !evidence.runnerExecutable) {
    fail("emulated ARM KAT mode requires an executable aarch64 Cargo runner");
  }
}

const REQUIRED_KAT_TESTS = [
  "nist_acvp_ml_kem_768_key_generation",
  "nist_acvp_ml_kem_768_encapsulation",
  "nist_acvp_ml_kem_768_decapsulation",
  "rfc_7748_x25519_agreement_and_all_zero_refusal",
  "rfc_8032_ed25519_signatures_and_tamper_refusal",
  "shipping_device_signer_refuses_an_all_zero_seed",
  "x_wing_draft_06_appendix_c_all_vectors",
];

function verifyKatOutput(output) {
  const passed = new Set([...output.matchAll(/^test tests::([a-z0-9_]+) \.\.\. ok$/gm)].map((match) => match[1]));
  const summary = /^test result: ok\. 7 passed; 0 failed; 0 ignored; 0 measured;/m.test(output);
  const missing = REQUIRED_KAT_TESTS.filter((name) => !passed.has(name));
  if (!summary || missing.length > 0 || passed.size !== REQUIRED_KAT_TESTS.length) {
    fail(`live KAT run did not pass exactly the seven authoritative tests${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
  }
}

function verifyCargoEvidence({ messages, metadata, targetTriple, executionMode, elf }) {
  if (!Array.isArray(messages) || !metadata?.packages || !metadata?.resolve?.nodes) {
    fail("current Cargo metadata or message stream is missing/malformed");
  }
  if (targetTriple !== "aarch64-unknown-linux-gnu") {
    fail(`Cargo KAT artifact target must be aarch64-unknown-linux-gnu, got ${targetTriple || "missing"}`);
  }

  const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const katPackages = metadata.packages.filter((pkg) => pkg.name === "f2z-crypto-kat");
  if (katPackages.length !== 1) fail("Cargo metadata must resolve exactly one f2z-crypto-kat package");
  const katPackage = katPackages[0];
  const graph = new Map(metadata.resolve.nodes.map((node) => [node.id, node.deps.map((dep) => dep.pkg)]));
  const reachable = new Set();
  const visit = (id) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
  };
  visit(katPackage.id);

  const mlkemPackages = [...packageById.values()].filter((pkg) =>
    pkg.name === "libcrux-ml-kem" && reachable.has(pkg.id) && pkg.source?.startsWith("registry+")
  );
  if (mlkemPackages.length !== 1) fail("the KAT dependency graph must select exactly one registry libcrux-ml-kem package");
  const mlkemPackage = mlkemPackages[0];
  const buildEvents = messages.filter((message) =>
    message.reason === "build-script-executed" && message.package_id === mlkemPackage.id
  );
  if (buildEvents.length === 0) fail("current Cargo invocation has no selected libcrux-ml-kem build-script evidence");
  if (buildEvents.some((event) => !Array.isArray(event.cfgs) || !event.cfgs.includes('feature="simd128"'))) {
    fail("current selected libcrux-ml-kem build does not enable simd128 for aarch64");
  }

  const artifacts = messages.filter((message) =>
    message.reason === "compiler-artifact" &&
    message.package_id === katPackage.id &&
    message.target?.test === true &&
    Array.isArray(message.target?.kind) && message.target.kind.includes("lib") &&
    typeof message.executable === "string"
  );
  if (artifacts.length !== 1) fail("current Cargo invocation must report exactly one f2z-crypto-kat test executable");
  const artifact = artifacts[0];
  if (artifact.fresh !== false) fail("f2z-crypto-kat test executable was not rebuilt in the current Cargo invocation");
  if (!artifact.target?.src_path?.startsWith(`${katPackage.manifest_path.slice(0, -"Cargo.toml".length)}src${sep}`)) {
    fail("Cargo test executable does not belong to the selected f2z-crypto-kat source tree");
  }
  const targetRelativePath = relative(metadata.target_directory, artifact.executable).split(sep).join("/");
  const expectedTargetPath = executionMode === "native"
    ? /^debug\/deps\//
    : /^aarch64-unknown-linux-gnu\/debug\/deps\//;
  if (!expectedTargetPath.test(targetRelativePath)) {
    fail(`Cargo KAT executable path does not match the ${executionMode} host/target selection`);
  }
  if (elf?.length < 20 || elf.readUInt32LE(0) !== 0x464c457f || elf[4] !== 2 || elf[5] !== 1 || elf.readUInt16LE(18) !== 183) {
    fail("current f2z-crypto-kat test executable is not a little-endian ELF AArch64 binary");
  }
  return { katPackage, mlkemPackage, executable: artifact.executable, buildEvents: buildEvents.length };
}

function selfTest() {
  const baseHost = {
    os: "Linux", uname: "aarch64", rustcHost: "aarch64-unknown-linux-gnu",
    cfg: ['target_arch="aarch64"', 'target_feature="neon"'], overrides: {},
    cpuFeatures: [["fp", "asimd"], ["fp", "neon"]],
  };
  requireHostEvidence(baseHost);
  const rejected = (name, change, expected) => {
    const sample = structuredClone(baseHost);
    change(sample);
    let error;
    try { requireHostEvidence(sample); } catch (caught) { error = caught; }
    if (!error || !String(error.message).includes(expected)) fail(`probe self-test did not reject ${name} as expected`);
  };
  rejected("wrong host architecture", (sample) => { sample.uname = "x86_64"; }, "native aarch64");
  rejected("wrong rustc host", (sample) => { sample.rustcHost = "x86_64-unknown-linux-gnu"; }, "Rust host");
  rejected("missing NEON", (sample) => { sample.cfg = ['target_arch="aarch64"']; }, "does not select the NEON");
  rejected("runtime CPU without NEON", (sample) => { sample.cpuFeatures = [["fp"], ["fp", "asimd"]]; }, "every CPU");
  rejected("target override", (sample) => { sample.overrides.CARGO_BUILD_TARGET = "x86_64-unknown-linux-gnu"; }, "CARGO_BUILD_TARGET");
  rejected("feature override", (sample) => { sample.overrides.RUSTFLAGS = "-C target-feature=-neon"; }, "RUSTFLAGS");

  const baseMetadata = {
    packages: [
      { id: "kat-id", name: "f2z-crypto-kat", manifest_path: "/repo/rs/crates/f2z-crypto-kat/Cargo.toml" },
      { id: "mlkem-id", name: "libcrux-ml-kem", version: "0.0.10", source: "registry+https://example", manifest_path: "/cargo/libcrux-ml-kem/Cargo.toml" },
      { id: "unrelated-id", name: "other", source: "registry+https://example" },
    ],
    resolve: { nodes: [
      { id: "kat-id", deps: [{ pkg: "mlkem-id" }] },
      { id: "mlkem-id", deps: [] }, { id: "unrelated-id", deps: [] },
    ] },
  };
  const elf = Buffer.alloc(20);
  elf.writeUInt32LE(0x464c457f, 0); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(183, 18);
  const validMessages = [
    { reason: "build-script-executed", package_id: "mlkem-id", cfgs: ['feature="simd128"'] },
    { reason: "compiler-artifact", package_id: "kat-id", target: { test: true, kind: ["lib"], src_path: "/repo/rs/crates/f2z-crypto-kat/src/lib.rs" }, executable: "/repo/rs/target/aarch64-unknown-linux-gnu/debug/deps/kat", fresh: false },
    // A stale or unrelated marker is deliberately present and must not affect
    // selection of the current package's build event.
    { reason: "build-script-executed", package_id: "unrelated-id", cfgs: ['feature="simd128"'] },
  ];
  baseMetadata.target_directory = "/repo/rs/target";
  const validOutput = [
    ...REQUIRED_KAT_TESTS.map((name) => `test tests::${name} ... ok`),
    "test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
  ].join("\n");
  verifyKatOutput(validOutput);
  let missingKat;
  try { verifyKatOutput(validOutput.replace("test tests::x_wing_draft_06_appendix_c_all_vectors ... ok\n", "")); } catch (caught) { missingKat = caught; }
  if (!String(missingKat?.message).includes("seven authoritative tests")) fail("artifact self-test did not reject a missing authoritative KAT");
  verifyCargoEvidence({ messages: validMessages, metadata: baseMetadata, targetTriple: "aarch64-unknown-linux-gnu", executionMode: "emulated", elf });
  const rejectsCargo = (name, mutate, expected) => {
    const messages = structuredClone(validMessages);
    const metadata = structuredClone(baseMetadata);
    const sampleElf = Buffer.from(elf);
    mutate({ messages, metadata, sampleElf });
    let error;
    try { verifyCargoEvidence({ messages, metadata, targetTriple: "aarch64-unknown-linux-gnu", executionMode: "emulated", elf: sampleElf }); } catch (caught) { error = caught; }
    if (!error || !String(error.message).includes(expected)) fail(`artifact self-test did not reject ${name} as expected`);
  };
  rejectsCargo("missing current build evidence", ({ messages }) => { messages.shift(); }, "no selected libcrux");
  rejectsCargo("malformed current build evidence", ({ messages }) => { messages[0].cfgs = ["feature=portable"]; }, "does not enable simd128");
  rejectsCargo("portable KAT artifact with stale unrelated simd128 output", ({ messages }) => {
    messages.find((message) => message.package_id === "kat-id").executable = "/repo/rs/target/debug/deps/portable";
    messages.find((message) => message.package_id === "mlkem-id").cfgs = ["feature=portable"];
  }, "does not enable simd128");
  rejectsCargo("wrong-architecture executable", ({ sampleElf }) => { sampleElf.writeUInt16LE(62, 18); }, "not a little-endian ELF AArch64");
  rejectsCargo("stale test executable", ({ messages }) => { messages.find((message) => message.package_id === "kat-id").fresh = true; }, "was not rebuilt");
  let wrongTriple;
  try { verifyCargoEvidence({ messages: validMessages, metadata: baseMetadata, targetTriple: "x86_64-unknown-linux-gnu", executionMode: "emulated", elf }); } catch (caught) { wrongTriple = caught; }
  if (!String(wrongTriple?.message).includes("artifact target")) fail("artifact self-test did not reject the wrong target triple");
  const nativeMessages = structuredClone(validMessages);
  nativeMessages.find((message) => message.package_id === "kat-id").executable = "/repo/rs/target/debug/deps/kat";
  verifyCargoEvidence({ messages: nativeMessages, metadata: baseMetadata, targetTriple: "aarch64-unknown-linux-gnu", executionMode: "native", elf });

  requireEmulatedTargetEvidence({
    cargoBuildTarget: "aarch64-unknown-linux-gnu", rustcHost: "x86_64-unknown-linux-gnu",
    targetCfg: ['target_arch="aarch64"', 'target_feature="neon"'],
    runner: "/usr/bin/qemu-aarch64", runnerExecutable: true,
  });
  for (const [name, evidence, expected] of [
    ["emulated wrong target", { cargoBuildTarget: "x86_64-unknown-linux-gnu" }, "CARGO_BUILD_TARGET"],
    ["emulated missing runner", { cargoBuildTarget: "aarch64-unknown-linux-gnu", rustcHost: "x86_64", targetCfg: ['target_arch="aarch64"', 'target_feature="neon"'] }, "executable aarch64 Cargo runner"],
  ]) {
    let error;
    try { requireEmulatedTargetEvidence(evidence); } catch (caught) { error = caught; }
    if (!String(error?.message).includes(expected)) fail(`probe self-test did not reject ${name}`);
  }
  console.log("ARM crypto KAT probe self-test: native assertions, emulated mode, current Cargo evidence and stale/malformed artifact controls passed");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function realNativeCheck() {
  const cfg = run("rustc", ["--print", "cfg"]).split(/\r?\n/);
  const rustcHost = run("rustc", ["-vV"]).split(/\r?\n/).find((line) => line.startsWith("host: "))?.slice(6);
  const cpuRows = readFileSync("/proc/cpuinfo", "utf8").split(/\r?\n/)
    .filter((line) => /^Features\s*:/i.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1).trim().split(/\s+/));
  const overrides = Object.fromEntries([
    "CARGO_BUILD_TARGET", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "LIBCRUX_DISABLE_SIMD128",
    "RUSTC_BOOTSTRAP", "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS",
    "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUNNER",
  ].map((key) => [key, process.env[key] ?? ""]));
  requireHostEvidence({ os: process.platform === "linux" ? "Linux" : process.platform, uname: run("uname", ["-m"]).trim(), rustcHost, cfg, cpuFeatures: cpuRows, overrides });
  console.log(`ARM backend host evidence: uname=aarch64 rustc-host=${rustcHost} rustc=target_feature(neon) runtime=ASIMD/NEON`);
}

function realEmulatedCheck() {
  const cargoBuildTarget = process.env.CARGO_BUILD_TARGET ?? "";
  const rustcHost = run("rustc", ["-vV"]).split(/\r?\n/).find((line) => line.startsWith("host: "))?.slice(6);
  const targetCfg = run("rustc", ["--print", "cfg", "--target", "aarch64-unknown-linux-gnu"]).split(/\r?\n/);
  const runner = process.env.CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUNNER ?? "";
  const runnerExecutable = runner.startsWith("/") && spawnSync("test", ["-x", runner]).status === 0;
  requireEmulatedTargetEvidence({ cargoBuildTarget, rustcHost, targetCfg, runner, runnerExecutable });
  console.log(`ARM backend emulation evidence: rustc-host=${rustcHost} cargo-target=${cargoBuildTarget} runner=${runner}; this is not native ARM evidence`);
}

function readCargoEvidence(path, mode) {
  let messages;
  let cargoOutput;
  try {
    // libtest writes its human progress lines to stdout alongside Cargo's JSON
    // stream, even with --message-format=json-render-diagnostics. Structured
    // Cargo records begin with `{`; a malformed such record still fails here.
    cargoOutput = readFileSync(path, "utf8");
    messages = cargoOutput.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  } catch (error) {
    fail(`Cargo JSON evidence is missing or malformed: ${error.message}`);
  }
  verifyKatOutput(cargoOutput);
  const metadataText = run("cargo", ["metadata", "--locked", "--format-version", "1"], { cwd: rsRoot });
  const metadata = JSON.parse(metadataText);
  const targetTriple = mode === "native" ? "aarch64-unknown-linux-gnu" : process.env.CARGO_BUILD_TARGET;
  const artifact = messages.find((message) => message.reason === "compiler-artifact" && typeof message.executable === "string" && message.target?.test === true);
  if (!artifact?.executable) fail("current Cargo JSON has no KAT test executable");
  const targetRoot = resolve(metadata.target_directory);
  const executable = resolve(artifact.executable);
  if (executable !== targetRoot && !executable.startsWith(`${targetRoot}${sep}`)) fail("KAT test executable is outside Cargo's active target directory");
  const elf = readFileSync(executable);
  const result = verifyCargoEvidence({ messages, metadata, targetTriple, executionMode: mode, elf });
  console.log("ARM KAT execution evidence: all seven authoritative tests passed (ML-KEM keygen/encap/decap, X25519, Ed25519, DeviceSigner seed refusal, X-Wing vectors)");
  console.log(`ARM backend artifact evidence: ${result.mlkemPackage.name} ${result.mlkemPackage.version} emitted simd128 in this Cargo run; rebuilt ${result.katPackage.name} ELF AArch64 executable is under Cargo target_directory (${targetRoot})`);
}

try {
  if (args.length === 1 && args[0] === "--self-test") selfTest();
  else if (args.length === 1 && args[0] === "--verify-native") realNativeCheck();
  else if (args.length === 1 && args[0] === "--verify-emulated") realEmulatedCheck();
  else if (args.length === 3 && args[0] === "--verify-cargo-messages" && ["native", "emulated"].includes(args[2])) readCargoEvidence(args[1], args[2]);
  else fail("Usage: node scripts/check-crypto-kat-arm.mjs --self-test | --verify-native | --verify-emulated | --verify-cargo-messages <current-cargo-json> <native|emulated>");
} catch (error) {
  console.error(`crypto KAT ARM verification failed: ${error.message}`);
  process.exitCode = 1;
}
