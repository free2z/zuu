import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  artifactSbomWorkflowFailures,
  finalizeArtifactSbom,
  inventoryRoot,
  labelSourceSbom,
  prepareArtifact,
  sha256File,
  validateArchiveMembers,
  verifyArtifactSbom,
} from "./artifact-sbom.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDirectory, "..");
const repoRoot = resolve(appRoot, "../..");

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function minimalCycloneDx() {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp: "2026-08-23T00:00:00Z",
      properties: [{ name: "syft:source", value: "directory" }],
    },
    components: [
      {
        type: "library",
        "bom-ref": "pkg:cargo/example@1.0.0",
        name: "example",
        version: "1.0.0",
      },
    ],
  };
}

function property(properties, name) {
  return properties.find((entry) => entry.name === name)?.value;
}

function makeZipFixture(root) {
  const source = resolve(root, "source");
  const executable = resolve(source, "Payload/ZUULI.app/ZUULI");
  const canary = resolve(
    source,
    "Payload/ZUULI.app/Frameworks/libundeclared-canary.dylib",
  );
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(dirname(canary), { recursive: true });
  writeFileSync(executable, "native executable bytes\n");
  writeFileSync(canary, "undeclared native library bytes\n");
  symlinkSync(
    "../ZUULI",
    resolve(source, "Payload/ZUULI.app/Frameworks/current"),
  );
  const archive = resolve(root, "ZUULI-test.ipa");
  execFileSync("zip", ["-qry", archive, "Payload"], { cwd: source });
  return {
    archive,
    canaryPath: "Payload/ZUULI.app/Frameworks/libundeclared-canary.dylib",
  };
}

