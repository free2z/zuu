import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  truncateSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { collectLinuxCargoRuntime } from "./linux-cargo-runtime.mjs";
import {
  collectMachOCargoRuntime,
  extractMachOCargoEvidence,
  verifyMachOCargoRuntime,
} from "./macho-cargo-runtime.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const document = (dependency = "mac-only", version = "1.2.3") => ({
  format: 8,
  packages: [
    { name: dependency, version, source: "local" },
    {
      name: "fixture",
      version: "0.1.0",
      source: "local",
      root: true,
      dependencies: [0],
    },
  ],
});
const compressed = (value = document()) =>
  deflateSync(Buffer.from(JSON.stringify(value)));

// Checkable minimal linked Mach-O image: mach_header_64, LC_SEGMENT_64 with
// one section_64, LC_BUILD_VERSION, then data. These are not build evidence;
// they exercise the exact reader/reconciler used by the real linked fixture.
function thin({
  cpu = 0x01000007,
  subtype = 3,
  platform = 1,
  data = compressed(),
} = {}) {
  const bytes = Buffer.alloc(256 + data.length);
  [0xfeedfacf, cpu, subtype, 2, 2, 176, 0, 0].forEach((v, i) =>
    bytes.writeUInt32LE(v, i * 4),
  );
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(152, 36);
  bytes.write("__DATA", 40);
  bytes.writeBigUInt64LE(BigInt(256), 72);
  bytes.writeBigUInt64LE(BigInt(data.length), 80);
  bytes.writeUInt32LE(1, 96);
  bytes.write(".dep-v0", 104);
  bytes.write("__DATA", 120);
  bytes.writeBigUInt64LE(BigInt(data.length), 144);
  bytes.writeUInt32LE(256, 152);
  bytes.writeUInt32LE(0x32, 184);
  bytes.writeUInt32LE(24, 188);
  bytes.writeUInt32LE(platform, 192);
  data.copy(bytes, 256);
  return bytes;
}
function fat(slices, { wide = false, little = false } = {}) {
  const bytes = Buffer.alloc(4096 * (slices.length + 1));
  const write32 = (v, pos) =>
    little ? bytes.writeUInt32LE(v, pos) : bytes.writeUInt32BE(v, pos);
  write32(wide ? 0xcafebabf : 0xcafebabe, 0);
  write32(slices.length, 4);
  slices.forEach((slice, i) => {
    const pos = 8 + i * (wide ? 32 : 20),
      offset = 4096 * (i + 1);
    write32(slice.readUInt32LE(4), pos);
    write32(slice.readUInt32LE(8), pos + 4);
    if (wide) {
      const write64 = (v, p) =>
        little
          ? bytes.writeBigUInt64LE(BigInt(v), p)
          : bytes.writeBigUInt64BE(BigInt(v), p);
      write64(offset, pos + 8);
      write64(slice.length, pos + 16);
      write32(12, pos + 24);
    } else {
      write32(offset, pos + 8);
      write32(slice.length, pos + 12);
      write32(12, pos + 16);
    }
    slice.copy(bytes, offset);
  });
  return bytes;
}
const arm = () => thin({ cpu: 0x0100000c, subtype: 0 });

function project(directory) {
  for (const dep of ["mac-only", "ios-only"]) {
    mkdirSync(resolve(directory, dep, "src"), { recursive: true });
    writeFileSync(
      resolve(directory, dep, "Cargo.toml"),
      `[package]\nname = "${dep}"\nversion = "1.2.3"\nedition = "2024"\n`,
    );
    writeFileSync(resolve(directory, dep, "src/lib.rs"), "");
  }
  mkdirSync(resolve(directory, "src"));
  writeFileSync(resolve(directory, "src/main.rs"), "fn main() {}\n");
  writeFileSync(
    resolve(directory, "Cargo.toml"),
    `[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2024"\n[target.'cfg(target_os = "macos")'.dependencies]\nmac-only = { path = "mac-only" }\n[target.'cfg(target_os = "ios")'.dependencies]\nios-only = { path = "ios-only" }\n`,
  );
  execFileSync(
    "cargo",
    [
      "generate-lockfile",
      "--offline",
      "--manifest-path",
      resolve(directory, "Cargo.toml"),
    ],
    { timeout: 30_000 },
  );
  return {
    cargoManifest: resolve(directory, "Cargo.toml"),
    cargoLock: resolve(directory, "Cargo.lock"),
    executable: resolve(directory, "fixture"),
    targets: [
      { target: "aarch64-apple-darwin", features: "none" },
      { target: "x86_64-apple-darwin", features: "none" },
    ],
  };
}

