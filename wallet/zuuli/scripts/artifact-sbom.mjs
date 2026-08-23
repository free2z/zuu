#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const INVENTORY_SCOPE = "free2z:inventory-scope";
const ARTIFACT_NAME = "free2z:artifact-name";
const ARTIFACT_SHA256 = "free2z:artifact-sha256";
const ARTIFACT_BYTES = "free2z:artifact-bytes";
const ARTIFACT_PATH = "free2z:artifact:path";
const ARTIFACT_KIND = "free2z:artifact:kind";
const ARTIFACT_FILE_BYTES = "free2z:artifact:file-bytes";
const ARTIFACT_LINK_TARGET = "free2z:artifact:link-target";
const SOURCE_ROOT = "free2z:source-root";
const SOURCE_COMMIT = "free2z:source-commit";

// Mobile stores reject packages anywhere near these ceilings. Enforcing them
// before extraction also keeps a corrupt or hostile ZIP from exhausting a CI
// runner while the SBOM boundary is being checked.
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024;

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
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

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function safeArchiveMember(member) {
  if (
    member.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(member) ||
    member.includes("\\") ||
    isAbsolute(member)
  ) {
    return false;
  }
  const trimmed = member.endsWith("/") ? member.slice(0, -1) : member;
  if (trimmed.length === 0) return true;
  const segments = trimmed.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

export function validateArchiveMembers(members) {
  if (members.length === 0) throw new Error("archive is empty");
  if (members.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `archive has too many entries: ${members.length} > ${MAX_ARCHIVE_ENTRIES}`,
    );
  }
  const seen = new Set();
  for (const member of members) {
    if (!safeArchiveMember(member)) {
      throw new Error(`unsafe archive member ${JSON.stringify(member)}`);
    }
    const canonical = member.endsWith("/") ? member.slice(0, -1) : member;
    if (seen.has(canonical)) {
      throw new Error(`duplicate archive member ${JSON.stringify(canonical)}`);
    }
    seen.add(canonical);
  }
  return members;
}

function zipMembers(artifact) {
  const listing = execFileSync("unzip", ["-Z1", artifact], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const members = validateArchiveMembers(listing.split("\n").filter(Boolean));
  const totals = execFileSync("unzip", ["-Z", "-t", artifact], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
  const match = /^(\d+) files?, ([\d,]+) bytes uncompressed,/.exec(totals);
  if (!match) throw new Error("unable to read archive resource totals");
  const entryCount = Number(match[1]);
  const unpackedBytes = Number(match[2].replaceAll(",", ""));
  if (entryCount !== members.length) {
    throw new Error(
      `archive listing count changed: ${members.length} names, ${entryCount} entries`,
    );
  }
  if (
    !Number.isSafeInteger(unpackedBytes) ||
    unpackedBytes > MAX_UNPACKED_BYTES
  ) {
    throw new Error(
      `archive expands beyond the ${MAX_UNPACKED_BYTES}-byte safety limit`,
    );
  }
  return members;
}

export function inventoryRoot(
  rootPath,
  { allowExternalSymlinks = false } = {},
) {
  const root = realpathSync(rootPath);
  const entries = [];
  let regularBytes = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (!safeArchiveMember(path)) {
        throw new Error(
          `unsafe unpacked artifact path: ${JSON.stringify(path)}`,
        );
      }
      const info = lstatSync(absolute);
      if (info.isDirectory()) {
        visit(absolute);
      } else if (info.isFile()) {
        regularBytes += info.size;
        if (regularBytes > MAX_UNPACKED_BYTES) {
          throw new Error(
            `unpacked artifact exceeds the ${MAX_UNPACKED_BYTES}-byte safety limit`,
          );
        }
        entries.push({
          path,
          kind: "regular",
          bytes: info.size,
          sha256: sha256File(absolute),
        });
      } else if (info.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (isAbsolute(target) && !allowExternalSymlinks) {
          throw new Error(
            `artifact symlink must be relative: ${path} -> ${target}`,
          );
        }
        if (/[\u0000-\u001f\u007f]/.test(target)) {
          throw new Error(`artifact symlink target has control bytes: ${path}`);
        }
        if (!allowExternalSymlinks) {
          const resolvedTarget = realpathSync(absolute);
          if (!isInside(root, resolvedTarget)) {
            throw new Error(
              `artifact symlink escapes payload: ${path} -> ${target}`,
            );
          }
        }
        entries.push({ path, kind: "symlink", target });
      } else {
        throw new Error(`unsupported artifact member type: ${path}`);
      }
    }
  };
  visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (entries.length === 0)
    throw new Error(`unpacked artifact is empty: ${root}`);
  return entries;
}

