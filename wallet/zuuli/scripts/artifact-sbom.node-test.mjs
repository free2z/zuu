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
      verifyArtifactSbom({ artifact: archive, sbom, binding }),
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
    rmSync(root, { recursive: true, force: true });
    assert.doesNotThrow(
      () => verifyArtifactSbom({ artifact: archive, sbom, binding }),
      "verification must remain independent after the mutable scan root is removed",
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
          sbom: mutatedSbom,
          binding: mutatedBinding,
        }),
      /artifact file inventory count mismatch|omits shipped artifact entry/,
    );

    appendFileSync(archive, "post-scan artifact mutation");
    assert.throws(
      () => verifyArtifactSbom({ artifact: archive, sbom, binding }),
      /binding does not match exact artifact and SBOM bytes/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("verification re-extracts the artifact instead of trusting a mutated scan root", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-artifact-fresh-"));
  try {
    const { archive } = makeZipFixture(temporary);
    const root = resolve(temporary, "unpacked");
    const injectedPath = resolve(
      root,
      "Payload/ZUULI.app/Frameworks/post-prepare-injection.dylib",
    );
    const rawSbom = resolve(temporary, "raw.cdx.json");
    const sbom = resolve(temporary, "artifact.sbom.cdx.json");
    const binding = resolve(temporary, "artifact.sbom-binding.json");
    writeJson(rawSbom, minimalCycloneDx());

    prepareArtifact({ artifact: archive, root });
    writeFileSync(injectedPath, "not present in the shipped IPA\n");
    finalizeArtifactSbom({ artifact: archive, root, rawSbom, sbom, binding });

    const document = JSON.parse(readFileSync(sbom, "utf8"));
    assert.ok(
      document.components.some(
        (component) =>
          property(component.properties ?? [], "free2z:artifact:path") ===
          "Payload/ZUULI.app/Frameworks/post-prepare-injection.dylib",
      ),
      "the finalizer must consume the mutated Syft scan root for this canary",
    );
    assert.throws(
      () => verifyArtifactSbom({ artifact: archive, sbom, binding }),
      /artifact file inventory count mismatch|omits shipped artifact entry/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test(
  "macOS DMG inventory is copied without following its Applications link",
  { skip: process.platform !== "darwin" },
  () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-artifact-dmg-"));
    try {
      const source = resolve(temporary, "source");
      const executable = resolve(source, "ZUULI.app/Contents/MacOS/ZUULI");
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, "signed macOS executable fixture\n");
      symlinkSync("/Applications", resolve(source, "Applications"));
      const artifact = resolve(temporary, "ZUULI-test.dmg");
      execFileSync(
        "hdiutil",
        [
          "create",
          "-quiet",
          "-ov",
          "-format",
          "UDZO",
          "-volname",
          "ZUULI test",
          "-srcfolder",
          source,
          artifact,
        ],
        { timeout: 120_000 },
      );
      const root = resolve(temporary, "unpacked");
      const rawSbom = resolve(temporary, "raw.cdx.json");
      const sbom = resolve(temporary, "artifact.sbom.cdx.json");
      const binding = resolve(temporary, "artifact.sbom-binding.json");
      writeJson(rawSbom, minimalCycloneDx());

      const inventory = prepareArtifact({ artifact, root });
      assert.ok(
        inventory.some(
          (entry) =>
            entry.path === "Applications" &&
            entry.kind === "symlink" &&
            entry.target === "/Applications",
        ),
      );
      assert.ok(
        inventory.some(
          (entry) => entry.path === "ZUULI.app/Contents/MacOS/ZUULI",
        ),
      );
      finalizeArtifactSbom({ artifact, root, rawSbom, sbom, binding });
      assert.doesNotThrow(() =>
        verifyArtifactSbom({ artifact, sbom, binding }),
      );

      writeFileSync(
        resolve(root, "ZUULI.app/Contents/MacOS/not-shipped.dylib"),
        "scan-root injection\n",
      );
      const poisonedSbom = resolve(temporary, "poisoned.sbom.cdx.json");
      const poisonedBinding = resolve(temporary, "poisoned.binding.json");
      finalizeArtifactSbom({
        artifact,
        root,
        rawSbom,
        sbom: poisonedSbom,
        binding: poisonedBinding,
      });
      assert.throws(
        () =>
          verifyArtifactSbom({
            artifact,
            sbom: poisonedSbom,
            binding: poisonedBinding,
          }),
        /artifact file inventory count mismatch|omits shipped artifact entry/,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

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
      validateArchiveMembers(
        Array.from({ length: 100_001 }, (_, index) => `entry-${index}`),
      ),
    /archive has too many entries/,
  );
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

test("workflow contract catches removal or weakening of artifact scans", () => {
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
    'node scripts/artifact-sbom.mjs verify-artifact --artifact="$artifact" --sbom=release-artifacts/ZUULI-android.artifact.sbom.cdx.json',
    'node scripts/artifact-sbom.mjs verify-artifact-disabled --artifact="$artifact" --sbom=release-artifacts/ZUULI-android.artifact.sbom.cdx.json',
  );
  assert.ok(
    artifactSbomWorkflowFailures(packaging, skippedVerification).some(
      (failure) => failure.includes("release android"),
    ),
  );
  const sameRootVerification = packaging.replace(
    "node scripts/artifact-sbom.mjs verify-artifact --artifact=release-artifacts/ZUULI-ios-unsigned.zip --sbom=release-artifacts/ZUULI-ios.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-ios.artifact.sbom-binding.json",
    "# node scripts/artifact-sbom.mjs verify-artifact --artifact=release-artifacts/ZUULI-ios-unsigned.zip --sbom=release-artifacts/ZUULI-ios.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-ios.artifact.sbom-binding.json\n          node scripts/artifact-sbom.mjs verify-artifact --artifact=release-artifacts/ZUULI-ios-unsigned.zip --root=artifact-sbom-work/ios/root --sbom=release-artifacts/ZUULI-ios.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-ios.artifact.sbom-binding.json",
  );
  assert.ok(
    artifactSbomWorkflowFailures(sameRootVerification, release).some(
      (failure) => failure.includes("packaging ios"),
    ),
    "the policy must reject replacing fresh artifact verification with the mutable Syft root",
  );
  const skippedMacDmg = packaging.replace(
    'node scripts/artifact-sbom.mjs prepare --artifact="${dmgs[0]}" --root=artifact-sbom-work/macos-dmg/root',
    'node scripts/artifact-sbom.mjs prepare-disabled --artifact="${dmgs[0]}" --root=artifact-sbom-work/macos-dmg/root',
  );
  assert.ok(
    artifactSbomWorkflowFailures(skippedMacDmg, release).some((failure) =>
      failure.includes("packaging macos"),
    ),
  );
  const mutableMacRoot = release.replace(
    'node scripts/artifact-sbom.mjs verify-artifact --artifact="release-artifacts/ZUULI-${RELEASE_IDENTITY}-macos-universal.zip" --sbom=release-artifacts/ZUULI-macos-zip.artifact.sbom.cdx.json',
    'node scripts/artifact-sbom.mjs verify-artifact --artifact="release-artifacts/ZUULI-${RELEASE_IDENTITY}-macos-universal.zip" --root=artifact-sbom-work/macos-zip/root --sbom=release-artifacts/ZUULI-macos-zip.artifact.sbom.cdx.json',
  );
  assert.ok(
    artifactSbomWorkflowFailures(packaging, mutableMacRoot).some((failure) =>
      failure.includes("release macos artifacts"),
    ),
    "the policy must reject reusing the mutable macOS Syft root for release verification",
  );
});
