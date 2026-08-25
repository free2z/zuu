import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";

export const CARGO_RUNTIME_SCOPE = "free2z:cargo-runtime:scope";
export const CARGO_RUNTIME_TARGET = "free2z:cargo-runtime:target";
export const CARGO_RUNTIME_FEATURES = "free2z:cargo-runtime:features";
export const CARGO_RUNTIME_LOCK_SHA256 =
  "free2z:cargo-runtime:cargo-lock-sha256";
export const CARGO_RUNTIME_EVIDENCE_SHA256 =
  "free2z:cargo-runtime:evidence-sha256";
export const CARGO_RUNTIME_GRAPH_SHA256 = "free2z:cargo-runtime:graph-sha256";
export const CARGO_RUNTIME_EXECUTABLE = "free2z:cargo-runtime:executable";
export const CARGO_RUNTIME_EXECUTABLE_SHA256 =
  "free2z:cargo-runtime:executable-sha256";
export const CARGO_RUNTIME_PACKAGE = "free2z:cargo-runtime:package";
export const CARGO_RUNTIME_SOURCE = "free2z:cargo-runtime:source";
export const CARGO_RUNTIME_PACKAGE_FEATURES =
  "free2z:cargo-runtime:package-features";

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_EVIDENCE_JSON_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGES = 10_000;
const KNOWN_SOURCES = new Set(["crates.io", "git", "local", "registry"]);

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function requireRegularFile(path, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  return info;
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function parseFeatures(value) {
  const features = value.split(",").filter(Boolean);
  if (
    features.length === 0 ||
    new Set(features).size !== features.length ||
    features.some((feature) => !/^[A-Za-z0-9_+-]+$/.test(feature))
  ) {
    throw new Error(
      "Cargo runtime features must be a unique comma-separated list",
    );
  }
  return [...features].sort();
}

function sourceKind(source) {
  if (source === null) return "local";
  if (source === "registry+https://github.com/rust-lang/crates.io-index") {
    return "crates.io";
  }
  if (source.startsWith("registry+")) return "registry";
  if (source.startsWith("git+")) return "git";
  throw new Error(
    `Cargo metadata contains an unsupported package source: ${source}`,
  );
}

function cargoArguments(manifest, target, features) {
  const args = [
    "--locked",
    "--manifest-path",
    manifest,
    "--target",
    target,
    "--edges",
    "normal",
    "--prefix",
    "depth",
    "--format",
    "{p}|{f}",
  ];
  if (features.length === 1 && features[0] === "none") {
    args.push("--no-default-features");
  } else if (!(features.length === 1 && features[0] === "default")) {
    args.push("--no-default-features", "--features", features.join(","));
  }
  return args;
}

function parseCargoTree(output) {
  const packages = new Map();
  let skippedProcMacroDepth = undefined;
  for (const line of output.split("\n").filter(Boolean)) {
    const depthMatch = /^(\d+)(.+)$/.exec(line);
    if (!depthMatch) throw new Error(`unparseable cargo tree line: ${line}`);
    const depth = Number(depthMatch[1]);
    const body = depthMatch[2];
    if (skippedProcMacroDepth !== undefined) {
      if (depth > skippedProcMacroDepth) continue;
      skippedProcMacroDepth = undefined;
    }
    const separator = body.lastIndexOf("|");
    if (separator === -1)
      throw new Error(`cargo tree line lacks features: ${line}`);
    const packageText = body.slice(0, separator).replace(/ \(\*\)$/, "");
    if (packageText.endsWith(" (proc-macro)")) {
      skippedProcMacroDepth = depth;
      continue;
    }
    const match = /^(.+) v([^ ]+)(?: \(.+\))?$/.exec(packageText);
    if (!match) throw new Error(`unparseable cargo package identity: ${line}`);
    const key = `${match[1]}\0${match[2]}`;
    const featureText = body.slice(separator + 1).replace(/ \(\*\)$/, "");
    const entry = packages.get(key) ?? {
      name: match[1],
      version: match[2],
      features: new Set(),
    };
    for (const feature of featureText.split(",").filter(Boolean)) {
      entry.features.add(feature);
    }
    packages.set(key, entry);
  }
  if (packages.size === 0)
    throw new Error("cargo tree returned no runtime packages");
  return packages;
}

function expectedRuntimeGraph({
  cargoLock,
  cargoManifest,
  target,
  features,
  execute,
}) {
  const lock = resolve(cargoLock);
  const manifest = resolve(cargoManifest);
  requireRegularFile(lock, "Cargo.lock");
  requireRegularFile(manifest, "Cargo manifest");
  if (resolve(dirname(manifest), "Cargo.lock") !== lock) {
    throw new Error(
      "Cargo runtime evidence must use the manifest's exact Cargo.lock",
    );
  }
  const featureList = parseFeatures(features);
  let metadata;
  try {
    metadata = JSON.parse(
      execute(
        "cargo",
        [
          "metadata",
          "--locked",
          "--format-version",
          "1",
          "--manifest-path",
          manifest,
          "--filter-platform",
          target,
          ...(featureList[0] === "none"
            ? ["--no-default-features"]
            : featureList[0] === "default"
              ? []
              : ["--no-default-features", "--features", featureList.join(",")]),
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      ),
    );
  } catch (error) {
    throw new Error(`unable to derive locked Cargo metadata: ${error.message}`);
  }
  const tree = parseCargoTree(
    execute(
      "cargo",
      ["tree", ...cargoArguments(manifest, target, featureList)],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      },
    ),
  );
  const metadataByIdentity = new Map();
  for (const entry of metadata.packages ?? []) {
    const key = `${entry.name}\0${entry.version}`;
    if (metadataByIdentity.has(key)) {
      throw new Error(
        `Cargo metadata has ambiguous package identity ${entry.name} ${entry.version}`,
      );
    }
    metadataByIdentity.set(key, entry);
  }
  const packages = [...tree.entries()].map(([key, entry]) => {
    const metadataPackage = metadataByIdentity.get(key);
    if (!metadataPackage) {
      throw new Error(
        `cargo tree package is absent from locked metadata: ${entry.name} ${entry.version}`,
      );
    }
    return {
      name: entry.name,
      version: entry.version,
      source: sourceKind(metadataPackage.source),
      features: [...entry.features].sort(),
    };
  });
  packages.sort((left, right) =>
    `${left.name}\0${left.version}\0${left.source}`.localeCompare(
      `${right.name}\0${right.version}\0${right.source}`,
    ),
  );
  const graph = { target, features: featureList, packages };
  return {
    graph,
    sha256: sha256Bytes(canonicalJson(graph)),
    lock: {
      path: basename(lock),
      bytes: requireRegularFile(lock, "Cargo.lock").size,
      sha256: sha256File(lock),
    },
  };
}

function validateAuditableDocument(document) {
  if (
    !document ||
    Array.isArray(document) ||
    typeof document !== "object" ||
    document.format !== 1 ||
    !Array.isArray(document.packages) ||
    document.packages.length === 0 ||
    document.packages.length > MAX_PACKAGES
  ) {
    throw new Error(
      "embedded Cargo audit evidence must be format 1 with a bounded package list",
    );
  }
  const roots = [];
  for (const [index, entry] of document.packages.entries()) {
    if (!entry || Array.isArray(entry) || typeof entry !== "object") {
      throw new Error(`embedded Cargo package ${index} must be an object`);
    }
    const allowed = new Set([
      "dependencies",
      "kind",
      "name",
      "root",
      "source",
      "version",
    ]);
    if (Object.keys(entry).some((key) => !allowed.has(key))) {
      throw new Error(`embedded Cargo package ${index} has an unknown field`);
    }
    if (
      typeof entry.name !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(entry.name) ||
      typeof entry.version !== "string" ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.version) ||
      !KNOWN_SOURCES.has(entry.source) ||
      (entry.kind !== undefined &&
        entry.kind !== "build" &&
        entry.kind !== "runtime") ||
      (entry.root !== undefined && typeof entry.root !== "boolean")
    ) {
      throw new Error(
        `embedded Cargo package ${index} has an invalid identity`,
      );
    }
    const dependencies = entry.dependencies ?? [];
    if (
      !Array.isArray(dependencies) ||
      new Set(dependencies).size !== dependencies.length ||
      dependencies.some(
        (dependency) =>
          !Number.isInteger(dependency) ||
          dependency < 0 ||
          dependency >= document.packages.length ||
          dependency === index,
      )
    ) {
      throw new Error(
        `embedded Cargo package ${index} has invalid dependencies`,
      );
    }
    if (entry.root === true) roots.push(index);
  }
  if (roots.length !== 1) {
    throw new Error(
      "embedded Cargo audit evidence must have exactly one root package",
    );
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (index) => {
    if (visiting.has(index))
      throw new Error("embedded Cargo audit evidence contains a cycle");
    if (visited.has(index)) return;
    visiting.add(index);
    for (const dependency of document.packages[index].dependencies ?? [])
      visit(dependency);
    visiting.delete(index);
    visited.add(index);
  };
  visit(roots[0]);
  if (visited.size !== document.packages.length) {
    throw new Error(
      "embedded Cargo audit evidence contains an unreachable package",
    );
  }
  return document;
}

function extractEvidence(executable, execute) {
  const info = requireRegularFile(executable, "shipping Linux executable");
  if ((info.mode & 0o111) === 0) {
    throw new Error("shipping Linux executable is not executable");
  }
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-cargo-evidence-"));
  const section = resolve(temporary, "dep-v0.zlib");
  try {
    execute("objcopy", ["--dump-section", `.dep-v0=${section}`, executable], {
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
  } catch {
    rmSync(temporary, { recursive: true, force: true });
    throw new Error(
      "shipping Linux executable is missing embedded Cargo audit evidence",
    );
  }
  let compressed;
  try {
    let sectionInfo;
    try {
      sectionInfo = requireRegularFile(
        section,
        "embedded Cargo audit evidence",
      );
    } catch {
      throw new Error(
        "shipping Linux executable is missing embedded Cargo audit evidence",
      );
    }
    if (sectionInfo.size > MAX_EVIDENCE_BYTES) {
      throw new Error(
        "shipping Linux executable has oversized Cargo audit evidence",
      );
    }
    compressed = readFileSync(section);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (!Buffer.isBuffer(compressed) || compressed.length === 0) {
    throw new Error("shipping Linux executable has empty Cargo audit evidence");
  }
  let jsonBytes;
  try {
    jsonBytes = inflateSync(compressed, {
      maxOutputLength: MAX_EVIDENCE_JSON_BYTES,
    });
  } catch {
    throw new Error(
      "embedded Cargo audit evidence is not bounded valid zlib data",
    );
  }
  let document;
  try {
    document = JSON.parse(jsonBytes.toString("utf8"));
  } catch {
    throw new Error("embedded Cargo audit evidence is not valid UTF-8 JSON");
  }
  validateAuditableDocument(document);
  return {
    document,
    compressedBytes: compressed.length,
    compressedSha256: sha256Bytes(compressed),
    jsonSha256: sha256Bytes(jsonBytes),
  };
}

function identity(entry) {
  return `${entry.name}\0${entry.version}\0${entry.source}`;
}

function reconcileRuntimePackages(evidence, expected) {
  const actual = new Map();
  for (const entry of evidence.document.packages) {
    if (entry.kind === "build") continue;
    const key = identity(entry);
    if (actual.has(key))
      throw new Error(
        `embedded Cargo runtime package is duplicated: ${entry.name} ${entry.version}`,
      );
    actual.set(key, entry);
  }
  const wanted = new Map(
    expected.graph.packages.map((entry) => [identity(entry), entry]),
  );
  const omitted = [...wanted.keys()].filter((key) => !actual.has(key));
  const unknown = [...actual.keys()].filter((key) => !wanted.has(key));
  if (omitted.length > 0) {
    const entry = wanted.get(omitted[0]);
    throw new Error(
      `embedded Cargo runtime graph omits locked package ${entry.name} ${entry.version}`,
    );
  }
  if (unknown.length > 0) {
    const entry = actual.get(unknown[0]);
    throw new Error(
      `embedded Cargo runtime graph contains unknown or wrong-version package ${entry.name} ${entry.version}`,
    );
  }
  return expected.graph.packages;
}

export function collectLinuxCargoRuntime({
  root,
  cargoLock,
  cargoManifest,
  cargoTarget,
  cargoFeatures,
  execute = execFileSync,
}) {
  const rootPath = resolve(root);
  const executable = resolve(rootPath, "usr/bin/zuuli");
  const executablePath = relative(rootPath, executable).split(sep).join("/");
  const expected = expectedRuntimeGraph({
    cargoLock,
    cargoManifest,
    target: cargoTarget,
    features: cargoFeatures,
    execute,
  });
  const evidence = extractEvidence(executable, execute);
  const packages = reconcileRuntimePackages(evidence, expected);
  const executableInfo = requireRegularFile(
    executable,
    "shipping Linux executable",
  );
  const binding = {
    target: expected.graph.target,
    features: expected.graph.features,
    cargoLock: expected.lock,
    executable: {
      path: executablePath,
      bytes: executableInfo.size,
      sha256: sha256File(executable),
    },
    evidence: {
      format: evidence.document.format,
      compressedBytes: evidence.compressedBytes,
      compressedSha256: evidence.compressedSha256,
      jsonSha256: evidence.jsonSha256,
      runtimePackages: packages.length,
      graphSha256: expected.sha256,
    },
  };
  return { binding, packages };
}

export function cargoRuntimeMetadataProperties(runtime) {
  return {
    [CARGO_RUNTIME_SCOPE]: "linked-linux-executable",
    [CARGO_RUNTIME_TARGET]: runtime.binding.target,
    [CARGO_RUNTIME_FEATURES]: JSON.stringify(runtime.binding.features),
    [CARGO_RUNTIME_LOCK_SHA256]: runtime.binding.cargoLock.sha256,
    [CARGO_RUNTIME_EVIDENCE_SHA256]: runtime.binding.evidence.compressedSha256,
    [CARGO_RUNTIME_GRAPH_SHA256]: runtime.binding.evidence.graphSha256,
    [CARGO_RUNTIME_EXECUTABLE]: runtime.binding.executable.path,
    [CARGO_RUNTIME_EXECUTABLE_SHA256]: runtime.binding.executable.sha256,
  };
}

function componentProperties(properties) {
  return Object.entries(properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value: `${value}` }));
}

export function cargoRuntimeComponents(runtime) {
  return runtime.packages.map((entry) => {
    const key = identity(entry);
    return {
      type: entry.name === "zuuli" ? "application" : "library",
      "bom-ref": `cargo-runtime:${sha256Bytes(key)}`,
      name: entry.name,
      version: entry.version,
      ...(entry.source === "crates.io"
        ? {
            purl: `pkg:cargo/${encodeURIComponent(entry.name)}@${encodeURIComponent(entry.version)}`,
          }
        : {}),
      properties: componentProperties({
        [CARGO_RUNTIME_PACKAGE]: "true",
        [CARGO_RUNTIME_SOURCE]: entry.source,
        [CARGO_RUNTIME_PACKAGE_FEATURES]: JSON.stringify(entry.features),
      }),
    };
  });
}
