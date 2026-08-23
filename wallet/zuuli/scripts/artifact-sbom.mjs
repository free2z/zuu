#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  linkSync,
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
  writeSync,
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
  posix,
} from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const INVENTORY_SCOPE = "free2z:inventory-scope";
const ARTIFACT_NAME = "free2z:artifact-name";
const ARTIFACT_SHA256 = "free2z:artifact-sha256";
const ARTIFACT_BYTES = "free2z:artifact-bytes";
const ARTIFACT_PATH = "free2z:artifact:path";
const ARTIFACT_KIND = "free2z:artifact:kind";
const ARTIFACT_FILE_BYTES = "free2z:artifact:file-bytes";
const ARTIFACT_LINK_TARGET = "free2z:artifact:link-target";
const PACKAGE_METADATA_FORMAT = "free2z:artifact-package:format";
const PACKAGE_METADATA_SHA256 = "free2z:artifact-package:metadata-sha256";
const PACKAGE_METADATA_FIELD = "free2z:artifact-package:field:";
const SOURCE_ROOT = "free2z:source-root";
const SOURCE_COMMIT = "free2z:source-commit";
const PACKAGE_METADATA_PATH = ".free2z-package-metadata.json";

// Mobile stores reject packages anywhere near these ceilings. Enforcing them
// before extraction also keeps a corrupt or hostile ZIP from exhausting a CI
// runner while the SBOM boundary is being checked.
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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
  const listing = decodeUtf8(
    execFileSync("unzip", ["-Z1", artifact], {
      maxBuffer: 64 * 1024 * 1024,
    }),
    "ZIP member listing",
  );
  const members = validateArchiveMembers(listing.split("\n").filter(Boolean));
  const totals = decodeUtf8(
    execFileSync("unzip", ["-Z", "-t", artifact], {
      maxBuffer: 1024 * 1024,
    }),
    "ZIP resource totals",
  ).trim();
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
  { allowExternalSymlinks = false, excludedFiles = [] } = {},
) {
  const root = realpathSync(rootPath);
  const excluded = new Set(excludedFiles);
  const entries = [];
  let memberCount = 0;
  let regularBytes = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      memberCount += 1;
      if (memberCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error(
          `artifact has too many entries: more than ${MAX_ARCHIVE_ENTRIES}`,
        );
      }
      if (!safeArchiveMember(path)) {
        throw new Error(
          `unsafe unpacked artifact path: ${JSON.stringify(path)}`,
        );
      }
      const info = lstatSync(absolute);
      if (excluded.has(path)) {
        if (!info.isFile()) {
          throw new Error(`excluded scan metadata must be a file: ${path}`);
        }
        continue;
      }
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
  if (lower.endsWith(".appimage")) return "appimage";
  if (lower.endsWith(".deb")) return "deb";
  if (lower.endsWith(".rpm")) return "rpm";
  const extension = lower.split(".").at(-1);
  if (["aab", "ipa", "zip"].includes(extension)) return "zip";
  throw new Error(`unsupported artifact format .${extension}`);
}

function checkedAdd(left, right, label) {
  return safeInteger(BigInt(left) + BigInt(right), label);
}

function checkedMultiply(left, right, label) {
  return safeInteger(BigInt(left) * BigInt(right), label);
}

function readExactly(descriptor, length, position, label) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(
      descriptor,
      buffer,
      read,
      length - read,
      checkedAdd(position, read, `${label} read offset`),
    );
    if (count === 0) throw new Error(`${label} is truncated`);
    read += count;
  }
  return buffer;
}