test("Mach-O thin and all four fat encodings recover each independently bound slice", () => {
  const x64 = thin(),
    a64 = arm();
  const parsed = extractMachOCargoEvidence(x64)[0];
  assert.equal(parsed.target, "x86_64-apple-darwin");
  assert.deepEqual(parsed.evidence.document, document());
  assert.equal(parsed.sha256, sha(x64));
  assert.equal(parsed.evidence.compressedSha256, sha(compressed()));
  for (const wide of [false, true])
    for (const little of [false, true]) {
      const bytes = fat([x64, a64], { wide, little });
      const slices = extractMachOCargoEvidence(bytes);
      assert.deepEqual(
        slices.map((s) => s.target),
        ["x86_64-apple-darwin", "aarch64-apple-darwin"],
      );
      assert.deepEqual(
        slices.map((s) => s.sha256),
        [sha(x64), sha(a64)],
      );
      assert.deepEqual(
        slices.map((s) => s.offset),
        [4096, 8192],
      );
    }
  for (const [platform, cpu, subtype, target] of [
    [2, 0x0100000c, 0, "aarch64-apple-ios"],
    [7, 0x0100000c, 0, "aarch64-apple-ios-sim"],
    [7, 0x01000007, 3, "x86_64-apple-ios"],
  ]) {
    assert.equal(
      extractMachOCargoEvidence(thin({ platform, cpu, subtype }))[0].target,
      target,
    );
  }
});

test("Mach-O malformed, missing, duplicate, overlapping and unbounded structures fail closed", () => {
  const cases = [
    ["command size", (b) => b.writeUInt32LE(0, 36)],
    ["command count", (b) => b.writeUInt32LE(3, 16)],
    ["oversized commands", (b) => b.writeUInt32LE(0xffffffff, 20)],
    ["section size", (b) => b.writeBigUInt64LE(0xffffffffffffffffn, 144)],
    ["section out of segment", (b) => b.writeUInt32LE(240, 152)],
    ["section over commands", (b) => b.writeUInt32LE(64, 152)],
    ["section count", (b) => b.writeUInt32LE(2, 96)],
    ["missing section", (b) => b.fill(0, 104, 120)],
    ["wrong segment", (b) => b.write("__TEXT", 40)],
    ["zero fill evidence", (b) => b.writeUInt32LE(1, 168)],
    ["wrong platform", (b) => b.writeUInt32LE(6, 192)],
    ["missing platform", (b) => b.writeUInt32LE(0x99, 184)],
    ["legacy platform", (b) => b.writeUInt32LE(0x24, 184)],
    ["wrong subtype", (b) => b.writeUInt32LE(2, 8)],
    ["wrong CPU", (b) => b.writeUInt32LE(7, 4)],
    ["wrong type", (b) => b.writeUInt32LE(1, 12)],
    ["high name bit", (b) => (b[104] |= 0x80)],
  ];
  for (const [label, mutate] of cases) {
    const b = thin();
    mutate(b);
    assert.throws(() => extractMachOCargoEvidence(b), undefined, label);
  }
  const b = thin();
  for (let size = 0; size < b.length; size++)
    assert.throws(
      () => extractMachOCargoEvidence(b.subarray(0, size)),
      undefined,
      `truncated at ${size}`,
    );
  const fatCases = [
    ["overlap", (b) => b.writeUInt32BE(4096, 36)],
    ["table overlap", (b) => b.writeUInt32BE(0, 16)],
    ["unaligned", (b) => b.writeUInt32BE(4097, 16)],
    ["huge alignment", (b) => b.writeUInt32BE(31, 24)],
    ["wrong outer CPU", (b) => b.writeUInt32BE(0x0100000c, 8)],
    ["truncated table", (b) => b.writeUInt32BE(8, 4)],
  ];
  for (const [label, mutate] of fatCases) {
    const b = fat([thin(), arm()]);
    mutate(b);
    assert.throws(() => extractMachOCargoEvidence(b), undefined, label);
  }
  assert.throws(
    () => extractMachOCargoEvidence(fat([thin(), thin()])),
    /duplicate fat target/,
  );
  // Insert a second identical segment/section or platform command, adjusting
  // header sizes and moving payload. This traverses real command tables.
  for (const [start, size, pattern] of [
    [32, 152, /duplicate .dep-v0/],
    [184, 24, /duplicate platform/],
  ]) {
    const original = thin(),
      duplicate = Buffer.alloc(original.length + size);
    original.copy(duplicate, 0, 0, 208);
    original.copy(duplicate, 208, start, start + size);
    original.copy(duplicate, 256 + size, 256);
    duplicate.writeUInt32LE(3, 16);
    duplicate.writeUInt32LE(176 + size, 20);
    duplicate.writeBigUInt64LE(BigInt(256 + size), 72);
    duplicate.writeUInt32LE(256 + size, 152);
    if (start === 32) {
      duplicate.writeBigUInt64LE(BigInt(256 + size), 208 + 40);
      duplicate.writeUInt32LE(256 + size, 208 + 120);
    }
    assert.throws(() => extractMachOCargoEvidence(duplicate), pattern);
  }
});

