import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
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
import { deflateSync, inflateSync } from "node:zlib";

import {
  appImagePayloadOffset,
  artifactSbomWorkflowFailures,
  extractTarArchive,
  extractDmg,
  finalizeArtifactSbom,
  inventoryRoot,
  labelSourceSbom,
  prepareArtifact,
  sha256File,
  validateArchiveMembers,
  validateLogicalEntries,
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
        properties: [
          {
            name: "syft:package:foundBy",
            value: "elf-binary-package-cataloger",
          },
          {
            name: "syft:cpe23",
            value: "cpe:2.3:a:example:first:*:*:*:*:*:*:*:*",
          },
          {
            name: "syft:cpe23",
            value: "cpe:2.3:a:example:second:*:*:*:*:*:*:*:*",
          },
        ],
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

const linuxFixtureTools = [
  "cc",
  "dpkg-deb",
  "mksquashfs",
  "objcopy",
  "readelf",
  "rpm2archive",
  "rpmbuild",
  "unsquashfs",
];

function commandExists(command) {
  return (process.env.PATH ?? "")
    .split(":")
    .some((directory) => existsSync(resolve(directory, command)));
}

const canBuildLinuxFixtures =
  process.platform === "linux" && linuxFixtureTools.every(commandExists);

function writeCanaryPayload(root, executableSource) {
  const canary = resolve(root, "usr/lib/zuuli/libundeclared-canary.so");
  const executable = resolve(root, "usr/bin/zuuli");
  mkdirSync(dirname(canary), { recursive: true });
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(canary, "undeclared native Linux library bytes\n");
  if (executableSource) {
    copyFileSync(executableSource, executable);
    chmodSync(executable, 0o755);
  } else {
    writeFileSync(executable, "native Linux executable bytes\n");
  }
  symlinkSync("../../bin/zuuli", resolve(root, "usr/lib/zuuli/current"));
}

function makeAppImageFixture(root, { invalidUtf8Name = false } = {}) {
  const suffix = invalidUtf8Name ? "-invalid-utf8" : "";
  const source = resolve(root, `appimage-root${suffix}`);
  writeCanaryPayload(source);
  if (invalidUtf8Name) {
    writeFileSync(
      Buffer.concat([
        Buffer.from(`${source}/usr/lib/zuuli/invalid-`),
        Buffer.from([0xff]),
      ]),
      "invalid path bytes\n",
    );
  }
  const squashfs = resolve(root, `payload${suffix}.squashfs`);
  execFileSync(
    "mksquashfs",
    [source, squashfs, "-noappend", "-quiet", "-all-root"],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const cSource = resolve(root, `runtime${suffix}.c`);
  const runtime = resolve(root, `runtime${suffix}`);
  // AppImage runtimes commonly have a large .bss SHT_NOBITS section. Its
  // in-memory extent can overlap the appended SquashFS bytes even though it
  // contributes no bytes to the ELF file.
  writeFileSync(
    cSource,
    "static volatile char memory_only[1024 * 1024];\nint main(void) { return memory_only[0]; }\n",
  );
  execFileSync("cc", ["-s", "-o", runtime, cSource]);
  const runtimeBytes = readFileSync(runtime);
  runtimeBytes[8] = 0x41;
  runtimeBytes[9] = 0x49;
  runtimeBytes[10] = 0x02;
  const artifact = resolve(root, `ZUULI-test${suffix}.AppImage`);
  writeFileSync(
    artifact,
    Buffer.concat([runtimeBytes, readFileSync(squashfs)]),
  );
  return artifact;
}

function makeDebFixture(
  root,
  { escapingSymlink = false, executableSource } = {},
) {
  const source = resolve(root, "deb-root");
  writeCanaryPayload(source, executableSource);
  if (escapingSymlink) {
    const link = resolve(source, "usr/lib/zuuli/current");
    rmSync(link);
    symlinkSync("../../../../outside-payload", link);
  }
  const control = resolve(source, "DEBIAN/control");
  mkdirSync(dirname(control), { recursive: true });
  writeFileSync(
    control,
    "Package: zuuli-fixture\nVersion: 1.0.0\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: artifact SBOM fixture\n",
  );
  const artifact = resolve(root, "ZUULI-test.deb");
  execFileSync(
    "dpkg-deb",
    ["--build", "--root-owner-group", source, artifact],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  return artifact;
}

function makeRpmFixture(root) {
  const top = resolve(root, "rpm-top");
  for (const directory of [
    "BUILD",
    "BUILDROOT",
    "RPMS",
    "SOURCES",
    "SPECS",
    "SRPMS",
  ]) {
    mkdirSync(resolve(top, directory), { recursive: true });
  }
  const spec = resolve(top, "SPECS/zuuli-fixture.spec");
  writeFileSync(
    spec,
    [
      "Name: zuuli-fixture",
      "Version: 1.0.0",
      "Release: 1",
      "Summary: artifact SBOM fixture",
      "License: MIT",
      "BuildArch: noarch",
      "%description",
      "artifact SBOM fixture",
      "%install",
      "mkdir -p %{buildroot}/usr/bin %{buildroot}/usr/lib/zuuli",
      "printf 'native Linux executable bytes\\n' > %{buildroot}/usr/bin/zuuli",
      "printf 'undeclared native Linux library bytes\\n' > %{buildroot}/usr/lib/zuuli/libundeclared-canary.so",
      "ln -s ../../bin/zuuli %{buildroot}/usr/lib/zuuli/current",
      "%files",
      "/usr/bin/zuuli",
      "/usr/lib/zuuli/current",
      "/usr/lib/zuuli/libundeclared-canary.so",
      "",
    ].join("\n"),
  );
  execFileSync("rpmbuild", ["--define", `_topdir ${top}`, "-bb", spec], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const artifact = resolve(root, "ZUULI-test.rpm");
  copyFileSync(
    resolve(top, "RPMS/noarch/zuuli-fixture-1.0.0-1.noarch.rpm"),
    artifact,
  );
  return artifact;
}

function writeTarField(header, offset, length, value) {
  Buffer.from(value).copy(header, offset, 0, length);
}

function tarHeader({ name, type = "0", data = Buffer.alloc(0), target = "" }) {
  const header = Buffer.alloc(512);
  writeTarField(header, 0, 100, name);
  writeTarField(header, 100, 8, "0000644\0");
  writeTarField(header, 108, 8, "0000000\0");
  writeTarField(header, 116, 8, "0000000\0");
  writeTarField(
    header,
    124,
    12,
    `${data.length.toString(8).padStart(11, "0")}\0`,
  );
  writeTarField(header, 136, 12, "00000000000\0");
  header.fill(0x20, 148, 156);
  writeTarField(header, 156, 1, type);
  writeTarField(header, 157, 100, target);
  writeTarField(header, 257, 6, "ustar\0");
  writeTarField(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function writeTarFixture(path, entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    chunks.push(tarHeader({ ...entry, data }), data);
    const remainder = data.length % 512;
    if (remainder > 0) chunks.push(Buffer.alloc(512 - remainder));
  }
  chunks.push(Buffer.alloc(1024));
  writeFileSync(path, Buffer.concat(chunks));
}

function paxRecord(key, value) {
  const body = Buffer.concat([
    Buffer.from(`${key}=`),
    Buffer.from(value),
    Buffer.from("\n"),
  ]);
  let length = body.length + 2;
  for (;;) {
    const next = Buffer.byteLength(`${length} `) + body.length;
    if (next === length) break;
    length = next;
  }
  return Buffer.concat([Buffer.from(`${length} `), body]);
}

function assertRealLinuxArtifactBoundary(temporary, label, artifact) {
  const root = resolve(temporary, `${label}-unpacked`);
  const rawSbom = resolve(temporary, `${label}.raw.cdx.json`);
  const sbom = resolve(temporary, `${label}.artifact.sbom.cdx.json`);
  const binding = resolve(temporary, `${label}.artifact.sbom-binding.json`);
  writeJson(rawSbom, minimalCycloneDx());
  const inventory = prepareArtifact({ artifact, root });
  const canaryPath = "usr/lib/zuuli/libundeclared-canary.so";
  assert.ok(inventory.some((entry) => entry.path === canaryPath));
  const metadataPath = resolve(root, ".free2z-package-metadata.json");
  if (label === "deb" || label === "rpm") {
    assert.equal(
      inventory.some((entry) => entry.path === ".free2z-package-metadata.json"),
      false,
      "scan metadata is not a shipped payload entry",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.format, label);
    assert.equal(
      label === "deb" ? metadata.fields.Package : metadata.fields.name,
      "zuuli-fixture",
    );
    assert.equal(
      label === "deb" ? metadata.fields.Version : metadata.fields.version,
      "1.0.0",
    );
    const exactMetadata = readFileSync(metadataPath);
    const tampered = structuredClone(metadata);
    if (label === "deb") tampered.fields.Version = "9.9.9";
    else tampered.fields.version = "9.9.9";
    writeJson(metadataPath, tampered);
    assert.throws(
      () =>
        finalizeArtifactSbom({
          artifact,
          root,
          rawSbom,
          sbom,
          binding,
        }),
      /sidecar does not match the exact artifact/,
    );
    writeFileSync(metadataPath, exactMetadata);
  } else {
    assert.equal(existsSync(metadataPath), false);
  }
  finalizeArtifactSbom({ artifact, root, rawSbom, sbom, binding });
  assert.doesNotThrow(() => verifyArtifactSbom({ artifact, sbom, binding }));

  const document = JSON.parse(readFileSync(sbom, "utf8"));
  if (label === "deb" || label === "rpm") {
    const packages = document.components.filter(
      (component) =>
        property(
          component.properties ?? [],
          "free2z:artifact-package:format",
        ) === label,
    );
    assert.equal(packages.length, 1);
    assert.equal(packages[0].name, "zuuli-fixture");
    assert.equal(packages[0].version, "1.0.0");
  }
  document.components = document.components.filter(
    (component) =>
      property(component.properties ?? [], "free2z:artifact:path") !==
      canaryPath,
  );
  const omitted = resolve(temporary, `${label}.omitted.sbom.cdx.json`);
  writeJson(omitted, document);
  const omittedBinding = resolve(
    temporary,
    `${label}.omitted.sbom-binding.json`,
  );
  const record = JSON.parse(readFileSync(binding, "utf8"));
  record.sbom = {
    path: basename(omitted),
    bytes: lstatSync(omitted).size,
    sha256: sha256File(omitted),
  };
  writeJson(omittedBinding, record);
  assert.throws(
    () =>
      verifyArtifactSbom({ artifact, sbom: omitted, binding: omittedBinding }),
    /inventory count mismatch|omits shipped artifact entry/,
  );
  if (label === "deb" || label === "rpm") {
    document.components = document.components.filter(
      (component) =>
        property(
          component.properties ?? [],
          "free2z:artifact-package:format",
        ) !== label,
    );
    const missingMetadata = resolve(
      temporary,
      `${label}.missing-metadata.sbom.cdx.json`,
    );
    writeJson(missingMetadata, document);
    const missingMetadataBinding = resolve(
      temporary,
      `${label}.missing-metadata.sbom-binding.json`,
    );
    record.sbom = {
      path: basename(missingMetadata),
      bytes: lstatSync(missingMetadata).size,
      sha256: sha256File(missingMetadata),
    };
    writeJson(missingMetadataBinding, record);
    assert.throws(
      () =>
        verifyArtifactSbom({
          artifact,
          sbom: missingMetadata,
          binding: missingMetadataBinding,
        }),
      /package metadata does not match/,
    );
  }
}

test(
  "real AppImage, deb, and rpm fixtures expose undeclared shipped canaries",
  { skip: !canBuildLinuxFixtures, timeout: 120_000 },
  () => {
    const temporary = mkdtempSync(
      resolve(tmpdir(), "zuuli-linux-artifact-sbom-"),
    );
    try {
      assertRealLinuxArtifactBoundary(
        temporary,
        "appimage",
        makeAppImageFixture(temporary),
      );
      assertRealLinuxArtifactBoundary(
        temporary,
        "deb",
        makeDebFixture(temporary),
      );
      assertRealLinuxArtifactBoundary(
        temporary,
        "rpm",
        makeRpmFixture(temporary),
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

const cargoRuntimeFixtureTools = [
  "cargo",
  "cargo-auditable",
  "dpkg-deb",
  "objcopy",
  "rustc",
];
const canBuildCargoRuntimeFixture =
  process.platform === "linux" && cargoRuntimeFixtureTools.every(commandExists);

function cargoRuntimeOptions(project, target) {
  return {
    cargoLock: resolve(project, "Cargo.lock"),
    cargoManifest: resolve(project, "Cargo.toml"),
    cargoTarget: target,
    cargoFeatures: "default",
  };
}

function mutateAuditableBinary(source, destination, temporary, mutate) {
  const section = resolve(temporary, `${basename(destination)}.dep-v0`);
  const replacement = resolve(
    temporary,
    `${basename(destination)}.replacement.dep-v0`,
  );
  execFileSync("objcopy", ["--dump-section", `.dep-v0=${section}`, source]);
  const document = JSON.parse(
    inflateSync(readFileSync(section)).toString("utf8"),
  );
  mutate(document);
  writeFileSync(
    replacement,
    deflateSync(Buffer.from(JSON.stringify(document))),
  );
  execFileSync("objcopy", [
    "--update-section",
    `.dep-v0=${replacement}`,
    source,
    destination,
  ]);
  chmodSync(destination, 0o755);
}

function cargoRuntimeArtifact(temporary, name, executable) {
  const packageRoot = resolve(temporary, name);
  mkdirSync(packageRoot);
  return makeDebFixture(packageRoot, { executableSource: executable });
}

function finalizeCargoRuntimeFixture(temporary, name, artifact, options) {
  const work = resolve(temporary, `${name}-work`);
  const root = resolve(work, "root");
  const rawSbom = resolve(work, "raw.cdx.json");
  const sbom = resolve(work, "artifact.sbom.cdx.json");
  const binding = resolve(work, "artifact.sbom-binding.json");
  mkdirSync(work);
  writeJson(rawSbom, minimalCycloneDx());
  prepareArtifact({ artifact, root });
  finalizeArtifactSbom({
    artifact,
    root,
    rawSbom,
    sbom,
    binding,
    ...options,
  });
  return { root, sbom, binding };
}

function fixtureSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureFileSha256(path) {
  return fixtureSha256(readFileSync(path));
}

function exactProperties(entries) {
  const result = Object.fromEntries(
    (entries ?? []).map(({ name, value }) => [name, value]),
  );
  assert.equal(
    Object.keys(result).length,
    (entries ?? []).length,
    "fixture properties must not hide duplicate names",
  );
  return result;
}

function extractFixtureEvidence(executable, temporary) {
  const section = resolve(temporary, "independent.dep-v0.zlib");
  execFileSync("objcopy", ["--dump-section", `.dep-v0=${section}`, executable]);
  const compressed = readFileSync(section);
  const json = inflateSync(compressed);
  return {
    compressedBytes: compressed.length,
    compressedSha256: fixtureSha256(compressed),
    jsonSha256: fixtureSha256(json),
    document: JSON.parse(json.toString("utf8")),
  };
}

function runArtifactSbomCli(args) {
  return execFileSync(
    process.execPath,
    [resolve(scriptDirectory, "artifact-sbom.mjs"), ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function artifactSbomCliFailure(args) {
  try {
    runArtifactSbomCli(args);
  } catch (error) {
    return error.stderr?.toString() ?? error.message;
  }
  assert.fail("artifact-sbom CLI unexpectedly succeeded");
}

test(
  "real cargo-auditable executable evidence is complete, lock-bound, and mandatory",
  { skip: !canBuildCargoRuntimeFixture, timeout: 120_000 },
  () => {
    const temporary = mkdtempSync(
      resolve(tmpdir(), "zuuli-linux-cargo-runtime-"),
    );
    try {
      const project = resolve(temporary, "app");
      const linked = resolve(project, "linked");
      const featured = resolve(project, "featured");
      const linuxOnly = resolve(project, "linux-only");
      const wrongTarget = resolve(project, "wrong-target");
      const localMacro = resolve(project, "local-macro");
      const macroHelper = resolve(project, "macro-helper");
      mkdirSync(resolve(project, "src"), { recursive: true });
      for (const crate of [
        linked,
        featured,
        linuxOnly,
        wrongTarget,
        localMacro,
        macroHelper,
      ]) {
        mkdirSync(resolve(crate, "src"), { recursive: true });
      }
      writeFileSync(
        resolve(project, "Cargo.toml"),
        [
          '[package]\nname="zuuli"\nversion="0.1.0"\nedition="2021"',
          '[features]\ndefault=["ship"]\nship=["dep:featured"]',
          '[dependencies]\nitoa="=1.0.15"\nlinked={path="linked",features=["spark"]}\nfeatured={path="featured",optional=true}\nlocal-macro={path="local-macro"}',
          '[target.\'cfg(target_os = "linux")\'.dependencies]\nlinux-only={path="linux-only"}',
          '[target.\'cfg(target_os = "windows")\'.dependencies]\nwrong-target={path="wrong-target"}',
          "",
        ].join("\n"),
      );
      writeFileSync(
        resolve(project, "src/main.rs"),
        [
          "#[local_macro::marker]",
          "fn marked() {}",
          "fn main() {",
          "    marked();",
          '    println!("{} {} {}", linked::answer(), featured::answer(), itoa::Buffer::new().format(42));',
          '    #[cfg(target_os = "linux")] println!("{}", linux_only::answer());',
          '    #[cfg(target_os = "windows")] println!("{}", wrong_target::answer());',
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        resolve(linked, "Cargo.toml"),
        '[package]\nname="linked"\nversion="1.2.3"\nedition="2021"\n[features]\ndefault=[]\nspark=[]\n',
      );
      writeFileSync(
        resolve(linked, "src/lib.rs"),
        "pub fn answer() -> u8 { 42 }\n",
      );
      for (const [crate, name, version, answer] of [
        [featured, "featured", "2.0.0", 2],
        [linuxOnly, "linux-only", "3.0.0", 3],
        [wrongTarget, "wrong-target", "4.0.0", 4],
      ]) {
        writeFileSync(
          resolve(crate, "Cargo.toml"),
          `[package]\nname="${name}"\nversion="${version}"\nedition="2021"\n`,
        );
        writeFileSync(
          resolve(crate, "src/lib.rs"),
          `pub fn answer() -> u8 { ${answer} }\n`,
        );
      }
      writeFileSync(
        resolve(macroHelper, "Cargo.toml"),
        '[package]\nname="macro-helper"\nversion="6.0.0"\nedition="2021"\n',
      );
      writeFileSync(
        resolve(macroHelper, "src/lib.rs"),
        "pub fn identity(value: String) -> String { value }\n",
      );
      writeFileSync(
        resolve(localMacro, "Cargo.toml"),
        '[package]\nname="local-macro"\nversion="5.0.0"\nedition="2021"\n[lib]\nproc-macro=true\n[dependencies]\nmacro-helper={path="../macro-helper"}\n',
      );
      writeFileSync(
        resolve(localMacro, "src/lib.rs"),
        [
          "extern crate proc_macro;",
          "use proc_macro::TokenStream;",
          "#[proc_macro_attribute]",
          "pub fn marker(_attribute: TokenStream, item: TokenStream) -> TokenStream {",
          "    macro_helper::identity(item.to_string()).parse().unwrap()",
          "}",
          "",
        ].join("\n"),
      );
      execFileSync("cargo", ["generate-lockfile", "--offline"], {
        cwd: project,
      });
      execFileSync(
        resolve(scriptDirectory, "run-with-cargo-auditable.sh"),
        ["cargo", "build", "--release", "--locked", "--offline"],
        {
          cwd: project,
          env: {
            ...process.env,
            CARGO_TARGET_DIR: resolve(project, "target"),
          },
        },
      );
      const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
        /^host: (.+)$/m,
      )?.[1];
      assert.equal(host, "x86_64-unknown-linux-gnu");
      const options = cargoRuntimeOptions(project, host);
      const audited = resolve(project, "target/release/zuuli");
      const expectedRuntimePackages = [
        { name: "featured", version: "2.0.0", source: "local", features: [] },
        {
          name: "itoa",
          version: "1.0.15",
          source: "crates.io",
          features: [],
        },
        {
          name: "linked",
          version: "1.2.3",
          source: "local",
          features: ["default", "spark"],
        },
        {
          name: "linux-only",
          version: "3.0.0",
          source: "local",
          features: [],
        },
        {
          name: "zuuli",
          version: "0.1.0",
          source: "local",
          features: ["default", "ship"],
        },
      ].sort((left, right) =>
        `${left.name}\0${left.version}\0${left.source}`.localeCompare(
          `${right.name}\0${right.version}\0${right.source}`,
        ),
      );
      const expectedGraph = {
        target: host,
        features: ["default"],
        packages: expectedRuntimePackages,
      };
      const independentEvidence = extractFixtureEvidence(audited, temporary);
      assert.deepEqual(
        independentEvidence.document.packages
          .filter((entry) => entry.kind === "build")
          .map((entry) => entry.name)
          .sort(),
        ["local-macro", "macro-helper"],
        "the fixture must exercise a local/path proc-macro and its build-only subtree",
      );
      const artifact = cargoRuntimeArtifact(temporary, "good-package", audited);
      const finalized = finalizeCargoRuntimeFixture(
        temporary,
        "good",
        artifact,
        options,
      );
      const finalizedBinding = JSON.parse(
        readFileSync(finalized.binding, "utf8"),
      );
      assert.deepEqual(finalizedBinding.cargoRuntime, {
        target: host,
        features: ["default"],
        cargoLock: {
          path: "Cargo.lock",
          bytes: lstatSync(options.cargoLock).size,
          sha256: fixtureFileSha256(options.cargoLock),
        },
        executable: {
          path: "usr/bin/zuuli",
          bytes: lstatSync(audited).size,
          sha256: fixtureFileSha256(audited),
        },
        evidence: {
          format: 1,
          compressedBytes: independentEvidence.compressedBytes,
          compressedSha256: independentEvidence.compressedSha256,
          jsonSha256: independentEvidence.jsonSha256,
          runtimePackages: expectedRuntimePackages.length,
          graphSha256: fixtureSha256(
            Buffer.from(`${JSON.stringify(expectedGraph)}\n`),
          ),
        },
      });
      const finalizedSbom = JSON.parse(readFileSync(finalized.sbom, "utf8"));
      const runtimeComponents = (finalizedSbom.components ?? []).filter(
        (component) =>
          (component.properties ?? []).some(
            ({ name, value }) =>
              name === "free2z:cargo-runtime:package" && value === "true",
          ),
      );
      assert.deepEqual(
        runtimeComponents.map((component) => component.name),
        expectedRuntimePackages.map((entry) => entry.name),
      );
      for (const expected of expectedRuntimePackages) {
        const component = runtimeComponents.find(
          (candidate) => candidate.name === expected.name,
        );
        assert.ok(
          component,
          `missing exact ${expected.name} runtime component`,
        );
        assert.equal(
          component.type,
          expected.name === "zuuli" ? "application" : "library",
        );
        assert.equal(component.version, expected.version);
        assert.equal(
          component["bom-ref"],
          `cargo-runtime:${fixtureSha256(
            Buffer.from(
              `${expected.name}\0${expected.version}\0${expected.source}`,
            ),
          )}`,
        );
        if (expected.source === "crates.io") {
          assert.equal(
            component.purl,
            `pkg:cargo/${expected.name}@${expected.version}`,
          );
        } else {
          assert.equal(
            Object.hasOwn(component, "purl"),
            false,
            "local/path Cargo packages must not claim a registry purl",
          );
        }
        assert.deepEqual(exactProperties(component.properties), {
          "free2z:cargo-runtime:package": "true",
          "free2z:cargo-runtime:package-features": JSON.stringify(
            expected.features,
          ),
          "free2z:cargo-runtime:source": expected.source,
        });
      }
      const runtimeMetadata = exactProperties(
        finalizedSbom.metadata?.properties,
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(runtimeMetadata).filter(([name]) =>
            name.startsWith("free2z:cargo-runtime:"),
          ),
        ),
        {
          "free2z:cargo-runtime:cargo-lock-sha256": fixtureFileSha256(
            options.cargoLock,
          ),
          "free2z:cargo-runtime:evidence-sha256":
            independentEvidence.compressedSha256,
          "free2z:cargo-runtime:executable": "usr/bin/zuuli",
          "free2z:cargo-runtime:executable-sha256": fixtureFileSha256(audited),
          "free2z:cargo-runtime:features": '["default"]',
          "free2z:cargo-runtime:graph-sha256": fixtureSha256(
            Buffer.from(`${JSON.stringify(expectedGraph)}\n`),
          ),
          "free2z:cargo-runtime:scope": "linked-linux-executable",
          "free2z:cargo-runtime:target": host,
        },
      );
      rmSync(finalized.root, { recursive: true, force: true });
      assert.doesNotThrow(() =>
        verifyArtifactSbom({
          artifact,
          sbom: finalized.sbom,
          binding: finalized.binding,
          ...options,
        }),
      );

      const assertSbomRejected = (name, mutate, expected) => {
        const sbomPath = resolve(temporary, `${name}.sbom.cdx.json`);
        const bindingPath = resolve(temporary, `${name}.binding.json`);
        const document = structuredClone(finalizedSbom);
        mutate(document);
        writeJson(sbomPath, document);
        const record = structuredClone(finalizedBinding);
        record.sbom = {
          path: basename(sbomPath),
          bytes: lstatSync(sbomPath).size,
          sha256: fixtureFileSha256(sbomPath),
        };
        writeJson(bindingPath, record);
        assert.throws(
          () =>
            verifyArtifactSbom({
              artifact,
              sbom: sbomPath,
              binding: bindingPath,
              ...options,
            }),
          expected,
        );
      };
      const runtimeComponent = (document, name) =>
        document.components.find(
          (component) =>
            component.name === name &&
            (component.properties ?? []).some(
              (entry) =>
                entry.name === "free2z:cargo-runtime:package" &&
                entry.value === "true",
            ),
        );
      const runtimeProperty = (entries, name) =>
        entries.find((entry) => entry.name === name);
      assertSbomRejected(
        "missing-zuuli-component",
        (document) => {
          const component = runtimeComponent(document, "zuuli");
          document.components.splice(document.components.indexOf(component), 1);
        },
        /SBOM Cargo runtime components/,
      );
      assertSbomRejected(
        "missing-linked-component",
        (document) => {
          const component = runtimeComponent(document, "linked");
          document.components.splice(document.components.indexOf(component), 1);
        },
        /SBOM Cargo runtime components/,
      );
      assertSbomRejected(
        "invented-linked-purl",
        (document) => {
          runtimeComponent(document, "linked").purl = "pkg:cargo/linked@1.2.3";
        },
        /SBOM Cargo runtime components/,
      );
      assertSbomRejected(
        "missing-itoa-purl",
        (document) => {
          delete runtimeComponent(document, "itoa").purl;
        },
        /SBOM Cargo runtime components/,
      );
      assertSbomRejected(
        "wrong-itoa-purl",
        (document) => {
          runtimeComponent(document, "itoa").purl = "pkg:cargo/itoa@9.9.9";
        },
        /SBOM Cargo runtime components/,
      );
      assertSbomRejected(
        "wrong-itoa-source",
        (document) => {
          runtimeProperty(
            runtimeComponent(document, "itoa").properties,
            "free2z:cargo-runtime:source",
          ).value = "local";
        },
        /SBOM Cargo runtime components/,
      );
      assertSbomRejected(
        "wrong-linked-source",
        (document) => {
          runtimeProperty(
            runtimeComponent(document, "linked").properties,
            "free2z:cargo-runtime:source",
          ).value = "crates.io";
        },
        /SBOM Cargo runtime components/,
      );
      assertSbomRejected(
        "wrong-linked-features",
        (document) => {
          runtimeProperty(
            runtimeComponent(document, "linked").properties,
            "free2z:cargo-runtime:package-features",
          ).value = "[]";
        },
        /SBOM Cargo runtime components/,
      );
      for (const [name, propertyName, replacement] of [
        [
          "wrong-runtime-target",
          "free2z:cargo-runtime:target",
          "x86_64-pc-windows-gnu",
        ],
        ["wrong-runtime-features", "free2z:cargo-runtime:features", "[]"],
        [
          "wrong-graph-digest",
          "free2z:cargo-runtime:graph-sha256",
          "0".repeat(64),
        ],
        [
          "wrong-evidence-digest",
          "free2z:cargo-runtime:evidence-sha256",
          "0".repeat(64),
        ],
      ]) {
        assertSbomRejected(
          name,
          (document) => {
            runtimeProperty(document.metadata.properties, propertyName).value =
              replacement;
          },
          new RegExp(`SBOM metadata ${propertyName}`),
        );
      }

      const assertBinaryRejected = (name, binary, expected) => {
        const mutatedArtifact = cargoRuntimeArtifact(
          temporary,
          `${name}-package`,
          binary,
        );
        assert.throws(
          () =>
            finalizeCargoRuntimeFixture(
              temporary,
              name,
              mutatedArtifact,
              options,
            ),
          expected,
        );
      };

      {
        execFileSync("cargo", ["build", "--release", "--locked", "--offline"], {
          cwd: project,
          env: {
            ...process.env,
            CARGO_TARGET_DIR: resolve(project, "plain-target"),
          },
        });
        assertBinaryRejected(
          "build-without-instrumentation",
          resolve(project, "plain-target/release/zuuli"),
          /missing embedded Cargo audit evidence/,
        );
      }

      const stripped = resolve(temporary, "missing-evidence-zuuli");
      execFileSync("objcopy", [
        "--remove-section",
        ".dep-v0",
        audited,
        stripped,
      ]);
      chmodSync(stripped, 0o755);
      assertBinaryRejected(
        "missing-evidence",
        stripped,
        /missing embedded Cargo audit evidence/,
      );

      const omitted = resolve(temporary, "omitted-linked-crate-zuuli");
      mutateAuditableBinary(audited, omitted, temporary, (document) => {
        const linkedIndex = document.packages.findIndex(
          (entry) => entry.name === "linked",
        );
        assert.notEqual(linkedIndex, -1);
        document.packages.splice(linkedIndex, 1);
        for (const entry of document.packages) {
          entry.dependencies = (entry.dependencies ?? [])
            .filter((index) => index !== linkedIndex)
            .map((index) => (index > linkedIndex ? index - 1 : index));
          if (entry.dependencies.length === 0) delete entry.dependencies;
        }
      });
      assertBinaryRejected(
        "omitted-linked-crate",
        omitted,
        /omits locked package linked 1\.2\.3/,
      );

      const wrongVersion = resolve(temporary, "wrong-version-zuuli");
      mutateAuditableBinary(audited, wrongVersion, temporary, (document) => {
        document.packages.find((entry) => entry.name === "linked").version =
          "9.9.9";
      });
      assertBinaryRejected(
        "wrong-version",
        wrongVersion,
        /omits locked package linked 1\.2\.3|unknown or wrong-version package linked 9\.9\.9/,
      );

      const unknown = resolve(temporary, "unknown-package-zuuli");
      mutateAuditableBinary(audited, unknown, temporary, (document) => {
        const root = document.packages.find((entry) => entry.root === true);
        const index = document.packages.length;
        document.packages.push({
          name: "unknown-runtime",
          version: "7.0.0",
          source: "local",
        });
        root.dependencies = [...(root.dependencies ?? []), index];
      });
      assertBinaryRejected(
        "unknown-package",
        unknown,
        /unknown or wrong-version package unknown-runtime 7\.0\.0/,
      );

      const wrongSource = resolve(temporary, "wrong-source-zuuli");
      mutateAuditableBinary(audited, wrongSource, temporary, (document) => {
        document.packages.find((entry) => entry.name === "linked").source =
          "crates.io";
      });
      assertBinaryRejected(
        "wrong-source",
        wrongSource,
        /omits locked package linked 1\.2\.3|unknown or wrong-version package linked 1\.2\.3/,
      );

      const duplicate = resolve(temporary, "duplicate-package-zuuli");
      mutateAuditableBinary(audited, duplicate, temporary, (document) => {
        const root = document.packages.find((entry) => entry.root === true);
        const linkedPackage = document.packages.find(
          (entry) => entry.name === "linked",
        );
        const index = document.packages.length;
        document.packages.push(structuredClone(linkedPackage));
        root.dependencies = [...(root.dependencies ?? []), index];
      });
      assertBinaryRejected(
        "duplicate-package",
        duplicate,
        /runtime package is duplicated: linked 1\.2\.3/,
      );

      const malformed = resolve(temporary, "malformed-document-zuuli");
      mutateAuditableBinary(audited, malformed, temporary, (document) => {
        document.format = 2;
      });
      assertBinaryRejected(
        "malformed-document",
        malformed,
        /must be format 1 with a bounded package list/,
      );

      const cyclic = resolve(temporary, "cyclic-graph-zuuli");
      mutateAuditableBinary(audited, cyclic, temporary, (document) => {
        const rootIndex = document.packages.findIndex(
          (entry) => entry.root === true,
        );
        const linkedPackage = document.packages.find(
          (entry) => entry.name === "linked",
        );
        linkedPackage.dependencies = [
          ...(linkedPackage.dependencies ?? []),
          rootIndex,
        ];
      });
      assertBinaryRejected("cyclic-graph", cyclic, /evidence contains a cycle/);

      const unreachable = resolve(temporary, "unreachable-graph-zuuli");
      mutateAuditableBinary(audited, unreachable, temporary, (document) => {
        document.packages.push({
          name: "unreachable-runtime",
          version: "8.0.0",
          source: "local",
          kind: "build",
        });
      });
      assertBinaryRejected(
        "unreachable-graph",
        unreachable,
        /evidence contains an unreachable package/,
      );

      {
        assert.throws(
          () =>
            finalizeCargoRuntimeFixture(
              temporary,
              "wrong-feature-selection",
              artifact,
              { ...options, cargoFeatures: "none" },
            ),
          /unknown or wrong-version package featured 2\.0\.0/,
        );
      }
      {
        assert.throws(
          () =>
            finalizeCargoRuntimeFixture(
              temporary,
              "wrong-target-selection",
              artifact,
              { ...options, cargoTarget: "x86_64-pc-windows-gnu" },
            ),
          /omits locked package wrong-target 4\.0\.0|unknown or wrong-version package linux-only 3\.0\.0/,
        );
      }

      {
        const incompleteWork = resolve(temporary, "incomplete-options");
        const incompleteRoot = resolve(incompleteWork, "root");
        const incompleteRaw = resolve(incompleteWork, "raw.cdx.json");
        mkdirSync(incompleteWork);
        writeJson(incompleteRaw, minimalCycloneDx());
        prepareArtifact({ artifact, root: incompleteRoot });
        assert.throws(
          () =>
            finalizeArtifactSbom({
              artifact,
              root: incompleteRoot,
              rawSbom: incompleteRaw,
              sbom: resolve(incompleteWork, "partial.sbom.cdx.json"),
              binding: resolve(incompleteWork, "partial.binding.json"),
              cargoLock: options.cargoLock,
            }),
          /Linux Cargo runtime finalization options must be complete/,
        );
        assert.throws(
          () =>
            verifyArtifactSbom({
              artifact,
              sbom: finalized.sbom,
              binding: finalized.binding,
              cargoLock: options.cargoLock,
            }),
          /Linux Cargo runtime verification options must be complete/,
        );
        assert.throws(
          () =>
            verifyArtifactSbom({
              artifact,
              sbom: finalized.sbom,
              binding: finalized.binding,
            }),
          /Cargo runtime evidence is present but was not independently verified/,
        );
      }

      {
        const cliWork = resolve(temporary, "cli");
        const cliRoot = resolve(cliWork, "root");
        const cliRaw = resolve(cliWork, "raw.cdx.json");
        const cliSbom = resolve(cliWork, "artifact.sbom.cdx.json");
        const cliBinding = resolve(cliWork, "artifact.binding.json");
        mkdirSync(cliWork);
        writeJson(cliRaw, minimalCycloneDx());
        runArtifactSbomCli([
          "prepare",
          `--artifact=${artifact}`,
          `--root=${cliRoot}`,
        ]);
        const cargoCliOptions = [
          `--cargo-lock=${options.cargoLock}`,
          `--cargo-manifest=${options.cargoManifest}`,
          `--cargo-target=${options.cargoTarget}`,
          `--cargo-features=${options.cargoFeatures}`,
        ];
        runArtifactSbomCli([
          "finalize-artifact",
          `--artifact=${artifact}`,
          `--root=${cliRoot}`,
          `--raw-sbom=${cliRaw}`,
          `--sbom=${cliSbom}`,
          `--binding=${cliBinding}`,
          ...cargoCliOptions,
        ]);
        runArtifactSbomCli([
          "verify-artifact",
          `--artifact=${artifact}`,
          `--sbom=${cliSbom}`,
          `--binding=${cliBinding}`,
          ...cargoCliOptions,
        ]);
        assert.match(
          artifactSbomCliFailure([
            "verify-artifact",
            `--artifact=${artifact}`,
            `--sbom=${cliSbom}`,
            `--binding=${cliBinding}`,
          ]),
          /Cargo runtime evidence is present but was not independently verified/,
        );
        assert.match(
          artifactSbomCliFailure([
            "verify-artifact",
            `--artifact=${artifact}`,
            `--sbom=${cliSbom}`,
            `--binding=${cliBinding}`,
            `--cargo-lock=${options.cargoLock}`,
          ]),
          /Linux Cargo runtime verification options must be complete/,
        );
        assert.match(
          artifactSbomCliFailure([
            "finalize-artifact",
            `--artifact=${artifact}`,
            `--root=${cliRoot}`,
            `--raw-sbom=${cliRaw}`,
            `--sbom=${resolve(cliWork, "partial.sbom.cdx.json")}`,
            `--binding=${resolve(cliWork, "partial.binding.json")}`,
            `--cargo-lock=${options.cargoLock}`,
          ]),
          /Linux Cargo runtime finalization options must be complete/,
        );
      }

      const originalBinding = finalizedBinding;
      const assertBindingRejected = (name, mutate, expected) => {
        const path = resolve(temporary, `${name}.binding.json`);
        const record = structuredClone(originalBinding);
        mutate(record);
        writeJson(path, record);
        assert.throws(
          () =>
            verifyArtifactSbom({
              artifact,
              sbom: finalized.sbom,
              binding: path,
              ...options,
            }),
          expected,
        );
      };
      assertBindingRejected(
        "unbound-evidence",
        (record) => delete record.cargoRuntime,
        /does not match exact Cargo runtime evidence/,
      );
      assertBindingRejected(
        "substituted-evidence-digest",
        (record) => {
          record.cargoRuntime.evidence.compressedSha256 = "0".repeat(64);
        },
        /does not match exact Cargo runtime evidence/,
      );

      {
        const exactLock = readFileSync(options.cargoLock);
        appendFileSync(options.cargoLock, "\n");
        assert.throws(
          () =>
            verifyArtifactSbom({
              artifact,
              sbom: finalized.sbom,
              binding: finalized.binding,
              ...options,
            }),
          /does not match exact Cargo runtime evidence and Cargo\.lock/,
        );
        writeFileSync(options.cargoLock, exactLock);
      }

      {
        const exactArtifact = readFileSync(artifact);
        appendFileSync(artifact, "substituted artifact bytes");
        assert.throws(
          () =>
            verifyArtifactSbom({
              artifact,
              sbom: finalized.sbom,
              binding: finalized.binding,
              ...options,
            }),
          /binding does not match exact artifact and SBOM bytes/,
        );
        writeFileSync(artifact, exactArtifact);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test(
  "AppImage inspection fails closed on ELF arithmetic and SquashFS boundary mutations",
  { skip: !canBuildLinuxFixtures, timeout: 120_000 },
  () => {
    const temporary = mkdtempSync(
      resolve(tmpdir(), "zuuli-appimage-mutation-"),
    );
    try {
      const artifact = makeAppImageFixture(temporary);
      const original = readFileSync(artifact);
      assert.equal(
        original[4],
        2,
        "the fixture must exercise ELF64 arithmetic",
      );
      const payloadOffset = appImagePayloadOffset(artifact);
      const sectionTableOffset = Number(original.readBigUInt64LE(40));
      const sectionHeaderSize = original.readUInt16LE(58);
      const sectionCount = original.readUInt16LE(60);
      const lastSectionHeader =
        sectionTableOffset + sectionHeaderSize * (sectionCount - 1);
      const earlierSectionHeader =
        sectionTableOffset + sectionHeaderSize * (sectionCount - 2);
      const noBitsSectionHeader =
        sectionTableOffset + sectionHeaderSize * (sectionCount - 3);
      const noBitsArtifact = resolve(
        temporary,
        "nobits-extends-past-payload.AppImage",
      );
      const noBitsBytes = Buffer.from(original);
      noBitsBytes.writeUInt32LE(8, noBitsSectionHeader + 4);
      noBitsBytes.writeBigUInt64LE(
        BigInt(payloadOffset + original.length),
        noBitsSectionHeader + 24,
      );
      noBitsBytes.writeBigUInt64LE(4096n, noBitsSectionHeader + 32);
      writeFileSync(noBitsArtifact, noBitsBytes);
      assert.equal(
        appImagePayloadOffset(noBitsArtifact),
        payloadOffset,
        "SHT_NOBITS memory extents must not move the file-backed ELF boundary",
      );
      const mutations = [
        {
          name: "truncated-elf",
          bytes: original.subarray(0, 32),
          expected: /ELF header is truncated/,
        },
        {
          name: "overflowed-section-table",
          mutate(bytes) {
            bytes.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 40);
          },
          expected: /exceeds the safe integer range/,
        },
        {
          name: "truncated-section-table",
          bytes: original.subarray(0, lastSectionHeader + 32),
          expected: /ELF section .* header is truncated/,
        },
        {
          name: "earlier-section-extends-past-final-header",
          mutate(bytes) {
            bytes.writeBigUInt64LE(
              BigInt(payloadOffset),
              earlierSectionHeader + 24,
            );
            bytes.writeBigUInt64LE(1n, earlierSectionHeader + 32);
          },
          expected: /does not begin with SquashFS magic/,
        },
        {
          name: "overflowed-section-extent",
          mutate(bytes) {
            bytes.writeBigUInt64LE(
              BigInt(Number.MAX_SAFE_INTEGER),
              earlierSectionHeader + 24,
            );
            bytes.writeBigUInt64LE(1n, earlierSectionHeader + 32);
          },
          expected: /section .* extent exceeds the safe integer range/,
        },
        {
          name: "shifted-squashfs-offset",
          mutate(bytes) {
            bytes.writeBigUInt64LE(
              BigInt(payloadOffset + 1),
              lastSectionHeader + 24,
            );
            bytes.writeBigUInt64LE(0n, lastSectionHeader + 32);
          },
          expected: /does not begin with SquashFS magic/,
        },
        {
          name: "missing-squashfs-magic",
          mutate(bytes) {
            bytes[payloadOffset] = 0;
          },
          expected: /does not begin with SquashFS magic/,
        },
        {
          name: "wrong-squashfs-version",
          mutate(bytes) {
            bytes.writeUInt16LE(3, payloadOffset + 28);
          },
          expected: /SquashFS v4/,
        },
        {
          name: "overflowed-squashfs-boundary",
          mutate(bytes) {
            bytes.writeBigUInt64LE(
              BigInt(bytes.length - payloadOffset + 1),
              payloadOffset + 40,
            );
          },
          expected: /exceeds the artifact boundary/,
        },
        {
          name: "overflowed-squashfs-addition",
          mutate(bytes) {
            bytes.writeBigUInt64LE(
              BigInt(Number.MAX_SAFE_INTEGER),
              payloadOffset + 40,
            );
          },
          expected: /SquashFS payload end exceeds the safe integer range/,
        },
        {
          name: "missing-type-2-magic",
          mutate(bytes) {
            bytes[8] = 0;
          },
          expected: /missing the Type 2 AI magic/,
        },
      ];
      for (const mutation of mutations) {
        const path = resolve(temporary, `${mutation.name}.AppImage`);
        const bytes = mutation.bytes ?? Buffer.from(original);
        mutation.mutate?.(bytes);
        writeFileSync(path, bytes);
        assert.throws(
          () => appImagePayloadOffset(path),
          mutation.expected,
          mutation.name,
        );
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test(
  "AppImage listing rejects a SquashFS member with invalid UTF-8 bytes",
  { skip: !canBuildLinuxFixtures, timeout: 120_000 },
  () => {
    const temporary = mkdtempSync(
      resolve(tmpdir(), "zuuli-appimage-utf8-mutation-"),
    );
    try {
      const artifact = makeAppImageFixture(temporary, {
        invalidUtf8Name: true,
      });
      const root = resolve(temporary, "unpacked");
      assert.throws(
        () => prepareArtifact({ artifact, root }),
        /SquashFS member listing must be valid UTF-8/,
      );
      assert.equal(existsSync(root), false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test(
  "a real deb with an escaping payload symlink fails before extraction",
  { skip: !canBuildLinuxFixtures, timeout: 120_000 },
  () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-deb-mutation-"));
    try {
      const artifact = makeDebFixture(temporary, { escapingSymlink: true });
      assert.throws(
        () =>
          prepareArtifact({
            artifact,
            root: resolve(temporary, "unpacked"),
          }),
        /symlink escapes payload/,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

test("tar payload parser rejects traversal, links, special files, and duplicates", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-tar-mutations-"));
  try {
    const cases = [
      {
        name: "traversal",
        entries: [{ name: "../escape", data: "x" }],
        expected: /unsafe tar member/,
      },
      {
        name: "absolute",
        entries: [{ name: "/absolute", data: "x" }],
        expected: /unsafe tar member/,
      },
      {
        name: "escaping-symlink",
        entries: [{ name: "usr/link", type: "2", target: "../../../outside" }],
        expected: /symlink escapes payload/,
      },
      {
        name: "escaping-hardlink",
        entries: [
          { name: "usr/file", data: "x" },
          { name: "usr/hard", type: "1", target: "../outside" },
        ],
        expected: /unsafe tar member/,
      },
      {
        name: "absolute-hardlink",
        entries: [
          { name: "usr/file", data: "x" },
          { name: "usr/hard", type: "1", target: "/outside" },
        ],
        expected: /unsafe tar member/,
      },
      {
        name: "special-file",
        entries: [{ name: "dev/device", type: "3" }],
        expected: /unsupported tar member type/,
      },
      {
        name: "duplicate",
        entries: [
          { name: "usr/file", data: "first" },
          { name: "usr/file", data: "second" },
        ],
        expected: /duplicate artifact member/,
      },
      {
        name: "invalid-utf8-name",
        entries: [{ name: Buffer.from([0xff]), data: "x" }],
        expected: /valid UTF-8/,
        beforeMaterialization: true,
      },
      {
        name: "invalid-utf8-linkname",
        entries: [
          {
            name: "usr/link",
            type: "2",
            target: Buffer.from([0xff]),
          },
        ],
        expected: /valid UTF-8/,
        beforeMaterialization: true,
      },
      {
        name: "invalid-utf8-pax-path",
        entries: [
          {
            name: "pax-header",
            type: "x",
            data: paxRecord("path", Buffer.from([0xff])),
          },
          { name: "fallback", data: "x" },
        ],
        expected: /valid UTF-8/,
        beforeMaterialization: true,
      },
      {
        name: "invalid-utf8-pax-linkpath",
        entries: [
          {
            name: "pax-header",
            type: "x",
            data: paxRecord("linkpath", Buffer.from([0xff])),
          },
          { name: "usr/link", type: "2", target: "safe" },
        ],
        expected: /valid UTF-8/,
        beforeMaterialization: true,
      },
      {
        name: "invalid-utf8-gnu-long-name",
        entries: [
          {
            name: "long-name-header",
            type: "L",
            data: Buffer.from([0xff, 0]),
          },
          { name: "fallback", data: "x" },
        ],
        expected: /valid UTF-8/,
        beforeMaterialization: true,
      },
      {
        name: "invalid-utf8-gnu-long-link",
        entries: [
          {
            name: "long-link-header",
            type: "K",
            data: Buffer.from([0xff, 0]),
          },
          { name: "usr/link", type: "2", target: "safe" },
        ],
        expected: /valid UTF-8/,
        beforeMaterialization: true,
      },
      ...["1e0", "1.0", " 1", "01"].map((size) => ({
        name: `noncanonical-pax-size-${Buffer.from(size).toString("hex")}`,
        entries: [
          {
            name: "pax-header",
            type: "x",
            data: paxRecord("size", size),
          },
          { name: "file", data: "x" },
        ],
        expected: /PAX member size must use canonical decimal digits/,
        beforeMaterialization: true,
      })),
    ];
    for (const fixture of cases) {
      const archive = resolve(temporary, `${fixture.name}.tar`);
      const root = resolve(temporary, `${fixture.name}-root`);
      writeTarFixture(archive, fixture.entries);
      assert.throws(
        () => extractTarArchive(archive, root),
        fixture.expected,
        fixture.name,
      );
      if (fixture.beforeMaterialization) {
        assert.equal(
          existsSync(root),
          false,
          `${fixture.name} must fail before materializing the payload`,
        );
      }
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("artifact logical inventory enforces count and expanded-byte ceilings", () => {
  assert.throws(
    () =>
      validateLogicalEntries(
        Array.from({ length: 100_001 }, (_, index) => ({
          path: `entry-${index}`,
          kind: "directory",
          size: 0,
        })),
      ),
    /too many entries/,
  );
  assert.throws(
    () =>
      validateLogicalEntries([
        {
          path: "oversized-file",
          kind: "regular",
          size: 4 * 1024 * 1024 * 1024 + 1,
        },
      ]),
    /expands beyond/,
  );
});

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
    assert.deepEqual(
      document.components
        .find((component) => component.name === "example")
        .properties.filter((entry) => entry.name === "syft:cpe23")
        .map((entry) => entry.value),
      [
        "cpe:2.3:a:example:first:*:*:*:*:*:*:*:*",
        "cpe:2.3:a:example:second:*:*:*:*:*:*:*:*",
      ],
      "ordered upstream multivalue properties must survive finalization",
    );
    rmSync(root, { recursive: true, force: true });
    assert.doesNotThrow(
      () => verifyArtifactSbom({ artifact: archive, sbom, binding }),
      "verification must remain independent after the mutable scan root is removed",
    );

    const originalSbomBytes = readFileSync(sbom);
    appendFileSync(sbom, "replaced SBOM bytes");
    assert.throws(
      () => verifyArtifactSbom({ artifact: archive, sbom, binding }),
      /binding does not match exact artifact and SBOM bytes/,
    );
    writeFileSync(sbom, originalSbomBytes);

    const duplicatedSbom = resolve(temporary, "duplicated.sbom.cdx.json");
    const duplicatedDocument = JSON.parse(JSON.stringify(document));
    duplicatedDocument.components.push(JSON.parse(JSON.stringify(canary)));
    writeJson(duplicatedSbom, duplicatedDocument);
    const duplicatedBinding = resolve(
      temporary,
      "duplicated.sbom-binding.json",
    );
    const duplicatedRecord = JSON.parse(readFileSync(binding, "utf8"));
    duplicatedRecord.sbom = {
      path: basename(duplicatedSbom),
      bytes: lstatSync(duplicatedSbom).size,
      sha256: sha256File(duplicatedSbom),
    };
    writeJson(duplicatedBinding, duplicatedRecord);
    assert.throws(
      () =>
        verifyArtifactSbom({
          artifact: archive,
          sbom: duplicatedSbom,
          binding: duplicatedBinding,
        }),
      /duplicate artifact file component/,
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

test("SBOM property validation preserves upstream multivalues and rejects ambiguous authority fields", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-sbom-properties-"));
  try {
    const { archive } = makeZipFixture(temporary);
    const root = resolve(temporary, "unpacked");
    prepareArtifact({ artifact: archive, root });
    const assertRawRejected = (name, mutate, expected) => {
      const document = minimalCycloneDx();
      mutate(document.components[0].properties);
      const rawSbom = resolve(temporary, `${name}.raw.cdx.json`);
      writeJson(rawSbom, document);
      assert.throws(
        () =>
          finalizeArtifactSbom({
            artifact: archive,
            root,
            rawSbom,
            sbom: resolve(temporary, `${name}.artifact.sbom.cdx.json`),
            binding: resolve(temporary, `${name}.artifact.sbom-binding.json`),
          }),
        expected,
      );
    };
    assertRawRejected(
      "non-string",
      (properties) => properties.push({ name: "syft:invalid", value: 1 }),
      /must have string names and values/,
    );
    const malformedDocument = minimalCycloneDx();
    malformedDocument.components[0].properties = {};
    const malformedRawSbom = resolve(
      temporary,
      "malformed-collection.raw.cdx.json",
    );
    writeJson(malformedRawSbom, malformedDocument);
    assert.throws(
      () =>
        finalizeArtifactSbom({
          artifact: archive,
          root,
          rawSbom: malformedRawSbom,
          sbom: resolve(
            temporary,
            "malformed-collection.artifact.sbom.cdx.json",
          ),
          binding: resolve(
            temporary,
            "malformed-collection.artifact.sbom-binding.json",
          ),
        }),
      /properties must be an array/,
    );
    assertRawRejected(
      "duplicate-authority",
      (properties) =>
        properties.push(
          { name: "free2z:test-authority", value: "same" },
          { name: "free2z:test-authority", value: "same" },
        ),
      /authority property must be unique: free2z:test-authority/,
    );
    assertRawRejected(
      "conflicting-authority",
      (properties) =>
        properties.push(
          { name: "free2z:test-authority", value: "first" },
          { name: "free2z:test-authority", value: "second" },
        ),
      /authority property must be unique: free2z:test-authority/,
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

test("a failed DMG attach is detached before its temporary tree is removed", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-dmg-attach-failure-"));
  let mountpoint;
  const calls = [];
  try {
    assert.throws(
      () =>
        extractDmg(
          resolve(temporary, "broken.dmg"),
          resolve(temporary, "root"),
          {
            execute(command, args) {
              assert.equal(command, "hdiutil");
              calls.push(args);
              if (args[0] === "attach") {
                mountpoint = args.at(-1);
                throw new Error("attach failed after a partial mount");
              }
              return Buffer.alloc(0);
            },
          },
        ),
      /attach failed after a partial mount/,
    );
    assert.deepEqual(
      calls.map((args) => args[0]),
      ["attach", "detach"],
    );
    assert.equal(
      lstatSync(dirname(mountpoint), { throwIfNoEntry: false }),
      undefined,
      "the private tree is removable only after detach succeeds",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a failed DMG detach leaves the potentially live mount tree intact", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-dmg-detach-failure-"));
  let mountpoint;
  const calls = [];
  try {
    assert.throws(
      () =>
        extractDmg(
          resolve(temporary, "broken.dmg"),
          resolve(temporary, "root"),
          {
            execute(command, args) {
              assert.equal(command, "hdiutil");
              calls.push(args);
              if (args[0] === "attach") {
                mountpoint = args.at(-1);
                throw new Error("attach timed out after a partial mount");
              }
              throw new Error("detach failed");
            },
          },
        ),
      /failed to detach artifact DMG safely/,
    );
    assert.deepEqual(
      calls.map((args) => args.join(" ")),
      [
        calls[0].join(" "),
        `detach ${mountpoint}`,
        `detach ${mountpoint} -force`,
      ],
    );
    assert.equal(
      lstatSync(dirname(mountpoint)).isDirectory(),
      true,
      "a possibly mounted tree must be left for runner cleanup",
    );
  } finally {
    if (mountpoint) {
      // The injected command never created a real mount.
      rmSync(dirname(mountpoint), { recursive: true, force: true });
    }
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
  const skippedLinuxScan = packaging.replace(
    "      - name: Scan Linux AppImage shipped artifact\n        if: runner.os == 'Linux'\n",
    "      - name: Scan Linux AppImage shipped artifact\n        if: false\n",
  );
  assert.ok(
    artifactSbomWorkflowFailures(skippedLinuxScan, release).some((failure) =>
      failure.includes("Scan Linux AppImage shipped artifact action contract"),
    ),
    "a Linux Syft action cannot be conditionally skipped",
  );
  const softFailingLinuxScan = packaging.replace(
    "      - name: Scan Linux deb shipped artifact\n        if: runner.os == 'Linux'\n",
    "      - name: Scan Linux deb shipped artifact\n        if: runner.os == 'Linux'\n        continue-on-error: true\n",
  );
  assert.ok(
    artifactSbomWorkflowFailures(softFailingLinuxScan, release).some(
      (failure) =>
        failure.includes("Scan Linux deb shipped artifact action contract"),
    ),
    "a Linux Syft action cannot soft-fail",
  );
  const skippedReleaseLinuxScan = release.replace(
    "      - name: Scan Linux rpm shipped artifact\n        uses:",
    "      - name: Scan Linux rpm shipped artifact\n        if: false\n        uses:",
  );
  assert.ok(
    artifactSbomWorkflowFailures(packaging, skippedReleaseLinuxScan).some(
      (failure) =>
        failure.includes("Scan Linux rpm shipped artifact action contract"),
    ),
    "a protected-release Syft action cannot gain a skip condition",
  );
  const duplicateScan = packaging.replace(
    "      - name: Scan Linux rpm shipped artifact\n",
    "      - name: Scan Linux rpm shipped artifact\n        if: false\n        run: echo decorative\n      - name: Scan Linux rpm shipped artifact\n",
  );
  assert.ok(
    artifactSbomWorkflowFailures(duplicateScan, release).some((failure) =>
      failure.includes(
        "expected one named Scan Linux rpm shipped artifact step, found 2",
      ),
    ),
    "duplicate/decorative scan steps cannot satisfy the canonical action",
  );
  const decorativeScan = packaging.replace(
    "      - name: Scan Linux AppImage shipped artifact\n",
    "      - name: Decorative Linux scan\n        if: runner.os == 'Linux'\n        uses: anchore/sbom-action@fbfd9c6c189226748411491745178e0c2017392d # v0.20.10\n        with:\n          syft-version: v1.50.0\n          path: wallet/zuuli/decorative\n          config: wallet/zuuli/syft-artifact.yaml\n          format: cyclonedx-json\n          output-file: wallet/zuuli/decorative.cdx.json\n          upload-artifact: false\n      - name: Scan Linux AppImage shipped artifact\n",
  );
  assert.ok(
    artifactSbomWorkflowFailures(decorativeScan, release).some((failure) =>
      failure.includes("expected 6 total canonical Syft actions, found 7"),
    ),
    "an extra decorative Syft action cannot obscure the reviewed scan set",
  );
  const skippedLinuxPreparation = packaging.replace(
    "      - name: Prepare Linux shipped-artifact inventories\n        if: runner.os == 'Linux'\n",
    "      - name: Prepare Linux shipped-artifact inventories\n        if: false\n",
  );
  assert.ok(
    artifactSbomWorkflowFailures(skippedLinuxPreparation, release).some(
      (failure) => failure.includes("must be a multiline run step"),
    ),
    "Linux preparation cannot be skipped",
  );
  const softFailingLinuxBinding = release.replace(
    "      - name: Bind Linux shipped-artifact SBOMs\n        run: |\n",
    "      - name: Bind Linux shipped-artifact SBOMs\n        continue-on-error: true\n        run: |\n",
  );
  assert.ok(
    artifactSbomWorkflowFailures(packaging, softFailingLinuxBinding).some(
      (failure) => failure.includes("must be a multiline run step"),
    ),
    "Linux binding cannot soft-fail",
  );
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
  const skippedLinuxRpm = packaging.replace(
    'node scripts/artifact-sbom.mjs prepare --artifact="${rpms[0]}" --root=artifact-sbom-work/linux-rpm/root',
    'node scripts/artifact-sbom.mjs prepare-disabled --artifact="${rpms[0]}" --root=artifact-sbom-work/linux-rpm/root',
  );
  assert.ok(
    artifactSbomWorkflowFailures(skippedLinuxRpm, release).some((failure) =>
      failure.includes("packaging linux"),
    ),
  );
  const earlyLinuxManifest = packaging.replace(
    'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${appimages[0]}" --root=artifact-sbom-work/linux-appimage/root',
    'npm run release:manifest -- --artifacts=release-artifacts\n          node scripts/artifact-sbom.mjs finalize-artifact --artifact="${appimages[0]}" --root=artifact-sbom-work/linux-appimage/root',
  );
  assert.ok(
    artifactSbomWorkflowFailures(earlyLinuxManifest, release).some((failure) =>
      failure.includes("packaging linux"),
    ),
    "the policy must keep all Linux scans and bindings before manifest/upload",
  );
  const skippedRealFixtures = packaging.replace(
    "node --test --test-name-pattern='real AppImage, deb, and rpm|AppImage inspection|AppImage listing|real deb with an escaping|real cargo-auditable executable evidence' scripts/artifact-sbom.node-test.mjs",
    "node --test --test-name-pattern='nonexistent' scripts/artifact-sbom.node-test.mjs",
  );
  assert.ok(
    artifactSbomWorkflowFailures(skippedRealFixtures, release).some((failure) =>
      failure.includes("packaging linux"),
    ),
  );
  const sourceScanSubstitution = release.replace(
    "path: wallet/zuuli/artifact-sbom-work/linux-deb/root",
    "path: wallet/zuuli",
  );
  assert.ok(
    artifactSbomWorkflowFailures(packaging, sourceScanSubstitution).some(
      (failure) => failure.includes("release linux artifacts"),
    ),
    "the policy must reject substituting a source scan for the deb artifact payload",
  );
  const mutableLinuxRoot = release.replace(
    'node scripts/artifact-sbom.mjs verify-artifact --artifact="${appimages[0]}" --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json',
    'node scripts/artifact-sbom.mjs verify-artifact --artifact="${appimages[0]}" --root=artifact-sbom-work/linux-appimage/root --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json',
  );
  assert.ok(
    artifactSbomWorkflowFailures(packaging, mutableLinuxRoot).some((failure) =>
      failure.includes("release linux artifacts"),
    ),
    "the policy must require exact AppImage re-extraction before release provenance",
  );
  const uninstrumentedBuild = packaging.replace(
    "scripts/run-with-cargo-auditable.sh ./node_modules/.bin/tauri build --bundles '${{ matrix.bundles }}' -- --locked",
    "./node_modules/.bin/tauri build --bundles '${{ matrix.bundles }}' -- --locked",
  );
  assert.ok(
    artifactSbomWorkflowFailures(uninstrumentedBuild, release).some((failure) =>
      failure.includes("Build packages executable lines changed"),
    ),
    "the policy must reject a Linux build without Cargo audit instrumentation",
  );
  const unpinnedInstrumentation = release.replace(
    "cargo install --locked cargo-auditable --version 0.7.5",
    "cargo install cargo-auditable",
  );
  assert.ok(
    artifactSbomWorkflowFailures(packaging, unpinnedInstrumentation).some(
      (failure) =>
        failure.includes(
          "Install pinned Cargo audit instrumentation executable lines changed",
        ),
    ),
    "the policy must reject unpinned Cargo audit instrumentation",
  );
  const unboundFinalization = packaging.replace(
    " --cargo-target=x86_64-unknown-linux-gnu --cargo-features=default",
    " --cargo-target=x86_64-unknown-linux-gnu",
  );
  assert.ok(
    artifactSbomWorkflowFailures(unboundFinalization, release).some((failure) =>
      failure.includes("Bind Linux shipped-artifact SBOMs"),
    ),
    "every Linux finalization must bind the exact Cargo feature set",
  );
  const unboundVerification = release.replace(
    'node scripts/artifact-sbom.mjs verify-artifact --artifact="${appimages[0]}" --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-appimage.artifact.sbom-binding.json --cargo-lock=src-tauri/Cargo.lock',
    'node scripts/artifact-sbom.mjs verify-artifact --artifact="${appimages[0]}" --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-appimage.artifact.sbom-binding.json',
  );
  assert.ok(
    artifactSbomWorkflowFailures(packaging, unboundVerification).some(
      (failure) => failure.includes("release linux artifacts"),
    ),
    "every Linux verification must independently supply the exact Cargo lock",
  );
});
