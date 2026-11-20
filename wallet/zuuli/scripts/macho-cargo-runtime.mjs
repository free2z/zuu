// Read-only groundwork for #379. No release/signing workflow calls this yet.
// cargo-auditable 0.7.5 src/object_file.rs uses StandardSegment::Data and
// section `.dep-v0`; its checksum is pinned in install-cargo-auditable.sh.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  decodeCargoAuditEvidence,
  expectedRuntimeGraph,
  reconcileRuntimePackages,
} from "./linux-cargo-runtime.mjs";

const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024 * 1024;
const TARGETS = new Map([
  ["16777223:3:1", "x86_64-apple-darwin"],
  ["16777228:0:1", "aarch64-apple-darwin"],
  ["16777228:0:2", "aarch64-apple-ios"],
  ["16777223:3:7", "x86_64-apple-ios"],
  ["16777228:0:7", "aarch64-apple-ios-sim"],
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fail(message) {
  throw new Error(`Mach-O Cargo evidence: ${message}`);
}
function range(offset, size, limit, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > limit ||
    size > limit - offset
  ) {
    fail(`${label} is out of bounds`);
  }
}
function u64(bytes, offset, little = true) {
  const value = little
    ? bytes.readBigUInt64LE(offset)
    : bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    fail("unsafe 64-bit offset or size");
  return Number(value);
}
function name(bytes, offset) {
  const field = bytes.subarray(offset, offset + 16);
  if (field.some((byte) => byte > 127)) fail("non-ASCII section/segment name");
  const end = field.indexOf(0);
  if (end !== -1 && field.subarray(end).some((byte) => byte !== 0))
    fail("noncanonical section/segment name");
  return field.subarray(0, end === -1 ? 16 : end).toString("ascii");
}
function thin(bytes, outer) {
  range(0, 32, bytes.length, "64-bit header");
  if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(12) !== 2) {
    fail("expected a little-endian 64-bit MH_EXECUTE image");
  }
  const cpu = bytes.readUInt32LE(4),
    subtype = bytes.readUInt32LE(8);
  if (outer && (outer.cpu !== cpu || outer.subtype !== subtype))
    fail("fat/header CPU mismatch");
  const count = bytes.readUInt32LE(16),
    commandBytes = bytes.readUInt32LE(20);
  if (count === 0 || count > 4096 || commandBytes > MAX_COMMAND_BYTES)
    fail("unbounded load commands");
  range(32, commandBytes, bytes.length, "load commands");
  const commandEnd = 32 + commandBytes;
  let cursor = 32,
    platform,
    evidence;
  const segments = [],
    sections = [];
  for (let index = 0; index < count; index++) {
    range(cursor, 8, commandEnd, "load command header");
    const cmd = bytes.readUInt32LE(cursor),
      size = bytes.readUInt32LE(cursor + 4);
    if (size < 8 || size % 8 !== 0) fail("invalid load command size");
    range(cursor, size, commandEnd, "load command");
    if (cmd === 0x32) {
      // LC_BUILD_VERSION distinguishes device/simulator/macOS.
      if (size < 24 || size !== 24 + 8 * bytes.readUInt32LE(cursor + 20))
        fail("invalid build version command");
      if (platform !== undefined) fail("duplicate platform command");
      platform = bytes.readUInt32LE(cursor + 8);
    } else if ([0x24, 0x25, 0x2f, 0x30].includes(cmd)) {
      // Intentionally narrow: no inference from an old SDK/minimum OS command.
      fail("legacy platform command is unsupported");
    } else if (cmd === 0x19) {
      // LC_SEGMENT_64
      if (size < 72) fail("truncated segment command");
      const nsects = bytes.readUInt32LE(cursor + 64);
      if (size !== 72 + nsects * 80) fail("invalid section table size");
      const segmentName = name(bytes, cursor + 8);
      const fileoff = u64(bytes, cursor + 40),
        filesize = u64(bytes, cursor + 48);
      range(fileoff, filesize, bytes.length, "segment file range");
      if (filesize) segments.push([fileoff, fileoff + filesize]);
      for (let i = 0; i < nsects; i++) {
        const pos = cursor + 72 + i * 80;
        const sectionName = name(bytes, pos),
          sectionSegment = name(bytes, pos + 16);
        if (sectionSegment !== segmentName)
          fail("section/segment name mismatch");
        const length = u64(bytes, pos + 40),
          offset = bytes.readUInt32LE(pos + 48);
        const flags = bytes.readUInt32LE(pos + 64),
          type = flags & 0xff;
        const zeroFill = [1, 0xc, 0x12].includes(type);
        if (!zeroFill && length) {
          range(offset, length, bytes.length, "section data");
          if (
            offset < commandEnd ||
            offset < fileoff ||
            length > fileoff + filesize - offset
          )
            fail("section escapes segment or overlaps commands");
          sections.push([offset, offset + length]);
        }
        if (sectionName === ".dep-v0") {
          if (evidence) fail("duplicate .dep-v0 section");
          if (
            segmentName !== "__DATA" ||
            type !== 0 ||
            length === 0 ||
            length > 1024 * 1024
          )
            fail("invalid .dep-v0 section");
          evidence = { offset, bytes: length };
        }
      }
    }
    cursor += size;
  }
  if (cursor !== commandEnd) fail("load command count/size mismatch");
  for (const [label, ranges] of [
    ["segments", segments],
    ["sections", sections],
  ]) {
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++)
      if (ranges[i][0] < ranges[i - 1][1]) fail(`overlapping ${label}`);
  }
  // x86_64 linkers may set CPU_SUBTYPE_LIB64 (0x80000000). No other
  // capability/subtype is silently treated as baseline arm64/x86_64.
  const baselineSubtype = subtype & 0x00ffffff;
  const capabilities = (subtype & 0xff000000) >>> 0;
  if (
    capabilities !== 0 &&
    !(cpu === 0x01000007 && capabilities === 0x80000000)
  )
    fail("unsupported CPU capabilities");
  const target = TARGETS.get(`${cpu}:${baselineSubtype}:${platform}`);
  if (!target)
    fail("unsupported CPU/subtype/platform or missing platform command");
  if (!evidence) fail("missing .dep-v0 evidence");
  return {
    target,
    cpu,
    subtype,
    platform,
    section: evidence,
    evidence: decodeCargoAuditEvidence(
      bytes.subarray(evidence.offset, evidence.offset + evidence.bytes),
    ),
  };
}