function artifactFormat(artifact) {
  const lower = artifact.toLowerCase();
  if (lower.endsWith(".dmg")) return "dmg";
  const extension = lower.split(".").at(-1);
  if (["aab", "ipa", "zip"].includes(extension)) return "zip";
  throw new Error(`unsupported artifact format .${extension}`);
}

function cloneMountedTree(sourcePath, destinationPath) {
  const source = realpathSync(sourcePath);
  let entries = 0;
  let regularBytes = 0;
  mkdirSync(destinationPath);
  const visit = (sourceDirectory, destinationDirectory) => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        throw new Error(
          `artifact has too many entries: ${entries} > ${MAX_ARCHIVE_ENTRIES}`,
        );
      }
      const sourceEntry = resolve(sourceDirectory, entry.name);
      const relativePath = relative(source, sourceEntry).split(sep).join("/");
      if (!safeArchiveMember(relativePath)) {
        throw new Error(
          `unsafe mounted artifact path: ${JSON.stringify(relativePath)}`,
        );
      }
      const destinationEntry = resolve(destinationDirectory, entry.name);
      const info = lstatSync(sourceEntry);
      if (info.isDirectory()) {
        mkdirSync(destinationEntry);
        chmodSync(destinationEntry, info.mode & 0o777);
        visit(sourceEntry, destinationEntry);
      } else if (info.isFile()) {
        regularBytes += info.size;
        if (regularBytes > MAX_UNPACKED_BYTES) {
          throw new Error(
            `artifact expands beyond the ${MAX_UNPACKED_BYTES}-byte safety limit`,
          );
        }
        copyFileSync(sourceEntry, destinationEntry);
        chmodSync(destinationEntry, info.mode & 0o777);
      } else if (info.isSymbolicLink()) {
        const target = readlinkSync(sourceEntry);
        if (/[\u0000-\u001f\u007f]/.test(target)) {
          throw new Error(
            `artifact symlink target has control bytes: ${relativePath}`,
          );
        }
        // A read-only DMG commonly ships an absolute /Applications link. Copy
        // the link bytes without dereferencing them; no destination write can
        // escape through it because this walker never descends into symlinks.
        symlinkSync(target, destinationEntry);
      } else {
        throw new Error(
          `unsupported mounted artifact member type: ${relativePath}`,
        );
      }
    }
  };
  visit(source, destinationPath);
}