function safeInteger(value, label) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} exceeds the safe integer range`);
    }
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function decodeUtf8(buffer, label) {
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

export function appImagePayloadOffset(artifact) {
  const descriptor = openSync(artifact, "r");
  try {
    const header = readExactly(descriptor, 64, 0, "AppImage ELF header");
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error("AppImage must start with an ELF header");
    }
    if (header[5] !== 1 || header[6] !== 1) {
      throw new Error("AppImage ELF must use current little-endian encoding");
    }
    if (header[8] !== 0x41 || header[9] !== 0x49 || header[10] !== 0x02) {
      throw new Error("AppImage ELF is missing the Type 2 AI magic");
    }

    let sectionTableOffset;
    let sectionHeaderSize;
    let sectionCount;
    let sectionOffsetField;
    let sectionSizeField;
    if (header[4] === 2) {
      sectionTableOffset = safeInteger(
        header.readBigUInt64LE(40),
        "ELF section table offset",
      );
      sectionHeaderSize = header.readUInt16LE(58);
      sectionCount = header.readUInt16LE(60);
      sectionOffsetField = 24;
      sectionSizeField = 32;
      if (header.readUInt16LE(52) !== 64 || sectionHeaderSize < 64) {
        throw new Error("AppImage has an invalid ELF64 header layout");
      }
    } else if (header[4] === 1) {
      sectionTableOffset = header.readUInt32LE(32);
      sectionHeaderSize = header.readUInt16LE(46);
      sectionCount = header.readUInt16LE(48);
      sectionOffsetField = 16;
      sectionSizeField = 20;
      if (header.readUInt16LE(40) !== 52 || sectionHeaderSize < 40) {
        throw new Error("AppImage has an invalid ELF32 header layout");
      }
    } else {
      throw new Error("AppImage has an unsupported ELF class");
    }
    if (sectionTableOffset === 0 || sectionCount === 0) {
      throw new Error("AppImage ELF must retain its section table");
    }
    const sectionTableSize = checkedMultiply(
      sectionHeaderSize,
      sectionCount,
      "ELF section table size",
    );
    const sectionTableEnd = checkedAdd(
      sectionTableOffset,
      sectionTableSize,
      "ELF section table end",
    );
    let offset = sectionTableEnd;
    for (let index = 0; index < sectionCount; index += 1) {
      const headerOffset = checkedAdd(
        sectionTableOffset,
        checkedMultiply(
          sectionHeaderSize,
          index,
          `ELF section ${index} header index`,
        ),
        `ELF section ${index} header offset`,
      );
      const section = readExactly(
        descriptor,
        sectionHeaderSize,
        headerOffset,
        `ELF section ${index} header`,
      );
      // SHT_NOBITS sections (most commonly .bss) occupy memory but have no
      // bytes in the ELF file. Their sh_offset + sh_size may extend beyond
      // the appended AppImage payload and therefore cannot contribute to the
      // file-backed ELF boundary.
      if (section.readUInt32LE(4) === 8) continue;
      const sectionOffset =
        header[4] === 2
          ? safeInteger(
              section.readBigUInt64LE(sectionOffsetField),
              `ELF section ${index} offset`,
            )
          : section.readUInt32LE(sectionOffsetField);
      const sectionSize =
        header[4] === 2
          ? safeInteger(
              section.readBigUInt64LE(sectionSizeField),
              `ELF section ${index} size`,
            )
          : section.readUInt32LE(sectionSizeField);
      offset = Math.max(
        offset,
        checkedAdd(sectionOffset, sectionSize, `ELF section ${index} extent`),
      );
    }
    const superblock = readExactly(
      descriptor,
      96,
      offset,
      "AppImage SquashFS superblock",
    );
    if (superblock.readUInt32LE(0) !== 0x73717368) {
      throw new Error("AppImage payload does not begin with SquashFS magic");
    }
    if (superblock.readUInt16LE(28) !== 4) {
      throw new Error("AppImage must contain a SquashFS v4 payload");
    }
    const bytesUsed = safeInteger(
      superblock.readBigUInt64LE(40),
      "SquashFS bytes-used field",
    );
    const payloadEnd = checkedAdd(offset, bytesUsed, "SquashFS payload end");
    if (bytesUsed < 96 || payloadEnd > fstatSync(descriptor).size) {
      throw new Error(
        "AppImage SquashFS payload exceeds the artifact boundary",
      );
    }
    return offset;
  } finally {
    closeSync(descriptor);
  }
}

function logicalLinkTarget(path, target) {
  if (
    target.length === 0 ||
    target.includes("\\") ||
    target.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(target)
  ) {
    throw new Error(
      `artifact symlink must have a safe relative target: ${path}`,
    );
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    resolved.startsWith("/")
  ) {
    throw new Error(`artifact symlink escapes payload: ${path} -> ${target}`);
  }
}

export function validateLogicalEntries(entries) {
  if (entries.length === 0) throw new Error("artifact payload is empty");
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`artifact has too many entries: ${entries.length}`);
  }
  const kinds = new Map();
  let regularBytes = 0;
  for (const entry of entries) {
    if (!safeArchiveMember(entry.path)) {
      throw new Error(`unsafe artifact member ${JSON.stringify(entry.path)}`);
    }
    if (kinds.has(entry.path)) {
      throw new Error(
        `duplicate artifact member ${JSON.stringify(entry.path)}`,
      );
    }
    kinds.set(entry.path, entry.kind);
    if (entry.kind === "regular") {
      regularBytes += entry.size;
      if (regularBytes > MAX_UNPACKED_BYTES) {
        throw new Error(
          `artifact expands beyond the ${MAX_UNPACKED_BYTES}-byte safety limit`,
        );
      }
    } else if (entry.kind === "symlink") {
      logicalLinkTarget(entry.path, entry.target);
    }
  }
  for (const entry of entries) {
    let parent = posix.dirname(entry.path);
    while (parent !== ".") {
      const parentKind = kinds.get(parent);
      if (parentKind && parentKind !== "directory") {
        throw new Error(
          `artifact member descends through non-directory ${parent}`,
        );
      }
      parent = posix.dirname(parent);
    }
  }
}

function listAppImagePayload(artifact, offset) {
  const outputBytes = execFileSync(
    "unsquashfs",
    ["-lln", "-full-precision", "-UTC", "-quiet", "-o", `${offset}`, artifact],
    { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );
  const output = decodeUtf8(outputBytes, "SquashFS member listing");
  const entries = [];
  for (const line of output.trimEnd().split("\n")) {
    const match =
      /^([dl-])\S*\s+\d+\/\d+\s+(\d+)\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} squashfs-root(?:\/(.*))?$/.exec(
        line,
      );
    if (!match)
      throw new Error(
        `unparseable SquashFS member listing: ${JSON.stringify(line)}`,
      );
    if (match[3] === undefined) continue;
    let path = match[3];
    const kind =
      match[1] === "d" ? "directory" : match[1] === "l" ? "symlink" : "regular";
    let target;
    if (kind === "symlink") {
      const delimiter = path.lastIndexOf(" -> ");
      if (delimiter < 1 || path.indexOf(" -> ") !== delimiter) {
        throw new Error(
          `ambiguous SquashFS symlink listing: ${JSON.stringify(path)}`,
        );
      }
      target = path.slice(delimiter + 4);
      path = path.slice(0, delimiter);
    }
    entries.push({ path, kind, size: Number(match[2]), target });
  }
  validateLogicalEntries(entries);
  return entries;
}

function extractAppImage(artifact, root) {
  const offset = appImagePayloadOffset(artifact);
  const readelf = decodeUtf8(
    execFileSync("readelf", ["-hW", artifact], {
      timeout: 120_000,
      env: { ...process.env, LC_ALL: "C" },
    }),
    "readelf output",
  );
  if (!/^\s*Class:\s+ELF(?:32|64)$/m.test(readelf)) {
    throw new Error("readelf did not confirm the AppImage ELF class");
  }
  const listed = listAppImagePayload(artifact, offset);
  execFileSync(
    "unsquashfs",
    [
      "-strict-errors",
      "-no-xattrs",
      "-no-progress",
      "-d",
      root,
      "-o",
      `${offset}`,
      artifact,
    ],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
  );
  const actual = new Map(
    inventoryRoot(root).map((entry) => [entry.path, entry]),
  );
  const expected = listed.filter((entry) => entry.kind !== "directory");
  if (actual.size !== expected.length) {
    throw new Error(
      "SquashFS extraction does not match its reviewed member listing",
    );
  }
  for (const entry of expected) {
    const unpacked = actual.get(entry.path);
    if (
      !unpacked ||
      unpacked.kind !== entry.kind ||
      (entry.kind === "regular" && unpacked.bytes !== entry.size) ||
      (entry.kind === "symlink" && unpacked.target !== entry.target)
    ) {
      throw new Error(
        `SquashFS extraction changed reviewed member ${entry.path}`,
      );
    }
  }
}

function tarText(buffer, label = "tar text field") {
  const nul = buffer.indexOf(0);
  return decodeUtf8(buffer.subarray(0, nul < 0 ? buffer.length : nul), label);
}

function tarNumber(buffer, label) {
  if ((buffer[0] & 0x80) !== 0) {
    throw new Error(`${label} uses unsupported base-256 tar encoding`);
  }
  const text = tarText(buffer).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text))
    throw new Error(`${label} is not a valid tar octal number`);
  return safeInteger(Number.parseInt(text, 8), label);
}

function tarChecksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

function normalizeTarPath(value) {
  while (value.startsWith("./")) value = value.slice(2);
  if (value.endsWith("/")) value = value.slice(0, -1);
  if (value === "" || value === ".") return ".";
  if (!safeArchiveMember(value)) {
    throw new Error(`unsafe tar member ${JSON.stringify(value)}`);
  }
  return value;
}

function parsePax(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error("invalid PAX record length");
    const lengthText = buffer.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText))
      throw new Error("invalid PAX record length");
    const length = Number(lengthText);
    const end = checkedAdd(offset, length, "PAX record end");
    if (
      !Number.isSafeInteger(length) ||
      end > buffer.length ||
      buffer[end - 1] !== 0x0a
    ) {
      throw new Error("truncated PAX record");
    }
    const record = decodeUtf8(
      buffer.subarray(space + 1, end - 1),
      "PAX record",
    );
    const equals = record.indexOf("=");
    if (equals < 1) throw new Error("invalid PAX record");
    fields.set(record.slice(0, equals), record.slice(equals + 1));
    offset = end;
  }
  return fields;
}

function paxDecimal(value, label) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must use canonical decimal digits`);
  }
  return safeInteger(Number(value), label);
}