// No artifact execution, mounting, signing, external parser, or source sidecar.
export function extractMachOCargoEvidence(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 4 ||
    bytes.length > MAX_BINARY_BYTES
  )
    fail("invalid binary size");
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcffaedfe)
    return [
      { offset: 0, bytes: bytes.length, sha256: hash(bytes), ...thin(bytes) },
    ];
  const little = [0xbebafeca, 0xbfbafeca].includes(magic);
  const wide = [0xcafebabf, 0xbfbafeca].includes(magic);
  if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic))
    fail("unsupported magic");
  range(0, 8, bytes.length, "fat header");
  const read32 = (pos) =>
    little ? bytes.readUInt32LE(pos) : bytes.readUInt32BE(pos);
  const count = read32(4),
    stride = wide ? 32 : 20;
  if (count === 0 || count > 8) fail("unbounded fat slice count");
  const tableEnd = 8 + count * stride;
  range(8, count * stride, bytes.length, "fat table");
  const descriptors = [];
  for (let i = 0; i < count; i++) {
    const pos = 8 + i * stride;
    const offset = wide ? u64(bytes, pos + 8, little) : read32(pos + 8);
    const size = wide ? u64(bytes, pos + 16, little) : read32(pos + 12);
    const alignment = read32(pos + (wide ? 24 : 16));
    range(offset, size, bytes.length, "fat slice");
    if (
      size < 32 ||
      offset < tableEnd ||
      alignment > 30 ||
      offset % 2 ** alignment !== 0
    )
      fail("invalid fat slice placement");
    if (wide && read32(pos + 28) !== 0) fail("nonzero fat reserved field");
    descriptors.push({
      offset,
      bytes: size,
      cpu: read32(pos),
      subtype: read32(pos + 4),
    });
  }
  const ordered = [...descriptors].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i].offset < ordered[i - 1].offset + ordered[i - 1].bytes)
      fail("overlapping fat slices");
  const slices = descriptors.map((entry) => {
    const slice = bytes.subarray(entry.offset, entry.offset + entry.bytes);
    return {
      offset: entry.offset,
      bytes: entry.bytes,
      sha256: hash(slice),
      ...thin(slice, entry),
    };
  });
  if (new Set(slices.map((slice) => slice.target)).size !== slices.length)
    fail("duplicate fat target");
  if (new Set(slices.map((slice) => slice.platform)).size !== 1)
    fail("mixed platforms in fat image");
  return slices;
}

export function collectMachOCargoRuntime({
  executable,
  cargoLock,
  cargoManifest,
  targets,
  execute = execFileSync,
}) {
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.length > 8 ||
    new Set(targets.map((entry) => entry.target)).size !== targets.length ||
    targets.some((entry) => ![...TARGETS.values()].includes(entry.target))
  )
    fail("invalid expected targets");
  // Bound allocation before reading; O_NOFOLLOW rejects a symlink as the input.
  const fd = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BINARY_BYTES)
      fail("expected bounded regular executable");
    bytes = Buffer.alloc(stat.size);
    let position = 0;
    while (position < bytes.length) {
      const count = readSync(
        fd,
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (!count) fail("executable changed during read");
      position += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, position) !== 0)
      fail("executable changed during read");
  } finally {
    closeSync(fd);
  }
  const slices = extractMachOCargoEvidence(bytes);
  if (
    slices.length !== targets.length ||
    slices.some(
      (slice) => !targets.some((entry) => entry.target === slice.target),
    )
  )
    fail("wrong or missing target slice");
  const results = slices
    .map((slice) => {
      const options = targets.find((entry) => entry.target === slice.target);
      const expected = expectedRuntimeGraph({
        cargoLock,
        cargoManifest,
        target: slice.target,
        features: options.features,
        execute,
      });
      const packages = reconcileRuntimePackages(slice.evidence, expected);
      const { document, ...evidence } = slice.evidence;
      return {
        target: slice.target,
        features: expected.graph.features,
        cargoLock: expected.lock,
        offset: slice.offset,
        bytes: slice.bytes,
        sha256: slice.sha256,
        cpu: slice.cpu,
        subtype: slice.subtype,
        platform: slice.platform,
        section: slice.section,
        evidence: {
          ...evidence,
          format: document.format,
          runtimePackages: packages.length,
          graphSha256: expected.sha256,
        },
        packages,
      };
    })
    .sort((a, b) => a.target.localeCompare(b.target));
  return {
    schemaVersion: 1,
    executable: { bytes: bytes.length, sha256: hash(bytes) },
    slices: results,
  };
}

export function verifyMachOCargoRuntime({ binding, ...options }) {
  const actual = collectMachOCargoRuntime(options);
  if (JSON.stringify(binding) !== JSON.stringify(actual))
    fail(
      "binding does not match exact executable, slices, evidence and locked graphs",
    );
  return actual;
}