function extractDmg(artifact, root) {
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-dmg-mount-"));
  const mountpoint = resolve(temporary, "mount");
  mkdirSync(mountpoint);
  let mounted = false;
  try {
    execFileSync(
      "hdiutil",
      ["attach", artifact, "-readonly", "-nobrowse", "-mountpoint", mountpoint],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
    );
    mounted = true;
    cloneMountedTree(mountpoint, root);
  } finally {
    let detached = !mounted;
    if (mounted) {
      try {
        execFileSync("hdiutil", ["detach", mountpoint], {
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 120_000,
        });
        detached = true;
      } catch {
        try {
          // Spotlight or Finder can briefly hold a newly mounted image. This
          // mount is private and read-only, so a bounded forced detach is the
          // safe fallback used by the release verifier too.
          execFileSync("hdiutil", ["detach", mountpoint, "-force"], {
            stdio: ["ignore", "ignore", "pipe"],
            timeout: 120_000,
          });
          detached = true;
        } catch {
          // Never recursively remove a live mount. Leave the private path in
          // place for the runner cleanup and fail the artifact boundary.
        }
      }
    }
    if (!detached) throw new Error("failed to detach artifact DMG safely");
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function prepareArtifact({ artifact, root }) {
  const artifactInfo = requireRegularFile(artifact, "artifact");
  if (artifactInfo.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `artifact exceeds the ${MAX_ARCHIVE_BYTES}-byte safety limit`,
    );
  }
  const format = artifactFormat(artifact);
  if (format === "zip") zipMembers(artifact);
  if (existsSync(root)) throw new Error(`scan root already exists: ${root}`);
  mkdirSync(dirname(root), { recursive: true });
  if (format === "zip") {
    mkdirSync(root);
    execFileSync("unzip", ["-qq", artifact, "-d", root]);
  } else {
    extractDmg(artifact, root);
  }
  const inventory = inventoryRoot(root, {
    allowExternalSymlinks: format === "dmg",
  });
  console.log(
    `unpacked ${basename(artifact)} into ${inventory.length} shipped payload entries`,
  );
  return inventory;
}

function inventoryArtifactFresh(artifact) {
  const temporary = mkdtempSync(
    resolve(tmpdir(), "zuuli-artifact-sbom-verify-"),
  );
  const root = resolve(temporary, "payload");
  try {
    return prepareArtifact({ artifact, root });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function parseJson(path, label) {
  requireRegularFile(path, label);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} root must be an object`);
  }
  return value;
}

function setProperties(properties, replacements) {
  const names = new Set(Object.keys(replacements));
  const kept = Array.isArray(properties)
    ? properties.filter(
        (property) =>
          property &&
          typeof property === "object" &&
          typeof property.name === "string" &&
          !names.has(property.name),
      )
    : [];
  for (const name of [...names].sort()) {
    kept.push({ name, value: `${replacements[name]}` });
  }
  return kept;
}

function propertyMap(properties) {
  const result = new Map();
  for (const property of Array.isArray(properties) ? properties : []) {
    if (
      !property ||
      typeof property !== "object" ||
      typeof property.name !== "string" ||
      typeof property.value !== "string" ||
      result.has(property.name)
    ) {
      throw new Error(
        "SBOM properties must have unique string names and values",
      );
    }
    result.set(property.name, property.value);
  }
  return result;
}

function inventoryComponent(entry) {
  const identity =
    entry.kind === "regular"
      ? `${entry.kind}\0${entry.path}\0${entry.bytes}\0${entry.sha256}`
      : `${entry.kind}\0${entry.path}\0${entry.target}`;
  const properties = {
    [ARTIFACT_PATH]: entry.path,
    [ARTIFACT_KIND]: entry.kind,
  };
  if (entry.kind === "regular") properties[ARTIFACT_FILE_BYTES] = entry.bytes;
  else properties[ARTIFACT_LINK_TARGET] = entry.target;
  return {
    type: "file",
    "bom-ref": `artifact-file:${sha256Text(identity)}`,
    name: entry.path,
    ...(entry.kind === "regular"
      ? { hashes: [{ alg: "SHA-256", content: entry.sha256 }] }
      : {}),
    properties: setProperties([], properties),
  };
}

function canonicalWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
}

function artifactMetadata(artifact) {
  const info = requireRegularFile(artifact, "artifact");
  return {
    path: basename(artifact),
    bytes: info.size,
    sha256: sha256File(artifact),
  };
}

function requireCycloneDx(sbom, label) {
  if (sbom.bomFormat !== "CycloneDX") {
    throw new Error(`${label} must have bomFormat CycloneDX`);
  }
  if (typeof sbom.specVersion !== "string") {
    throw new Error(`${label} must have a string specVersion`);
  }
  if (sbom.components !== undefined && !Array.isArray(sbom.components)) {
    throw new Error(`${label} components must be an array`);
  }
}

function regularComponentHash(component) {
  const hashes = Array.isArray(component.hashes) ? component.hashes : [];
  const matches = hashes.filter((hash) => hash?.alg === "SHA-256");
  if (
    matches.length !== 1 ||
    !/^[0-9a-f]{64}$/.test(matches[0]?.content ?? "")
  ) {
    throw new Error(
      "artifact file component must have one lowercase SHA-256 hash",
    );
  }
  return matches[0].content;
}

export function verifyArtifactSbom({ artifact, sbom: sbomPath, binding }) {
  const artifactInfo = artifactMetadata(artifact);
  const sbomInfo = {
    path: basename(sbomPath),
    bytes: requireRegularFile(sbomPath, "SBOM").size,
    sha256: sha256File(sbomPath),
  };
  const record = parseJson(binding, "artifact-SBOM binding");
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "artifact-sbom-binding" ||
    JSON.stringify(record.artifact) !== JSON.stringify(artifactInfo) ||
    JSON.stringify(record.sbom) !== JSON.stringify(sbomInfo)
  ) {
    throw new Error(
      "artifact-SBOM binding does not match exact artifact and SBOM bytes",
    );
  }

  const sbom = parseJson(sbomPath, "SBOM");
  requireCycloneDx(sbom, "SBOM");
  const metadata = propertyMap(sbom.metadata?.properties);
  for (const [name, expected] of [
    [INVENTORY_SCOPE, "shipped-artifact"],
    [ARTIFACT_NAME, artifactInfo.path],
    [ARTIFACT_SHA256, artifactInfo.sha256],
    [ARTIFACT_BYTES, `${artifactInfo.bytes}`],
  ]) {
    if (metadata.get(name) !== expected) {
      throw new Error(`SBOM metadata ${name} does not match ${expected}`);
    }
  }

  // This is intentionally derived from the bound archive in a fresh, private
  // extraction directory. The root Syft scanned is mutable workspace state and
  // cannot be trusted as verification evidence for the shipped archive.
  const expected = new Map(
    inventoryArtifactFresh(artifact).map((entry) => [entry.path, entry]),
  );
  const actual = new Map();
  for (const component of sbom.components ?? []) {
    if (component?.type !== "file") continue;
    const properties = propertyMap(component.properties);
    const path = properties.get(ARTIFACT_PATH);
    if (!path) continue;
    if (actual.has(path))
      throw new Error(`duplicate artifact file component: ${path}`);
    actual.set(path, {
      kind: properties.get(ARTIFACT_KIND),
      bytes: properties.get(ARTIFACT_FILE_BYTES),
      target: properties.get(ARTIFACT_LINK_TARGET),
      sha256:
        properties.get(ARTIFACT_KIND) === "regular"
          ? regularComponentHash(component)
          : undefined,
    });
  }
  if (actual.size !== expected.size) {
    throw new Error(
      `artifact file inventory count mismatch: expected ${expected.size}, got ${actual.size}`,
    );
  }
  for (const [path, entry] of expected) {
    const component = actual.get(path);
    if (!component)
      throw new Error(`SBOM omits shipped artifact entry: ${path}`);
    if (
      component.kind !== entry.kind ||
      (entry.kind === "regular" &&
        (component.bytes !== `${entry.bytes}` ||
          component.sha256 !== entry.sha256)) ||
      (entry.kind === "symlink" && component.target !== entry.target)
    ) {
      throw new Error(
        `SBOM artifact entry does not match shipped bytes: ${path}`,
      );
    }
  }
  if (
    JSON.stringify(artifactMetadata(artifact)) !== JSON.stringify(artifactInfo)
  ) {
    throw new Error("artifact changed during independent SBOM verification");
  }
  const sbomAfter = {
    path: basename(sbomPath),
    bytes: requireRegularFile(sbomPath, "SBOM").size,
    sha256: sha256File(sbomPath),
  };
  if (JSON.stringify(sbomAfter) !== JSON.stringify(sbomInfo)) {
    throw new Error("SBOM changed during independent artifact verification");
  }
  if (record.inventoryEntries !== expected.size) {
    throw new Error("artifact-SBOM binding inventory count is stale");
  }
  return {
    artifact: artifactInfo,
    sbom: sbomInfo,
    inventoryEntries: expected.size,
  };
}

export function finalizeArtifactSbom({
  artifact,
  root,
  rawSbom,
  sbom: sbomPath,
  binding,
}) {
  const document = parseJson(rawSbom, "raw Syft SBOM");
  requireCycloneDx(document, "raw Syft SBOM");
  const artifactInfo = artifactMetadata(artifact);
  const inventory = inventoryRoot(root, {
    allowExternalSymlinks: artifactFormat(artifact) === "dmg",
  });
  const packageComponents = (document.components ?? []).filter((component) => {
    if (component?.type !== "file") return true;
    const properties = propertyMap(component.properties);
    return !properties.has(ARTIFACT_PATH);
  });
  document.metadata = document.metadata ?? {};
  document.metadata.component = {
    type: "file",
    "bom-ref": `artifact:sha256:${artifactInfo.sha256}`,
    name: artifactInfo.path,
    hashes: [{ alg: "SHA-256", content: artifactInfo.sha256 }],
  };
  document.metadata.properties = setProperties(document.metadata.properties, {
    [INVENTORY_SCOPE]: "shipped-artifact",
    [ARTIFACT_NAME]: artifactInfo.path,
    [ARTIFACT_SHA256]: artifactInfo.sha256,
    [ARTIFACT_BYTES]: artifactInfo.bytes,
  });
  document.components = [
    ...packageComponents,
    ...inventory.map(inventoryComponent),
  ];
  canonicalWrite(sbomPath, document);
  const sbomInfo = {
    path: basename(sbomPath),
    bytes: statSync(sbomPath).size,
    sha256: sha256File(sbomPath),
  };
  canonicalWrite(binding, {
    schemaVersion: 1,
    kind: "artifact-sbom-binding",
    artifact: artifactInfo,
    sbom: sbomInfo,
    inventoryEntries: inventory.length,
  });
  console.log(
    `wrote ${sbomInfo.path} (${inventory.length} scanned entries) bound to sha256:${artifactInfo.sha256}; independent artifact verification is still required`,
  );
}

export function labelSourceSbom({
  rawSbom,
  sbom: sbomPath,
  sourceRoot,
  sourceCommit,
}) {
  const document = parseJson(rawSbom, "raw Syft SBOM");
  requireCycloneDx(document, "raw Syft SBOM");
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("source commit must be a full lowercase Git SHA");
  }
  document.metadata = document.metadata ?? {};
  document.metadata.properties = setProperties(document.metadata.properties, {
    [INVENTORY_SCOPE]: "source-tree",
    [SOURCE_ROOT]: sourceRoot,
    [SOURCE_COMMIT]: sourceCommit,
  });
  canonicalWrite(sbomPath, document);
  const properties = propertyMap(
    parseJson(sbomPath, "source SBOM").metadata?.properties,
  );
  if (
    properties.get(INVENTORY_SCOPE) !== "source-tree" ||
    properties.get(SOURCE_ROOT) !== sourceRoot ||
    properties.get(SOURCE_COMMIT) !== sourceCommit
  ) {
    throw new Error("source SBOM metadata label did not persist");
  }
  console.log(`labeled ${basename(sbomPath)} as source-tree inventory`);
}

function jobBlock(workflow, jobName) {
  const marker = `\n  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) return "";
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function requireExactRunStep(label, block, stepName, expectedLines, failures) {
  const marker = `\n      - name: ${stepName}\n`;
  const count = block.split(marker).length - 1;
  if (count !== 1) {
    failures.push(
      `${label}: expected one named ${stepName} step, found ${count}`,
    );
    return;
  }
  const rest = block.slice(block.indexOf(marker) + marker.length);
  const next = rest.search(/^      - /m);
  const step = next === -1 ? rest : rest.slice(0, next);
  const runMarker = "        run: |\n";
  if (!step.startsWith(runMarker)) {
    failures.push(`${label}: ${stepName} must be a multiline run step`);
    return;
  }
  const actualLines = step
    .slice(runMarker.length)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) {
    failures.push(`${label}: ${stepName} executable lines changed`);
  }
}

function requireOrdered(label, block, markers, failures) {
  let previous = -1;
  for (const marker of markers) {
    const count = block.split(marker).length - 1;
    const index = block.indexOf(marker);
    if (count !== 1)
      failures.push(`${label}: expected one ${marker}, found ${count}`);
    if (index <= previous)
      failures.push(`${label}: ${marker} is missing or out of order`);
    previous = index;
  }
}

export function artifactSbomWorkflowFailures(packaging, release) {
  const failures = [];
  for (const [label, block, markers] of [
    [
      "packaging android",
      jobBlock(packaging, "android"),
      [
        "node scripts/artifact-sbom.mjs prepare --artifact=release-artifacts/ZUULI-android-unsigned.aab --root=artifact-sbom-work/android/root",
        "path: wallet/zuuli/artifact-sbom-work/android/root",
        "config: wallet/zuuli/syft-artifact.yaml",
        "node scripts/artifact-sbom.mjs finalize-artifact --artifact=release-artifacts/ZUULI-android-unsigned.aab --root=artifact-sbom-work/android/root --raw-sbom=artifact-sbom-work/android/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-android.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-android.artifact.sbom-binding.json",
        "node scripts/artifact-sbom.mjs verify-artifact --artifact=release-artifacts/ZUULI-android-unsigned.aab --sbom=release-artifacts/ZUULI-android.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-android.artifact.sbom-binding.json",
        "npm run release:manifest -- --artifacts=release-artifacts",
        "actions/upload-artifact@",
      ],
    ],
    [
      "packaging ios",
      jobBlock(packaging, "ios"),
      [
        "node scripts/artifact-sbom.mjs prepare --artifact=release-artifacts/ZUULI-ios-unsigned.zip --root=artifact-sbom-work/ios/root",
        "path: wallet/zuuli/artifact-sbom-work/ios/root",
        "config: wallet/zuuli/syft-artifact.yaml",
        "node scripts/artifact-sbom.mjs finalize-artifact --artifact=release-artifacts/ZUULI-ios-unsigned.zip --root=artifact-sbom-work/ios/root --raw-sbom=artifact-sbom-work/ios/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-ios.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-ios.artifact.sbom-binding.json",
        "node scripts/artifact-sbom.mjs verify-artifact --artifact=release-artifacts/ZUULI-ios-unsigned.zip --sbom=release-artifacts/ZUULI-ios.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-ios.artifact.sbom-binding.json",
        "npm run release:manifest -- --artifacts=release-artifacts",
        "actions/upload-artifact@",
      ],
    ],
    [
      "release android",
      jobBlock(release, "android"),
      [
        'node scripts/artifact-sbom.mjs prepare --artifact="$artifact" --root=artifact-sbom-work/android/root',
        "path: wallet/zuuli/artifact-sbom-work/android/root",
        "config: wallet/zuuli/syft-artifact.yaml",
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="$artifact" --root=artifact-sbom-work/android/root --raw-sbom=artifact-sbom-work/android/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-android.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-android.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="$artifact" --sbom=release-artifacts/ZUULI-android.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-android.artifact.sbom-binding.json',
        "npm run release:manifest -- --artifacts=release-artifacts",
        "actions/attest-build-provenance@",
      ],
    ],
    [
      "release ios",
      jobBlock(release, "ios-finalize"),
      [
        'node scripts/artifact-sbom.mjs prepare --artifact="$artifact" --root=artifact-sbom-work/ios/root',
        "path: wallet/zuuli/artifact-sbom-work/ios/root",
        "config: wallet/zuuli/syft-artifact.yaml",
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="$artifact" --root=artifact-sbom-work/ios/root --raw-sbom=artifact-sbom-work/ios/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-ios.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-ios.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="$artifact" --sbom=release-artifacts/ZUULI-ios.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-ios.artifact.sbom-binding.json',
        "node scripts/release-manifest.mjs --artifacts=release-artifacts",
        "actions/attest-build-provenance@",
      ],
    ],
    [
      "packaging macos",
      jobBlock(packaging, "desktop"),
      [
        'node scripts/artifact-sbom.mjs prepare --artifact="${dmgs[0]}" --root=artifact-sbom-work/macos-dmg/root',
        'node scripts/artifact-sbom.mjs prepare --artifact="${zips[0]}" --root=artifact-sbom-work/macos-zip/root',
        "output-file: wallet/zuuli/artifact-sbom-work/macos-dmg/syft.raw.sbom.cdx.json",
        "output-file: wallet/zuuli/artifact-sbom-work/macos-zip/syft.raw.sbom.cdx.json",
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${dmgs[0]}" --root=artifact-sbom-work/macos-dmg/root --raw-sbom=artifact-sbom-work/macos-dmg/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-macos-dmg.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-dmg.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${zips[0]}" --root=artifact-sbom-work/macos-zip/root --raw-sbom=artifact-sbom-work/macos-zip/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-macos-zip.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-zip.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${dmgs[0]}" --sbom=release-artifacts/ZUULI-macos-dmg.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-dmg.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${zips[0]}" --sbom=release-artifacts/ZUULI-macos-zip.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-zip.artifact.sbom-binding.json',
        "npm run release:manifest -- --artifacts=release-artifacts",
        "actions/upload-artifact@",
      ],
    ],
    [
      "release macos artifacts",
      jobBlock(release, "macos-finalize"),
      [
        'node scripts/artifact-sbom.mjs prepare --artifact="release-artifacts/ZUULI-${RELEASE_IDENTITY}-macos.dmg" --root=artifact-sbom-work/macos-dmg/root',
        'node scripts/artifact-sbom.mjs prepare --artifact="release-artifacts/ZUULI-${RELEASE_IDENTITY}-macos-universal.zip" --root=artifact-sbom-work/macos-zip/root',
        "output-file: wallet/zuuli/artifact-sbom-work/macos-dmg/syft.raw.sbom.cdx.json",
        "output-file: wallet/zuuli/artifact-sbom-work/macos-zip/syft.raw.sbom.cdx.json",
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="release-artifacts/ZUULI-${RELEASE_IDENTITY}-macos.dmg" --root=artifact-sbom-work/macos-dmg/root --raw-sbom=artifact-sbom-work/macos-dmg/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-macos-dmg.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-dmg.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="release-artifacts/ZUULI-${RELEASE_IDENTITY}-macos-universal.zip" --root=artifact-sbom-work/macos-zip/root --raw-sbom=artifact-sbom-work/macos-zip/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-macos-zip.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-zip.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="release-artifacts/ZUULI-${RELEASE_IDENTITY}-macos.dmg" --sbom=release-artifacts/ZUULI-macos-dmg.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-dmg.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="release-artifacts/ZUULI-${RELEASE_IDENTITY}-macos-universal.zip" --sbom=release-artifacts/ZUULI-macos-zip.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-zip.artifact.sbom-binding.json',
        "node scripts/release-manifest.mjs --artifacts=release-artifacts",
        "actions/attest-build-provenance@",
      ],
    ],
  ]) {
    requireOrdered(label, block, markers, failures);
  }
  for (const [label, block, expectedLines] of [
    [
      "packaging android",
      jobBlock(packaging, "android"),
      [
        "node scripts/artifact-sbom.mjs verify-artifact --artifact=release-artifacts/ZUULI-android-unsigned.aab --sbom=release-artifacts/ZUULI-android.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-android.artifact.sbom-binding.json",
        "npm run release:manifest -- --artifacts=release-artifacts --checksums=release-artifacts/CHECKSUMS.sha256 --output=release-artifacts/provenance.json",
      ],
    ],
    [
      "packaging ios",
      jobBlock(packaging, "ios"),
      [
        "node scripts/artifact-sbom.mjs verify-artifact --artifact=release-artifacts/ZUULI-ios-unsigned.zip --sbom=release-artifacts/ZUULI-ios.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-ios.artifact.sbom-binding.json",
        "npm run release:manifest -- --artifacts=release-artifacts --checksums=release-artifacts/CHECKSUMS.sha256 --output=release-artifacts/provenance.json",
      ],
    ],
    [
      "release android",
      jobBlock(release, "android"),
      [
        "artifacts=(release-artifacts/*.aab)",
        '[[ ${#artifacts[@]} -eq 1 && -f "${artifacts[0]}" ]] || { echo "expected exactly one Android AAB" >&2; exit 1; }',
        "artifact=${artifacts[0]}",
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="$artifact" --sbom=release-artifacts/ZUULI-android.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-android.artifact.sbom-binding.json',
        "npm run release:manifest -- --artifacts=release-artifacts --checksums=release-artifacts/CHECKSUMS.sha256 --output=release-artifacts/provenance.json",
      ],
    ],
    [
      "release ios",
      jobBlock(release, "ios-finalize"),
      [
        "artifacts=(release-artifacts/*.ipa)",
        '[[ ${#artifacts[@]} -eq 1 && -f "${artifacts[0]}" ]] || { echo "expected exactly one iOS IPA" >&2; exit 1; }',
        "artifact=${artifacts[0]}",
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="$artifact" --sbom=release-artifacts/ZUULI-ios.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-ios.artifact.sbom-binding.json',
        "node scripts/release-manifest.mjs --artifacts=release-artifacts --checksums=release-artifacts/CHECKSUMS.sha256 --output=release-artifacts/provenance.json",
      ],
    ],
    [
      "packaging macos",
      jobBlock(packaging, "desktop"),
      [
        'if [[ "${{ runner.os }}" == macOS ]]; then',
        "dmgs=(release-artifacts/*.dmg)",
        "zips=(release-artifacts/*-macos-universal-unsigned.zip)",
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${dmgs[0]}" --sbom=release-artifacts/ZUULI-macos-dmg.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-dmg.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${zips[0]}" --sbom=release-artifacts/ZUULI-macos-zip.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-zip.artifact.sbom-binding.json',
        "fi",
        'jq -e \'(.metadata.properties // [] | any(.name == "free2z:inventory-scope" and .value == "source-tree")) and ((.components // []) | length >= 50)\' release-artifacts/ZUULI-desktop.source.sbom.cdx.json',
        "npm run release:manifest -- --artifacts=release-artifacts --checksums=release-artifacts/CHECKSUMS.sha256 --output=release-artifacts/provenance.json",
      ],
    ],
    [
      "release macos artifacts",
      jobBlock(release, "macos-finalize"),
      [
        "RELEASE_IDENTITY=${{ needs.prepare.outputs.identity }}",
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="release-artifacts/ZUULI-${RELEASE_IDENTITY}-macos.dmg" --sbom=release-artifacts/ZUULI-macos-dmg.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-dmg.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="release-artifacts/ZUULI-${RELEASE_IDENTITY}-macos-universal.zip" --sbom=release-artifacts/ZUULI-macos-zip.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-macos-zip.artifact.sbom-binding.json',
        'jq -e \'(.metadata.properties // [] | any(.name == "free2z:inventory-scope" and .value == "source-tree")) and ((.components // []) | length >= 50)\' release-artifacts/ZUULI-macos.source.sbom.cdx.json',
        "node scripts/release-manifest.mjs --artifacts=release-artifacts --checksums=release-artifacts/CHECKSUMS.sha256 --output=release-artifacts/provenance.json",
      ],
    ],
  ]) {
    requireExactRunStep(
      label,
      block,
      "Record checksums and provenance",
      expectedLines,
      failures,
    );
  }
  for (const [label, block, output, manifest] of [
    [
      "packaging desktop",
      jobBlock(packaging, "desktop"),
      "ZUULI-desktop",
      "npm run release:manifest -- --artifacts=release-artifacts",
    ],
    [
      "release linux",
      jobBlock(release, "linux"),
      "ZUULI-linux",
      "npm run release:manifest -- --artifacts=release-artifacts",
    ],
    [
      "release macos",
      jobBlock(release, "macos-finalize"),
      "ZUULI-macos",
      "node scripts/release-manifest.mjs --artifacts=release-artifacts",
    ],
  ]) {
    requireOrdered(
      label,
      block,
      [
        `output-file: wallet/zuuli/artifact-sbom-work/${output}.source.raw.sbom.cdx.json`,
        `node scripts/artifact-sbom.mjs label-source --raw-sbom=artifact-sbom-work/${output}.source.raw.sbom.cdx.json --sbom=release-artifacts/${output}.source.sbom.cdx.json --source-root=wallet/zuuli`,
        'any(.name == "free2z:inventory-scope" and .value == "source-tree")',
        manifest,
      ],
      failures,
    );
  }
  return failures;
}

function optionsFor(command, args) {
  const allowed = new Set(
    command === "prepare"
      ? ["artifact", "root"]
      : command === "finalize-artifact"
        ? ["artifact", "root", "raw-sbom", "sbom", "binding"]
        : command === "verify-artifact"
          ? ["artifact", "sbom", "binding"]
          : command === "label-source"
            ? ["raw-sbom", "sbom", "source-root", "source-commit"]
            : [],
  );
  if (allowed.size === 0) throw new Error(`unknown command: ${command}`);
  const result = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || !allowed.has(match[1]) || result[match[1]] !== undefined) {
      throw new Error(`invalid ${command} option: ${arg}`);
    }
    result[match[1]] = match[2];
  }
  for (const name of allowed) {
    if (name === "source-commit" && command === "label-source") continue;
    if (result[name] === undefined) throw new Error(`missing --${name}=...`);
  }
  return result;
}

function absoluteOptions(options) {
  const result = { ...options };
  for (const name of ["artifact", "root", "raw-sbom", "sbom", "binding"]) {
    if (result[name]) result[name] = resolve(process.cwd(), result[name]);
  }
  return result;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = absoluteOptions(optionsFor(command, args));
  if (command === "prepare") {
    prepareArtifact(options);
  } else if (command === "finalize-artifact") {
    finalizeArtifactSbom({
      artifact: options.artifact,
      root: options.root,
      rawSbom: options["raw-sbom"],
      sbom: options.sbom,
      binding: options.binding,
    });
  } else if (command === "verify-artifact") {
    verifyArtifactSbom(options);
  } else if (command === "label-source") {
    const sourceCommit =
      options["source-commit"] ??
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    labelSourceSbom({
      rawSbom: options["raw-sbom"],
      sbom: options.sbom,
      sourceRoot: options["source-root"],
      sourceCommit,
    });
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