function parseTarArchive(archive) {
  const descriptor = openSync(archive, "r");
  const entries = [];
  let position = 0;
  let zeroBlocks = 0;
  let nextPax = new Map();
  const globalPax = new Map();
  let longName;
  let longLink;
  try {
    const archiveSize = fstatSync(descriptor).size;
    while (position < archiveSize) {
      const header = readExactly(descriptor, 512, position, "tar header");
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        position = checkedAdd(position, 512, "next tar end-marker offset");
        continue;
      }
      if (zeroBlocks > 0)
        throw new Error("tar archive has data after its end marker");
      const expectedChecksum = tarNumber(
        header.subarray(148, 156),
        "tar checksum",
      );
      if (tarChecksum(header) !== expectedChecksum)
        throw new Error("tar header checksum mismatch");
      const type = String.fromCharCode(header[156] || 0x30);
      const headerSize = tarNumber(
        header.subarray(124, 136),
        "tar member size",
      );
      const dataOffset = checkedAdd(position, 512, "tar member data offset");
      const paddedSize = checkedMultiply(
        Math.ceil(headerSize / 512),
        512,
        "padded tar member size",
      );
      const nextPosition = checkedAdd(
        dataOffset,
        paddedSize,
        "next tar member offset",
      );
      if (nextPosition > archiveSize)
        throw new Error("tar member exceeds archive boundary");
      const rawName = tarText(header.subarray(0, 100));
      const prefix = tarText(header.subarray(345, 500));
      const headerName = prefix ? `${prefix}/${rawName}` : rawName;
      if (["x", "g", "L", "K"].includes(type)) {
        if (headerSize > 1024 * 1024)
          throw new Error("tar metadata record is too large");
        const data = readExactly(
          descriptor,
          headerSize,
          dataOffset,
          "tar metadata record",
        );
        if (type === "x") nextPax = parsePax(data);
        else if (type === "g") {
          for (const [key, value] of parsePax(data)) globalPax.set(key, value);
        } else if (type === "L") longName = tarText(data);
        else longLink = tarText(data);
        position = nextPosition;
        continue;
      }
      const pax = new Map([...globalPax, ...nextPax]);
      const paxSize = pax.get("size");
      const size =
        paxSize === undefined
          ? headerSize
          : paxDecimal(paxSize, "PAX member size");
      if (size !== headerSize)
        throw new Error("PAX size does not match the tar data boundary");
      const name = normalizeTarPath(pax.get("path") ?? longName ?? headerName);
      const linkTarget =
        pax.get("linkpath") ?? longLink ?? tarText(header.subarray(157, 257));
      nextPax = new Map();
      longName = undefined;
      longLink = undefined;
      const kind = ["0", "7"].includes(type)
        ? "regular"
        : type === "5"
          ? "directory"
          : type === "2"
            ? "symlink"
            : type === "1"
              ? "hardlink"
              : undefined;
      if (!kind)
        throw new Error(
          `unsupported tar member type ${JSON.stringify(type)}: ${name}`,
        );
      if (kind !== "regular" && size !== 0)
        throw new Error(`non-file tar member has data: ${name}`);
      if (name === ".") {
        if (kind !== "directory")
          throw new Error("tar root entry must be a directory");
        position = nextPosition;
        continue;
      }
      entries.push({
        path: name,
        kind,
        size,
        mode: tarNumber(header.subarray(100, 108), "tar member mode") & 0o777,
        target: linkTarget,
        dataOffset,
      });
      position = nextPosition;
    }
    if (zeroBlocks < 2)
      throw new Error("tar archive is missing its two-block end marker");
    if (nextPax.size > 0 || longName !== undefined || longLink !== undefined) {
      throw new Error("tar archive ends with unconsumed metadata");
    }
    validateLogicalEntries(entries);
    return { descriptor, entries };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function extractTarArchive(archive, root) {
  const parsed = parseTarArchive(archive);
  try {
    mkdirSync(root);
    for (const entry of parsed.entries.filter(
      (entry) => entry.kind === "directory",
    )) {
      const destination = resolve(root, ...entry.path.split("/"));
      // Keep directories writable while descendants are materialized. Their
      // shipped modes are restored deepest-first after files and links exist.
      mkdirSync(destination, { recursive: true, mode: 0o755 });
    }
    for (const entry of parsed.entries.filter(
      (entry) => entry.kind === "regular",
    )) {
      const destination = resolve(root, ...entry.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      const output = openSync(destination, "wx", entry.mode);
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let copied = 0;
        while (copied < entry.size) {
          const count = Math.min(buffer.length, entry.size - copied);
          const chunk = readExactly(
            parsed.descriptor,
            count,
            entry.dataOffset + copied,
            "tar member data",
          );
          let written = 0;
          while (written < chunk.length) {
            written += writeSync(
              output,
              chunk,
              written,
              chunk.length - written,
            );
          }
          copied += count;
        }
      } finally {
        closeSync(output);
      }
      chmodSync(destination, entry.mode);
    }
    const hardlinks = parsed.entries.filter(
      (entry) => entry.kind === "hardlink",
    );
    for (const entry of hardlinks) {
      const target = normalizeTarPath(entry.target);
      const targetEntry = parsed.entries.find(
        (candidate) => candidate.path === target,
      );
      if (!targetEntry || targetEntry.kind !== "regular") {
        throw new Error(
          `tar hardlink target is not a shipped regular file: ${entry.path}`,
        );
      }
      const destination = resolve(root, ...entry.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      linkSync(resolve(root, ...target.split("/")), destination);
    }
    for (const entry of parsed.entries.filter(
      (entry) => entry.kind === "symlink",
    )) {
      const destination = resolve(root, ...entry.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(entry.target, destination);
    }
    for (const entry of parsed.entries
      .filter((candidate) => candidate.kind === "directory")
      .sort((left, right) => right.path.length - left.path.length)) {
      chmodSync(resolve(root, ...entry.path.split("/")), entry.mode);
    }
  } finally {
    closeSync(parsed.descriptor);
  }
}

function normalizedMetadataText(buffer, label) {
  const text = decodeUtf8(buffer, label).replaceAll("\r\n", "\n");
  if (text.includes("\r") || /\u0000/.test(text)) {
    throw new Error(`${label} contains unsupported control bytes`);
  }
  return text.replace(/\n+$/, "");
}

function debPackageMetadata(artifact) {
  const control = normalizedMetadataText(
    execFileSync("dpkg-deb", ["--field", artifact], {
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    }),
    "deb control metadata",
  );
  const fields = new Map();
  let current;
  for (const line of control.split("\n")) {
    if (/^[ \t]/.test(line)) {
      if (!current) throw new Error("deb control continuation has no field");
      fields.set(current, `${fields.get(current)}\n${line.slice(1)}`);
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]?(.*)$/.exec(line);
    if (!match) throw new Error("deb control metadata is not canonical");
    if (fields.has(match[1])) {
      throw new Error(`deb control metadata repeats ${match[1]}`);
    }
    current = match[1];
    fields.set(current, match[2]);
  }
  for (const required of ["Package", "Version", "Architecture"]) {
    if (!fields.get(required)) {
      throw new Error(`deb control metadata is missing ${required}`);
    }
  }
  return {
    schemaVersion: 1,
    format: "deb",
    fields: Object.fromEntries(
      [...fields].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  };
}

const RPM_METADATA_TAGS = [
  ["name", "NAME"],
  ["epoch", "EPOCHNUM"],
  ["version", "VERSION"],
  ["release", "RELEASE"],
  ["architecture", "ARCH"],
  ["license", "LICENSE"],
  ["summary", "SUMMARY"],
  ["vendor", "VENDOR"],
  ["packager", "PACKAGER"],
  ["url", "URL"],
  ["sourceRpm", "SOURCERPM"],
];

function rpmPackageMetadata(artifact) {
  const fields = {};
  for (const [name, tag] of RPM_METADATA_TAGS) {
    const value = normalizedMetadataText(
      execFileSync(
        "rpm",
        ["--noplugins", "-qp", `--queryformat=%{${tag}}`, artifact],
        {
          env: { ...process.env, LC_ALL: "C" },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 120_000,
        },
      ),
      `RPM ${tag} header`,
    );
    if (value !== "(none)") fields[name] = value;
  }
  for (const required of ["name", "version", "release", "architecture"]) {
    if (!fields[required]) throw new Error(`RPM header is missing ${required}`);
  }
  return { schemaVersion: 1, format: "rpm", fields };
}

function packageMetadataForArtifact(
  artifact,
  format = artifactFormat(artifact),
) {
  if (format === "deb") return debPackageMetadata(artifact);
  if (format === "rpm") return rpmPackageMetadata(artifact);
  return undefined;
}

function validatePackageMetadata(metadata, expectedFormat) {
  if (
    !metadata ||
    Array.isArray(metadata) ||
    metadata.schemaVersion !== 1 ||
    metadata.format !== expectedFormat ||
    !metadata.fields ||
    Array.isArray(metadata.fields) ||
    typeof metadata.fields !== "object"
  ) {
    throw new Error(`invalid ${expectedFormat} package metadata sidecar`);
  }
  for (const [name, value] of Object.entries(metadata.fields)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name) ||
      typeof value !== "string" ||
      /\u0000|\r/.test(value)
    ) {
      throw new Error(`invalid ${expectedFormat} package metadata field`);
    }
  }
  return metadata;
}

function readPackageMetadata(root, format) {
  if (!packageMetadataForArtifactFormat(format)) return undefined;
  return validatePackageMetadata(
    parseJson(resolve(root, PACKAGE_METADATA_PATH), "package metadata sidecar"),
    format,
  );
}

function packageMetadataForArtifactFormat(format) {
  return format === "deb" || format === "rpm";
}

function artifactInventoryOptions(artifact) {
  const format = artifactFormat(artifact);
  return {
    allowExternalSymlinks: format === "dmg",
    excludedFiles: packageMetadataForArtifactFormat(format)
      ? [PACKAGE_METADATA_PATH]
      : [],
  };
}

function extractLinuxPackage(artifact, root, format) {
  const temporary = mkdtempSync(resolve(tmpdir(), `zuuli-${format}-payload-`));
  const archive = resolve(temporary, "payload.tar");
  const output = openSync(archive, "wx", 0o600);
  const packageMetadata = packageMetadataForArtifact(artifact, format);
  try {
    try {
      if (format === "deb") {
        execFileSync("dpkg-deb", ["--fsys-tarfile", artifact], {
          env: { ...process.env, LC_ALL: "C" },
          stdio: ["ignore", output, "pipe"],
          timeout: 120_000,
        });
      } else {
        execFileSync("rpm2archive", ["-n", artifact], {
          env: { ...process.env, LC_ALL: "C" },
          stdio: ["ignore", output, "pipe"],
          timeout: 120_000,
        });
      }
    } finally {
      closeSync(output);
    }
    if (lstatSync(archive).size > MAX_UNPACKED_BYTES) {
      throw new Error(
        `package payload archive exceeds the ${MAX_UNPACKED_BYTES}-byte safety limit`,
      );
    }
    extractTarArchive(archive, root);
    canonicalWrite(resolve(root, PACKAGE_METADATA_PATH), packageMetadata);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
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

export function extractDmg(artifact, root, { execute = execFileSync } = {}) {
  const temporary = mkdtempSync(resolve(tmpdir(), "zuuli-dmg-mount-"));
  const mountpoint = resolve(temporary, "mount");
  mkdirSync(mountpoint);
  let attachAttempted = false;
  try {
    // Treat the mount as live from the instant attach starts. `hdiutil` can
    // time out or return non-zero after DiskImages has already mounted the
    // filesystem, so a successful process exit is not a safe cleanup signal.
    attachAttempted = true;
    execute(
      "hdiutil",
      ["attach", artifact, "-readonly", "-nobrowse", "-mountpoint", mountpoint],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
    );
    cloneMountedTree(mountpoint, root);
  } finally {
    let detached = !attachAttempted;
    if (attachAttempted) {
      try {
        execute("hdiutil", ["detach", mountpoint], {
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 120_000,
        });
        detached = true;
      } catch {
        try {
          // Spotlight or Finder can briefly hold a newly mounted image. This
          // mount is private and read-only, so a bounded forced detach is the
          // safe fallback used by the release verifier too.
          execute("hdiutil", ["detach", mountpoint, "-force"], {
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
  } else if (format === "dmg") {
    extractDmg(artifact, root);
  } else if (format === "appimage") {
    extractAppImage(artifact, root);
  } else {
    extractLinuxPackage(artifact, root, format);
  }
  const inventory = inventoryRoot(root, artifactInventoryOptions(artifact));
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
    const inventory = prepareArtifact({ artifact, root });
    return {
      inventory,
      packageMetadata: readPackageMetadata(root, artifactFormat(artifact)),
    };
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
  propertyMap(properties);
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
  if (properties !== undefined && !Array.isArray(properties)) {
    throw new Error("SBOM properties must be an array");
  }
  const result = new Map();
  for (const property of Array.isArray(properties) ? properties : []) {
    if (
      !property ||
      typeof property !== "object" ||
      typeof property.name !== "string" ||
      typeof property.value !== "string"
    ) {
      throw new Error("SBOM properties must have string names and values");
    }
    if (property.name.startsWith("free2z:") && result.has(property.name)) {
      throw new Error(
        `SBOM authority property must be unique: ${property.name}`,
      );
    }
    // CycloneDX properties are an ordered name/value list. Syft deliberately
    // emits repeated names for multivalued discoveries such as syft:cpe23.
    // Preserve those upstream values; only free2z:* properties carry authority
    // in this verifier and therefore require unique names.
    if (!result.has(property.name)) {
      result.set(property.name, property.value);
    }
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

function packageMetadataComponent(metadata) {
  if (!metadata) return undefined;
  const fields = metadata.fields;
  const name = metadata.format === "deb" ? fields.Package : fields.name;
  const version = metadata.format === "deb" ? fields.Version : fields.version;
  const canonical = `${JSON.stringify(metadata, null, 2)}\n`;
  const metadataSha256 = sha256Text(canonical);
  const properties = {
    [PACKAGE_METADATA_FORMAT]: metadata.format,
    [PACKAGE_METADATA_SHA256]: metadataSha256,
  };
  for (const [field, value] of Object.entries(fields)) {
    properties[`${PACKAGE_METADATA_FIELD}${field}`] = value;
  }
  return {
    type: "application",
    "bom-ref": `artifact-package:${metadataSha256}`,
    name,
    version,
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
  const fresh = inventoryArtifactFresh(artifact);
  const expected = new Map(fresh.inventory.map((entry) => [entry.path, entry]));
  const expectedPackageComponent = packageMetadataComponent(
    fresh.packageMetadata,
  );
  const packageComponents = (sbom.components ?? []).filter((component) =>
    propertyMap(component?.properties).has(PACKAGE_METADATA_FORMAT),
  );
  if (
    packageComponents.length !== (expectedPackageComponent ? 1 : 0) ||
    (expectedPackageComponent &&
      JSON.stringify(packageComponents[0]) !==
        JSON.stringify(expectedPackageComponent))
  ) {
    throw new Error("SBOM package metadata does not match the exact artifact");
  }
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
  const format = artifactFormat(artifact);
  const inventory = inventoryRoot(root, artifactInventoryOptions(artifact));
  const packageMetadata = readPackageMetadata(root, format);
  const expectedPackageMetadata = packageMetadataForArtifact(artifact, format);
  if (
    JSON.stringify(packageMetadata) !== JSON.stringify(expectedPackageMetadata)
  ) {
    throw new Error(
      "package metadata sidecar does not match the exact artifact",
    );
  }
  const packageComponents = (document.components ?? []).filter((component) => {
    const properties = propertyMap(component?.properties);
    if (properties.has(PACKAGE_METADATA_FORMAT)) return false;
    if (component?.type !== "file") return true;
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
    ...(packageMetadata ? [packageMetadataComponent(packageMetadata)] : []),
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

function requireExactRunStep(
  label,
  block,
  stepName,
  expectedLines,
  failures,
  expectedIf,
) {
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
  const runMarker = expectedIf
    ? `        if: ${expectedIf}\n        run: |\n`
    : "        run: |\n";
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

function requireExactActionStep(
  label,
  block,
  stepName,
  expectedLines,
  failures,
) {
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
  const actualLines = step
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) {
    failures.push(`${label}: ${stepName} action contract changed`);
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
  const packagingLinux = jobBlock(packaging, "desktop");
  const releaseLinux = jobBlock(release, "linux");
  const prepareLinuxLines = [
    "appimages=(release-artifacts/*.AppImage)",
    "debs=(release-artifacts/*.deb)",
    "rpms=(release-artifacts/*.rpm)",
    '[[ ${#appimages[@]} -eq 1 && -f "${appimages[0]}" ]] || { echo "expected exactly one Linux AppImage" >&2; exit 1; }',
    '[[ ${#debs[@]} -eq 1 && -f "${debs[0]}" ]] || { echo "expected exactly one Linux deb" >&2; exit 1; }',
    '[[ ${#rpms[@]} -eq 1 && -f "${rpms[0]}" ]] || { echo "expected exactly one Linux rpm" >&2; exit 1; }',
    'node scripts/artifact-sbom.mjs prepare --artifact="${appimages[0]}" --root=artifact-sbom-work/linux-appimage/root',
    'node scripts/artifact-sbom.mjs prepare --artifact="${debs[0]}" --root=artifact-sbom-work/linux-deb/root',
    'node scripts/artifact-sbom.mjs prepare --artifact="${rpms[0]}" --root=artifact-sbom-work/linux-rpm/root',
  ];
  const bindLinuxLines = [
    "appimages=(release-artifacts/*.AppImage)",
    "debs=(release-artifacts/*.deb)",
    "rpms=(release-artifacts/*.rpm)",
    'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${appimages[0]}" --root=artifact-sbom-work/linux-appimage/root --raw-sbom=artifact-sbom-work/linux-appimage/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-appimage.artifact.sbom-binding.json',
    'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${debs[0]}" --root=artifact-sbom-work/linux-deb/root --raw-sbom=artifact-sbom-work/linux-deb/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-linux-deb.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-deb.artifact.sbom-binding.json',
    'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${rpms[0]}" --root=artifact-sbom-work/linux-rpm/root --raw-sbom=artifact-sbom-work/linux-rpm/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-linux-rpm.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-rpm.artifact.sbom-binding.json',
  ];
  requireExactRunStep(
    "packaging linux",
    packagingLinux,
    "Prepare Linux shipped-artifact inventories",
    prepareLinuxLines,
    failures,
    "runner.os == 'Linux'",
  );
  requireExactRunStep(
    "release linux artifacts",
    releaseLinux,
    "Prepare Linux shipped-artifact inventories",
    prepareLinuxLines,
    failures,
  );
  requireExactRunStep(
    "packaging linux",
    packagingLinux,
    "Bind Linux shipped-artifact SBOMs",
    bindLinuxLines,
    failures,
    "runner.os == 'Linux'",
  );
  requireExactRunStep(
    "release linux artifacts",
    releaseLinux,
    "Bind Linux shipped-artifact SBOMs",
    bindLinuxLines,
    failures,
  );
  for (const [workflowLabel, block, expectedIf] of [
    ["packaging linux", packagingLinux, "runner.os == 'Linux'"],
    ["release linux artifacts", releaseLinux, undefined],
  ]) {
    for (const [display, path] of [
      ["AppImage", "appimage"],
      ["deb", "deb"],
      ["rpm", "rpm"],
    ]) {
      requireExactActionStep(
        workflowLabel,
        block,
        `Scan Linux ${display} shipped artifact`,
        [
          ...(expectedIf ? [`if: ${expectedIf}`] : []),
          "uses: anchore/sbom-action@fbfd9c6c189226748411491745178e0c2017392d # v0.20.10",
          "with:",
          "syft-version: v1.50.0",
          `path: wallet/zuuli/artifact-sbom-work/linux-${path}/root`,
          "config: wallet/zuuli/syft-artifact.yaml",
          "format: cyclonedx-json",
          `output-file: wallet/zuuli/artifact-sbom-work/linux-${path}/syft.raw.sbom.cdx.json`,
          "upload-artifact: false",
        ],
        failures,
      );
    }
  }
  const syftAction =
    "uses: anchore/sbom-action@fbfd9c6c189226748411491745178e0c2017392d";
  for (const [workflowLabel, block, expectedCount] of [
    ["packaging linux", packagingLinux, 6],
    ["release linux artifacts", releaseLinux, 4],
  ]) {
    const actualCount = block.split(syftAction).length - 1;
    if (actualCount !== expectedCount) {
      failures.push(
        `${workflowLabel}: expected ${expectedCount} total canonical Syft actions, found ${actualCount}`,
      );
    }
  }
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
      "packaging linux",
      jobBlock(packaging, "desktop"),
      [
        "node --test --test-name-pattern='real AppImage, deb, and rpm|AppImage inspection|AppImage listing|real deb with an escaping' scripts/artifact-sbom.node-test.mjs",
        'node scripts/artifact-sbom.mjs prepare --artifact="${appimages[0]}" --root=artifact-sbom-work/linux-appimage/root',
        'node scripts/artifact-sbom.mjs prepare --artifact="${debs[0]}" --root=artifact-sbom-work/linux-deb/root',
        'node scripts/artifact-sbom.mjs prepare --artifact="${rpms[0]}" --root=artifact-sbom-work/linux-rpm/root',
        "path: wallet/zuuli/artifact-sbom-work/linux-appimage/root",
        "output-file: wallet/zuuli/artifact-sbom-work/linux-appimage/syft.raw.sbom.cdx.json",
        "path: wallet/zuuli/artifact-sbom-work/linux-deb/root",
        "output-file: wallet/zuuli/artifact-sbom-work/linux-deb/syft.raw.sbom.cdx.json",
        "path: wallet/zuuli/artifact-sbom-work/linux-rpm/root",
        "output-file: wallet/zuuli/artifact-sbom-work/linux-rpm/syft.raw.sbom.cdx.json",
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${appimages[0]}" --root=artifact-sbom-work/linux-appimage/root --raw-sbom=artifact-sbom-work/linux-appimage/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-appimage.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${debs[0]}" --root=artifact-sbom-work/linux-deb/root --raw-sbom=artifact-sbom-work/linux-deb/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-linux-deb.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-deb.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${rpms[0]}" --root=artifact-sbom-work/linux-rpm/root --raw-sbom=artifact-sbom-work/linux-rpm/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-linux-rpm.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-rpm.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${appimages[0]}" --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-appimage.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${debs[0]}" --sbom=release-artifacts/ZUULI-linux-deb.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-deb.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${rpms[0]}" --sbom=release-artifacts/ZUULI-linux-rpm.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-rpm.artifact.sbom-binding.json',
        "npm run release:manifest -- --artifacts=release-artifacts",
        "actions/upload-artifact@",
      ],
    ],
    [
      "release linux artifacts",
      jobBlock(release, "linux"),
      [
        'node scripts/artifact-sbom.mjs prepare --artifact="${appimages[0]}" --root=artifact-sbom-work/linux-appimage/root',
        'node scripts/artifact-sbom.mjs prepare --artifact="${debs[0]}" --root=artifact-sbom-work/linux-deb/root',
        'node scripts/artifact-sbom.mjs prepare --artifact="${rpms[0]}" --root=artifact-sbom-work/linux-rpm/root',
        "path: wallet/zuuli/artifact-sbom-work/linux-appimage/root",
        "output-file: wallet/zuuli/artifact-sbom-work/linux-appimage/syft.raw.sbom.cdx.json",
        "path: wallet/zuuli/artifact-sbom-work/linux-deb/root",
        "output-file: wallet/zuuli/artifact-sbom-work/linux-deb/syft.raw.sbom.cdx.json",
        "path: wallet/zuuli/artifact-sbom-work/linux-rpm/root",
        "output-file: wallet/zuuli/artifact-sbom-work/linux-rpm/syft.raw.sbom.cdx.json",
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${appimages[0]}" --root=artifact-sbom-work/linux-appimage/root --raw-sbom=artifact-sbom-work/linux-appimage/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-appimage.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${debs[0]}" --root=artifact-sbom-work/linux-deb/root --raw-sbom=artifact-sbom-work/linux-deb/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-linux-deb.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-deb.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs finalize-artifact --artifact="${rpms[0]}" --root=artifact-sbom-work/linux-rpm/root --raw-sbom=artifact-sbom-work/linux-rpm/syft.raw.sbom.cdx.json --sbom=release-artifacts/ZUULI-linux-rpm.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-rpm.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${appimages[0]}" --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-appimage.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${debs[0]}" --sbom=release-artifacts/ZUULI-linux-deb.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-deb.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${rpms[0]}" --sbom=release-artifacts/ZUULI-linux-rpm.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-rpm.artifact.sbom-binding.json',
        "npm run release:manifest -- --artifacts=release-artifacts",
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
      "packaging desktop",
      jobBlock(packaging, "desktop"),
      [
        'if [[ "${{ runner.os }}" == Linux ]]; then',
        "appimages=(release-artifacts/*.AppImage)",
        "debs=(release-artifacts/*.deb)",
        "rpms=(release-artifacts/*.rpm)",
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${appimages[0]}" --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-appimage.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${debs[0]}" --sbom=release-artifacts/ZUULI-linux-deb.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-deb.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${rpms[0]}" --sbom=release-artifacts/ZUULI-linux-rpm.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-rpm.artifact.sbom-binding.json',
        "else",
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
      "release linux artifacts",
      jobBlock(release, "linux"),
      [
        "appimages=(release-artifacts/*.AppImage)",
        "debs=(release-artifacts/*.deb)",
        "rpms=(release-artifacts/*.rpm)",
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${appimages[0]}" --sbom=release-artifacts/ZUULI-linux-appimage.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-appimage.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${debs[0]}" --sbom=release-artifacts/ZUULI-linux-deb.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-deb.artifact.sbom-binding.json',
        'node scripts/artifact-sbom.mjs verify-artifact --artifact="${rpms[0]}" --sbom=release-artifacts/ZUULI-linux-rpm.artifact.sbom.cdx.json --binding=release-artifacts/ZUULI-linux-rpm.artifact.sbom-binding.json',
        'jq -e \'(.metadata.properties // [] | any(.name == "free2z:inventory-scope" and .value == "source-tree")) and ((.components // []) | length >= 50)\' release-artifacts/ZUULI-linux.source.sbom.cdx.json',
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