test("shipped canary is inventoried and exact artifact/SBOM bytes are bound", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-artifact-sbom-"));
  try {
    const { archive, canaryPath } = makeZipFixture(temporary);
    const root = resolve(temporary, "unpacked");
    const rawSbom = resolve(temporary, "raw.cdx.json");
    const sbom = resolve(temporary, "artifact.sbom.cdx.json");
    const binding = resolve(temporary, "artifact.sbom-binding.json");
    writeJson(rawSbom, minimalCycloneDx());

    const inventory = prepareArtifact({ artifact: archive, root });
    assert.ok(inventory.some((entry) => entry.path === canaryPath));
    finalizeArtifactSbom({ artifact: archive, root, rawSbom, sbom, binding });
    assert.doesNotThrow(() =>
      verifyArtifactSbom({ artifact: archive, root, sbom, binding }),
    );

    const document = JSON.parse(readFileSync(sbom, "utf8"));
    assert.equal(
      property(document.metadata.properties, "free2z:inventory-scope"),
      "shipped-artifact",
    );
    assert.equal(
      property(document.metadata.properties, "free2z:artifact-sha256"),
      sha256File(archive),
    );
    const canary = document.components.find(
      (component) =>
        property(component.properties ?? [], "free2z:artifact:path") ===
        canaryPath,
    );
    assert.equal(canary?.type, "file");
    assert.equal(
      canary?.hashes?.[0]?.content,
      sha256File(resolve(root, canaryPath)),
    );
    assert.equal(
      document.components.some((component) => component.name === "example"),
      true,
      "Syft-discovered packages must be preserved alongside the complete file inventory",
    );

    const mutatedSbom = resolve(temporary, "mutated.sbom.cdx.json");
    document.components = document.components.filter(
      (component) =>
        property(component.properties ?? [], "free2z:artifact:path") !==
        canaryPath,
    );
    writeJson(mutatedSbom, document);
    const mutatedBinding = resolve(temporary, "mutated.sbom-binding.json");
    const record = JSON.parse(readFileSync(binding, "utf8"));
    record.sbom = {
      path: basename(mutatedSbom),
      bytes: lstatSync(mutatedSbom).size,
      sha256: sha256File(mutatedSbom),
    };
    writeJson(mutatedBinding, record);
    assert.throws(
      () =>
        verifyArtifactSbom({
          artifact: archive,
          root,
          sbom: mutatedSbom,
          binding: mutatedBinding,
        }),
      /artifact file inventory count mismatch|omits shipped artifact entry/,
    );

    appendFileSync(archive, "post-scan artifact mutation");
    assert.throws(
      () => verifyArtifactSbom({ artifact: archive, root, sbom, binding }),
      /binding does not match exact artifact and SBOM bytes/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("source inventory is labeled without pretending to describe an artifact", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-source-sbom-"));
  try {
    const rawSbom = resolve(temporary, "raw.cdx.json");
    const sbom = resolve(temporary, "source.sbom.cdx.json");
    writeJson(rawSbom, minimalCycloneDx());
    labelSourceSbom({
      rawSbom,
      sbom,
      sourceRoot: "wallet/zuuli",
      sourceCommit: "a".repeat(40),
    });
    const document = JSON.parse(readFileSync(sbom, "utf8"));
    assert.equal(
      property(document.metadata.properties, "free2z:inventory-scope"),
      "source-tree",
    );
    assert.equal(
      property(document.metadata.properties, "free2z:source-root"),
      "wallet/zuuli",
    );
    assert.equal(
      property(document.metadata.properties, "free2z:source-commit"),
      "a".repeat(40),
    );
    assert.equal(
      property(document.metadata.properties, "free2z:artifact-sha256"),
      undefined,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("archive member validation rejects duplicate and unsafe names", () => {
  assert.throws(
    () =>
      validateArchiveMembers([
        "Payload/ZUULI.app/ZUULI",
        "Payload/ZUULI.app/ZUULI",
      ]),
    /duplicate archive member/,
  );
  for (const member of [
    "../escape",
    "/absolute",
    "line\nbreak",
    "back\\slash",
  ]) {
    assert.throws(
      () => validateArchiveMembers([member]),
      /unsafe archive member/,
    );
  }
});

test("payload inventory rejects a relative symlink that resolves outside the root", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-symlink-sbom-"));
  try {
    const root = resolve(temporary, "root");
    mkdirSync(root);
    writeFileSync(resolve(temporary, "outside"), "outside payload\n");
    symlinkSync("../outside", resolve(root, "escape"));
    assert.throws(() => inventoryRoot(root), /symlink escapes payload/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("workflow contract catches removal of a mobile artifact scan", () => {
  const packaging = readFileSync(
    resolve(repoRoot, ".github/workflows/zuuli-packaging.yml"),
    "utf8",
  );
  const release = readFileSync(
    resolve(repoRoot, ".github/workflows/zuuli-release.yml"),
    "utf8",
  );
  assert.deepEqual(artifactSbomWorkflowFailures(packaging, release), []);
  const decorated = packaging.replace(
    "node scripts/artifact-sbom.mjs finalize-artifact --artifact=release-artifacts/ZUULI-android-unsigned.aab",
    "node scripts/artifact-sbom.mjs finalize-artifact-disabled --artifact=release-artifacts/ZUULI-android-unsigned.aab",
  );
  assert.ok(
    artifactSbomWorkflowFailures(decorated, release).some((failure) =>
      failure.includes("packaging android"),
    ),
  );
  const wrongRoot = packaging.replace(
    "path: wallet/zuuli/artifact-sbom-work/ios/root",
    "path: wallet/zuuli",
  );
  assert.ok(
    artifactSbomWorkflowFailures(wrongRoot, release).some((failure) =>
      failure.includes("packaging ios"),
    ),
  );
  const skippedVerification = release.replace(
    'node scripts/artifact-sbom.mjs verify-artifact --artifact="$artifact" --root=artifact-sbom-work/android/root',
    'node scripts/artifact-sbom.mjs verify-artifact-disabled --artifact="$artifact" --root=artifact-sbom-work/android/root',
  );
  assert.ok(
    artifactSbomWorkflowFailures(packaging, skippedVerification).some(
      (failure) => failure.includes("release android"),
    ),
  );
});