test("Mach-O bounded decompression and precise audit-document validation reject corrupt evidence", () => {
  const invalid = [
    Buffer.from("bad"),
    Buffer.alloc(0),
    Buffer.alloc(1024 * 1024 + 1),
    Buffer.concat([compressed(), Buffer.from([0])]),
    deflateSync(Buffer.alloc(8 * 1024 * 1024 + 1, 65)),
    deflateSync(Buffer.from([0xff])),
    deflateSync(Buffer.from("{")),
    compressed({ ...document(), format: 1 }),
    compressed({ ...document(), packages: [] }),
    compressed({
      format: 8,
      packages: [{ ...document().packages[1], dependencies: [0] }],
    }),
    compressed({
      format: 8,
      packages: [
        { ...document().packages[1], dependencies: [] },
        document().packages[0],
      ],
    }),
    compressed({
      format: 8,
      packages: [
        { ...document().packages[0], source: "unknown" },
        document().packages[1],
      ],
    }),
  ];
  for (const data of invalid)
    assert.throws(() => extractMachOCargoEvidence(thin({ data })));
});

test("Mach-O production collector reconciles real target-filtered Cargo graphs and rejects stale bindings", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "zuuli-macho-"));
  try {
    const options = project(directory),
      binary = fat([thin(), arm()]);
    writeFileSync(options.executable, binary);
    const binding = collectMachOCargoRuntime(options);
    assert.deepEqual(verifyMachOCargoRuntime({ ...options, binding }), binding);
    assert.equal(binding.executable.sha256, sha(binary));
    assert.equal(binding.slices.length, 2);
    for (const slice of binding.slices) {
      assert.equal(
        slice.cargoLock.sha256,
        sha(readFileSync(options.cargoLock)),
      );
      assert.deepEqual(
        slice.packages.map((p) => p.name),
        ["fixture", "mac-only"],
      );
    }
    for (const mutation of [
      (b) => (b.executable.sha256 = "0".repeat(64)),
      (b) => b.slices.pop(),
      (b) => (b.slices[0].target = "aarch64-apple-ios"),
      (b) => (b.slices[0].evidence.compressedSha256 = "0".repeat(64)),
      (b) => (b.slices[0].packages[0].version = "9.9.9"),
    ]) {
      const changed = structuredClone(binding);
      mutation(changed);
      assert.throws(
        () => verifyMachOCargoRuntime({ ...options, binding: changed }),
        /binding does not match/,
      );
    }
    assert.throws(
      () => verifyMachOCargoRuntime({ ...options, binding: undefined }),
      /binding does not match/,
    );
    const changed = Buffer.from(binary);
    changed[changed.length - 1] ^= 1;
    writeFileSync(options.executable, changed);
    assert.throws(
      () => verifyMachOCargoRuntime({ ...options, binding }),
      /binding does not match/,
    );
    writeFileSync(options.executable, binary);
    assert.throws(
      () =>
        collectMachOCargoRuntime({
          ...options,
          targets: options.targets.slice(0, 1),
        }),
      /wrong or missing target/,
    );
    for (const [dependency, version] of [
      ["unknown", "1.2.3"],
      ["mac-only", "9.9.9"],
    ]) {
      writeFileSync(
        options.executable,
        fat([
          thin(),
          thin({
            cpu: 0x0100000c,
            subtype: 0,
            data: compressed(document(dependency, version)),
          }),
        ]),
      );
      assert.throws(
        () => collectMachOCargoRuntime(options),
        /omits locked package|unknown or wrong-version/,
      );
    }
    // Same CPU, different platform: evidence for macOS cannot satisfy the iOS
    // graph, and the device/simulator platform cannot satisfy a macOS request.
    writeFileSync(
      options.executable,
      thin({ cpu: 0x0100000c, subtype: 0, platform: 2 }),
    );
    assert.throws(
      () => collectMachOCargoRuntime(options),
      /wrong or missing target/,
    );
    const ios = {
      ...options,
      targets: [{ target: "aarch64-apple-ios", features: "none" }],
    };
    assert.throws(
      () => collectMachOCargoRuntime(ios),
      /omits locked package ios-only/,
    );
    writeFileSync(
      options.executable,
      thin({
        cpu: 0x0100000c,
        subtype: 0,
        platform: 2,
        data: compressed(document("ios-only")),
      }),
    );
    assert.deepEqual(
      collectMachOCargoRuntime(ios).slices[0].packages.map((p) => p.name),
      ["fixture", "ios-only"],
    );
    writeFileSync(options.executable, binary);
    writeFileSync(
      options.cargoLock,
      Buffer.concat([readFileSync(options.cargoLock), Buffer.from("\n")]),
    );
    assert.throws(
      () => verifyMachOCargoRuntime({ ...options, binding }),
      /binding does not match/,
    );
    symlinkSync(options.executable, resolve(directory, "link"));
    assert.throws(() =>
      collectMachOCargoRuntime({
        ...options,
        executable: resolve(directory, "link"),
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const hasAppleTools = ["clang", "ld64.lld-18", "llvm-lipo-18"].every(
  (tool) =>
    spawnSync(tool, ["--version"], { timeout: 5000 }).error === undefined,
);
test(
  "real LLVM-linked thin and lipo universal Mach-O files pass the production collector without execution",
  { skip: !hasAppleTools },
  () => {
    const directory = mkdtempSync(resolve(tmpdir(), "zuuli-macho-linked-"));
    try {
      const options = project(directory);
      writeFileSync(resolve(directory, "dep.zlib"), compressed());
      writeFileSync(
        resolve(directory, "fixture.s"),
        `.text\n.globl _main\n_main:\n ret\n.section __DATA,.dep-v0\n.globl _audit\n_audit:\n.incbin "${resolve(directory, "dep.zlib")}"\n`,
      );
      const binaries = [];
      for (const [arch, triple] of [
        ["x86_64", "x86_64-apple-macos11"],
        ["arm64", "arm64-apple-macos11"],
      ]) {
        const object = resolve(directory, `${arch}.o`),
          binary = resolve(directory, arch);
        execFileSync(
          "clang",
          [
            "-target",
            triple,
            "-c",
            resolve(directory, "fixture.s"),
            "-o",
            object,
          ],
          { timeout: 30_000 },
        );
        execFileSync(
          "ld64.lld-18",
          [
            "-arch",
            arch,
            "-platform_version",
            "macos",
            "11.0",
            "11.0",
            "-e",
            "_main",
            object,
            "-o",
            binary,
          ],
          { timeout: 30_000 },
        );
        binaries.push(binary);
        const slices = extractMachOCargoEvidence(readFileSync(binary));
        const target =
          arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
        assert.equal(slices[0].target, target);
        const binding = collectMachOCargoRuntime({
          ...options,
          executable: binary,
          targets: [{ target, features: "none" }],
        });
        assert.deepEqual(
          binding.slices[0].packages.map((p) => p.name),
          ["fixture", "mac-only"],
        );
      }
      execFileSync(
        "llvm-lipo-18",
        ["-create", ...binaries, "-output", options.executable],
        { timeout: 30_000 },
      );
      const binding = collectMachOCargoRuntime(options);
      assert.deepEqual(
        verifyMachOCargoRuntime({ ...options, binding }),
        binding,
      );
      assert.equal(binding.slices.length, 2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Mach-O rejects overlapping segments/sections, mixed platforms and fat64 arithmetic mutations", () => {
  // Duplicate the segment with a differently named section: overlap detection
  // must reject the mapping even though only one section is named .dep-v0.
  const original = thin(),
    bytes = Buffer.alloc(original.length + 152);
  original.copy(bytes, 0, 0, 208);
  original.copy(bytes, 208, 32, 184);
  original.copy(bytes, 408, 256);
  bytes.writeUInt32LE(3, 16);
  bytes.writeUInt32LE(328, 20);
  for (const pos of [32, 208]) {
    bytes.writeBigUInt64LE(408n, pos + 40);
    bytes.writeUInt32LE(408, pos + 120);
  }
  bytes.fill(0, 280, 296);
  bytes.write("__other", 280);
  assert.throws(() => extractMachOCargoEvidence(bytes), /overlapping segments/);
  // Keep two sections in a single segment to exercise section overlap separately.
  const sections = Buffer.alloc(original.length + 80);
  original.copy(sections, 0, 0, 184);
  original.copy(sections, 184, 104, 184);
  original.copy(sections, 264, 184, 208);
  original.copy(sections, 336, 256);
  sections.writeUInt32LE(256, 20);
  sections.writeUInt32LE(232, 36);
  sections.writeUInt32LE(2, 96);
  sections.writeBigUInt64LE(336n, 72);
  sections.writeUInt32LE(336, 152);
  sections.writeUInt32LE(336, 232);
  sections.fill(0, 184, 200);
  sections.write("__other", 184);
  assert.throws(
    () => extractMachOCargoEvidence(sections),
    /overlapping sections/,
  );
  assert.throws(
    () =>
      extractMachOCargoEvidence(
        fat([thin(), thin({ cpu: 0x0100000c, subtype: 0, platform: 2 })]),
      ),
    /mixed platforms/,
  );
  for (const little of [false, true])
    for (const [pos, value] of [
      [16, 0xffffffffffffffffn],
      [24, 0xffffffffffffffffn],
    ]) {
      const bytes = fat([thin(), arm()], { wide: true, little });
      if (little) bytes.writeBigUInt64LE(value, pos);
      else bytes.writeBigUInt64BE(value, pos);
      assert.throws(() => extractMachOCargoEvidence(bytes), /unsafe 64-bit/);
    }
  const reserved = fat([thin(), arm()], { wide: true });
  reserved.writeUInt32BE(1, 36);
  assert.throws(() => extractMachOCargoEvidence(reserved), /reserved/);
  const caps = thin({ subtype: 0x40000003 });
  assert.throws(
    () => extractMachOCargoEvidence(caps),
    /unsupported CPU capabilities/,
  );
});

test("Mach-O collector refuses oversized sparse inputs before allocation", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "zuuli-macho-size-"));
  try {
    const options = project(directory);
    writeFileSync(options.executable, "");
    truncateSync(options.executable, 256 * 1024 * 1024 + 1);
    assert.throws(
      () => collectMachOCargoRuntime(options),
      /bounded regular executable/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const hasElfTools = ["cc", "objcopy"].every(
  (tool) => spawnSync(tool, ["--version"], { timeout: 5000 }).status === 0,
);
test(
  "shared decoder retains real ELF extraction and rejects trailing zlib bytes through Linux collector",
  { skip: !hasElfTools || process.platform !== "linux" },
  () => {
    const directory = mkdtempSync(resolve(tmpdir(), "zuuli-elf-decoder-"));
    try {
      const options = project(directory);
      const binary = resolve(directory, "usr/bin/zuuli"),
        base = resolve(directory, "base"),
        section = resolve(directory, "dep.zlib");
      mkdirSync(resolve(directory, "usr/bin"), { recursive: true });
      execFileSync("cc", ["-x", "c", "-o", base, "-"], {
        input: "int main(void) { return 0; }\n",
        timeout: 30_000,
      });
      const data = compressed({
        format: 8,
        packages: [
          { name: "fixture", version: "0.1.0", source: "local", root: true },
        ],
      });
      const collect = () =>
        collectLinuxCargoRuntime({
          root: directory,
          cargoManifest: options.cargoManifest,
          cargoLock: options.cargoLock,
          cargoTarget: "x86_64-unknown-linux-gnu",
          cargoFeatures: "none",
        });
      writeFileSync(section, data);
      execFileSync(
        "objcopy",
        ["--add-section", `.dep-v0=${section}`, base, binary],
        { timeout: 30_000 },
      );
      const runtime = collect();
      assert.equal(runtime.binding.evidence.compressedSha256, sha(data));
      assert.deepEqual(
        runtime.packages.map((p) => p.name),
        ["fixture"],
      );
      writeFileSync(section, Buffer.concat([data, Buffer.from([0])]));
      execFileSync(
        "objcopy",
        ["--add-section", `.dep-v0=${section}`, base, binary],
        { timeout: 30_000 },
      );
      assert.throws(collect, /bounded valid zlib/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
