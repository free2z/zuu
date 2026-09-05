#!/usr/bin/env node
/**
 * The GHSA-2v8p-3f2j-5mp7 pin for Mermaid and DOMPurify.
 *
 * #904 phase 4 removed the Markdown/Mermaid renderer from ZUULI, so this
 * script's subject is no longer this app — it is `wallet/free2z`, which renders
 * creator-controlled Markdown and still depends on `mermaid` and `dompurify`.
 * The guard therefore **moved rather than being deleted**: `wallet/free2z` has
 * no node-test gate of its own, and `wallet/zuuli`'s `npm test` is what the
 * protected `zuuli / frontend` job runs. That is the same reason
 * `messaging-contract.node-test.mjs` lives here and reads `wallet/e2e2z`.
 *
 * Deleting it with ZUULI's copy of the renderer would have left the repo with
 * **no** guard on the patched versions, for the one app that still parses
 * untrusted diagrams. This file reads no `wallet/free2z` source it modifies; it
 * only asserts against that app's manifest, lock and two components.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** The app that renders Mermaid. Not this one. */
const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../free2z",
);

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) throw new Error(`Mermaid must use an exact semantic version, got ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function atLeast(version, floor) {
  for (const key of ["major", "minor", "patch"]) {
    if (version[key] !== floor[key]) return version[key] > floor[key];
  }
  return version.prerelease === null;
}

/** Guard both vulnerable lines recorded by GHSA-2v8p-3f2j-5mp7. */
export function assertPatchedMermaid(versionString) {
  const version = parseVersion(versionString);
  const safe =
    version.major > 11 ||
    (version.major === 11 &&
      atLeast(version, { major: 11, minor: 16, patch: 1 })) ||
    (version.major === 10 &&
      atLeast(version, { major: 10, minor: 9, patch: 8 }));
  if (!safe) {
    throw new Error(
      `Mermaid ${versionString} re-enters GHSA-2v8p-3f2j-5mp7; require >=10.9.8 on v10 or >=11.16.1 on v11`,
    );
  }
}

export function assertPatchedDomPurify(versionString) {
  const version = parseVersion(versionString);
  if (!atLeast(version, { major: 3, minor: 4, patch: 14 })) {
    throw new Error(`DOMPurify ${versionString} is vulnerable; require >=3.4.14`);
  }
}

export function checkManifestAndLock(manifest, lock) {
  const requested = manifest.dependencies?.mermaid;
  if (typeof requested !== "string") throw new Error("Mermaid must be a direct dependency");
  assertPatchedMermaid(requested);

  const locked = Object.entries(lock.packages ?? {})
    .filter(([packagePath]) => /(^|\/)node_modules\/mermaid$/.test(packagePath))
    .map(([packagePath, value]) => ({ packagePath, version: value.version }));
  if (locked.length === 0) throw new Error("package-lock.json does not lock Mermaid");

  for (const entry of locked) {
    if (typeof entry.version !== "string") {
      throw new Error(`${entry.packagePath} has no exact Mermaid version`);
    }
    assertPatchedMermaid(entry.version);
  }

  const direct = locked.find((entry) => entry.packagePath === "node_modules/mermaid");
  if (!direct || direct.version !== requested) {
    throw new Error(
      `Mermaid manifest/lock drift: requested ${requested}, locked ${direct?.version ?? "missing"}`,
    );
  }

  const requestedSanitizer = manifest.dependencies?.dompurify;
  if (typeof requestedSanitizer !== "string") {
    throw new Error("DOMPurify must be a direct dependency at the SVG sink");
  }
  assertPatchedDomPurify(requestedSanitizer);
  const lockedSanitizers = Object.entries(lock.packages ?? {})
    .filter(([packagePath]) => /(^|\/)node_modules\/dompurify$/.test(packagePath))
    .map(([packagePath, value]) => ({ packagePath, version: value.version }));
  if (lockedSanitizers.length === 0) throw new Error("package-lock.json does not lock DOMPurify");
  for (const entry of lockedSanitizers) {
    if (typeof entry.version !== "string") {
      throw new Error(`${entry.packagePath} has no exact DOMPurify version`);
    }
    assertPatchedDomPurify(entry.version);
  }
  const directSanitizer = lockedSanitizers.find(
    (entry) => entry.packagePath === "node_modules/dompurify",
  );
  if (!directSanitizer || directSanitizer.version !== requestedSanitizer) {
    throw new Error(
      `DOMPurify manifest/lock drift: requested ${requestedSanitizer}, locked ${directSanitizer?.version ?? "missing"}`,
    );
  }
}

export async function main() {
  const [manifest, lock] = await Promise.all([
    readFile(path.join(RENDERER_ROOT, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(RENDERER_ROOT, "package-lock.json"), "utf8").then(JSON.parse),
  ]);
  checkManifestAndLock(manifest, lock);
  console.log(
    `wallet/free2z: Mermaid ${manifest.dependencies.mermaid} and DOMPurify ${manifest.dependencies.dompurify} are exact and patched`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
