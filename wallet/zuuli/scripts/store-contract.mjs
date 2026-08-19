#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalManifestPath = resolve(projectRoot, "store/manifest.json");
const PATH_PATTERN = /^(?:store|assets\/store)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.json$|^(?:store|assets\/store)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.png$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BRAND_CONTRACTS = new Map([
  ["apple-store-icon", { path: "assets/store/app-store-icon-1024.png", width: 1024, height: 1024, maxBytes: 1048576 }],
  ["play-store-icon", { path: "assets/store/play-store-icon-512.png", width: 512, height: 512, maxBytes: 1048576 }],
  ["play-feature-graphic", { path: "assets/store/play-feature-graphic-1024x500.png", width: 1024, height: 500, maxBytes: 15728640 }],
]);
const SCREENSHOT_CONTRACTS = new Map([
  ["apple:APP_IPHONE_67", { width: 1320, height: 2868, minCount: 4, maxCount: 10, maxBytes: 10485760 }],
  ["apple:APP_IPAD_PRO_3GEN_129", { width: 2064, height: 2752, minCount: 4, maxCount: 10, maxBytes: 10485760 }],
  ["play:phoneScreenshots", { width: 1080, height: 1920, minCount: 4, maxCount: 8, maxBytes: 8388608 }],
  ["play:sevenInchScreenshots", { width: 1200, height: 1920, minCount: 4, maxCount: 8, maxBytes: 8388608 }],
  ["play:tenInchScreenshots", { width: 1600, height: 2560, minCount: 4, maxCount: 8, maxBytes: 8388608 }],
]);

export class StoreContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StoreContractError(code, message);
}

function plainObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    fail("INVALID_MANIFEST", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(plainObject(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) {
    fail("INVALID_MANIFEST", `${label} must have exactly: ${wanted.join(", ")}`);
  }
}

async function readCanonicalJson(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch {
    fail("MISSING_FILE", `${label} is missing`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("INVALID_JSON", `${label} is not valid JSON`);
  }
  const canonical = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (!bytes.equals(canonical)) {
    fail("NONCANONICAL_JSON", `${label} must be canonical pretty JSON with one final newline`);
  }
  return value;
}

async function resolveDeclaredFile(root, declared, label) {
  if (typeof declared !== "string" || !PATH_PATTERN.test(declared) || declared.includes("..")) {
    fail("UNSAFE_PATH", `${label} has an unsafe repository-relative path`);
  }
  const candidate = resolve(root, declared);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    fail("UNSAFE_PATH", `${label} escapes the project root`);
  }
  let stat;
  try {
    stat = await lstat(candidate);
  } catch {
    fail("MISSING_FILE", `${label} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("UNSAFE_PATH", `${label} must be a regular, non-symlink file`);
  }
  const actual = await realpath(candidate);
  const actualRoot = await realpath(root);
  if (!actual.startsWith(`${actualRoot}${sep}`)) {
    fail("UNSAFE_PATH", `${label} resolves outside the project root`);
  }
  return candidate;
}

function requireString(value, label, { min = 1, max, maxBytes = max === undefined ? undefined : max * 4, singleLine = false } = {}) {
  if (typeof value !== "string" || value.length < min || (max !== undefined && value.length > max)) {
    fail("INVALID_METADATA", `${label} must contain ${min}..${max ?? "unbounded"} characters`);
  }
  if (maxBytes !== undefined && Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("INVALID_METADATA", `${label} exceeds its ${maxBytes}-byte UTF-8 limit`);
  }
  if (value !== value.trim()) fail("INVALID_METADATA", `${label} has surrounding whitespace`);
  if (singleLine && /[\r\n]/.test(value)) fail("INVALID_METADATA", `${label} must be one line`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) fail("INVALID_METADATA", `${label} contains control characters`);
  return value;
}

function requireHttps(value, label) {
  requireString(value, label, { max: 2048, singleLine: true });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("INVALID_METADATA", `${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    fail("INVALID_METADATA", `${label} must be credential-free HTTPS without a fragment`);
  }
  return value;
}

function requireEmail(value, label) {
  requireString(value, label, { max: 254, singleLine: true });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    fail("INVALID_METADATA", `${label} must be an email address`);
  }
}

function assertMetadata(meta, provider, app, label) {
  if (provider === "apple") {
    exactKeys(meta, ["name", "subtitle", "description", "keywords", "promotionalText", "supportUrl", "marketingUrl", "privacyPolicyUrl", "releaseNotes", "betaDescription", "betaFeedbackEmail"], label);
    requireString(meta.name, `${label}.name`, { max: 30, singleLine: true });
    requireString(meta.subtitle, `${label}.subtitle`, { max: 30, singleLine: true });
    requireString(meta.description, `${label}.description`, { max: 4000 });
    requireString(meta.keywords, `${label}.keywords`, { max: 100, singleLine: true });
    requireString(meta.promotionalText, `${label}.promotionalText`, { max: 170 });
    requireString(meta.releaseNotes, `${label}.releaseNotes`, { max: 4000 });
    requireString(meta.betaDescription, `${label}.betaDescription`, { max: 4000 });
    requireEmail(meta.betaFeedbackEmail, `${label}.betaFeedbackEmail`);
    for (const key of ["supportUrl", "marketingUrl", "privacyPolicyUrl"]) requireHttps(meta[key], `${label}.${key}`);
    if (meta.supportUrl !== app.supportUrl || meta.marketingUrl !== app.marketingUrl || meta.privacyPolicyUrl !== app.privacyPolicyUrl || meta.betaFeedbackEmail !== app.supportEmail) {
      fail("IDENTITY_MISMATCH", `${label} contact and legal fields must match manifest.application`);
    }
  } else {
    exactKeys(meta, ["title", "shortDescription", "fullDescription", "releaseNotes", "supportEmail", "supportUrl", "websiteUrl", "privacyPolicyUrl"], label);
    requireString(meta.title, `${label}.title`, { max: 30, singleLine: true });
    requireString(meta.shortDescription, `${label}.shortDescription`, { max: 80, singleLine: true });
    requireString(meta.fullDescription, `${label}.fullDescription`, { max: 4000 });
    requireString(meta.releaseNotes, `${label}.releaseNotes`, { max: 500 });
    requireEmail(meta.supportEmail, `${label}.supportEmail`);
    for (const key of ["supportUrl", "websiteUrl", "privacyPolicyUrl"]) requireHttps(meta[key], `${label}.${key}`);
    if (meta.supportEmail !== app.supportEmail || meta.supportUrl !== app.supportUrl || meta.websiteUrl !== app.marketingUrl || meta.privacyPolicyUrl !== app.privacyPolicyUrl) {
      fail("IDENTITY_MISMATCH", `${label} contact and legal fields must match manifest.application`);
    }
  }
}

function assertPngSignature(bytes, label) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail("INVALID_MEDIA", `${label} is not a PNG`);
  }
}

async function validateMedia(root, spec, label, shaSet) {
  exactKeys(spec, ["id", "path", "width", "height", "maxBytes", "opaque", "encodedRgbOnly", "sha256"], label);
  requireString(spec.id, `${label}.id`, { max: 80, singleLine: true });
  if (!Number.isSafeInteger(spec.width) || !Number.isSafeInteger(spec.height) || !Number.isSafeInteger(spec.maxBytes) || spec.width < 1 || spec.height < 1 || spec.maxBytes < 1 || spec.opaque !== true || spec.encodedRgbOnly !== true || !SHA256_PATTERN.test(spec.sha256)) {
    fail("INVALID_MANIFEST", `${label} has an invalid media contract`);
  }
  const filePath = await resolveDeclaredFile(root, spec.path, label);
  const bytes = await readFile(filePath);
  assertPngSignature(bytes, label);
  if (bytes.length > spec.maxBytes) fail("INVALID_MEDIA", `${label} exceeds its byte limit`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== spec.sha256) fail("INVALID_MEDIA", `${label} SHA-256 does not match the manifest`);
  if (shaSet.has(digest)) fail("DUPLICATE_MEDIA", `${label} duplicates another declared image`);
  shaSet.add(digest);
  let png;
  try {
    png = PNG.sync.read(bytes, { checkCRC: true, skipRescale: false });
  } catch {
    fail("INVALID_MEDIA", `${label} could not be decoded as a valid PNG`);
  }
  if (png.width !== spec.width || png.height !== spec.height) fail("INVALID_MEDIA", `${label} must be exactly ${spec.width}x${spec.height}`);
  // PNG color type 2 is encoded RGB. A decoded alpha check separately catches
  // transparent pixels if this contract is later relaxed to allow color type 6.
  if (bytes[25] !== 2) fail("INVALID_MEDIA", `${label} must be encoded as RGB without an alpha channel`);
  for (let index = 3; index < png.data.length; index += 4) {
    if (png.data[index] !== 255) fail("INVALID_MEDIA", `${label} contains transparent pixels`);
  }
  return { id: spec.id, path: spec.path, width: png.width, height: png.height, bytes: bytes.length, sha256: digest, bytesForTextScan: bytes };
}

function pngText(bytes, label) {
  const chunks = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) fail("INVALID_MEDIA", `${label} has a truncated PNG chunk`);
    const data = bytes.subarray(start, end);
    if (type === "tEXt") chunks.push(data.toString("utf8"));
    if (type === "zTXt") {
      const separator = data.indexOf(0);
      if (separator < 0 || data[separator + 1] !== 0) fail("INVALID_MEDIA", `${label} has malformed compressed PNG text`);
      try {
        chunks.push(`${data.subarray(0, separator).toString("utf8")} ${inflateSync(data.subarray(separator + 2)).toString("utf8")}`);
      } catch {
        fail("INVALID_MEDIA", `${label} has unreadable compressed PNG text`);
      }
    }
    if (type === "iTXt") {
      const keywordEnd = data.indexOf(0);
      if (keywordEnd < 0 || keywordEnd + 2 >= data.length) fail("INVALID_MEDIA", `${label} has malformed international PNG text`);
      const compressionFlag = data[keywordEnd + 1];
      const compressionMethod = data[keywordEnd + 2];
      const languageEnd = data.indexOf(0, keywordEnd + 3);
      const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
      if (!new Set([0, 1]).has(compressionFlag) || compressionMethod !== 0 || languageEnd < 0 || translatedEnd < 0) fail("INVALID_MEDIA", `${label} has malformed international PNG text`);
      const text = data.subarray(translatedEnd + 1);
      try {
        chunks.push(`${data.subarray(0, keywordEnd).toString("utf8")} ${(compressionFlag === 1 ? inflateSync(text) : text).toString("utf8")}`);
      } catch {
        fail("INVALID_MEDIA", `${label} has unreadable international PNG text`);
      }
    }
    offset = end + 4;
    if (type === "IEND") break;
  }
  return chunks.join("\n").toLowerCase();
}

function validateScreenshotSet(set, localeIds, ids) {
  exactKeys(set, ["id", "provider", "apiType", "locale", "width", "height", "minCount", "maxCount", "maxBytes", "files"], `screenshot set ${set?.id ?? "unknown"}`);
  requireString(set.id, "screenshot set id", { max: 80, singleLine: true });
  if (ids.has(set.id)) fail("INVALID_MANIFEST", `duplicate screenshot set ${set.id}`);
  ids.add(set.id);
  if (!new Set(["apple", "play"]).has(set.provider) || !localeIds.has(set.locale) || !Array.isArray(set.files) || !Number.isSafeInteger(set.width) || !Number.isSafeInteger(set.height) || !Number.isSafeInteger(set.minCount) || !Number.isSafeInteger(set.maxCount) || !Number.isSafeInteger(set.maxBytes) || set.minCount < 1 || set.maxCount < set.minCount || set.files.length > set.maxCount) {
    fail("INVALID_MANIFEST", `screenshot set ${set.id} is malformed`);
  }
  requireString(set.apiType, `screenshot set ${set.id}.apiType`, { max: 80, singleLine: true });
  const contract = SCREENSHOT_CONTRACTS.get(`${set.provider}:${set.apiType}`);
  if (!contract || Object.entries(contract).some(([key, value]) => set[key] !== value)) fail("INVALID_MANIFEST", `screenshot set ${set.id} does not match an exact provider geometry/count contract`);
}

async function listPngs(directory) {
  const result = [];
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) fail("UNSAFE_PATH", `store media contains symlink ${entry.name}`);
    if (entry.isDirectory()) result.push(...await listPngs(entryPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) result.push(entryPath);
  }
  return result;
}

export async function validateStoreContract({ root = projectRoot, manifestPath = resolve(root, "store/manifest.json"), publish = false } = {}) {
  const manifest = await readCanonicalJson(manifestPath, "store manifest");
  const release = await readCanonicalJson(resolve(root, "release.json"), "release identity");
  exactKeys(release, ["$schema", "schemaVersion", "applicationId", "iosUsesNonExemptEncryption", "version", "build", "minimums"], "release identity");
  if (release.schemaVersion !== 2 || release.applicationId !== "cash.free2z.zuuli" || release.iosUsesNonExemptEncryption !== false || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version) || !Number.isSafeInteger(release.build) || release.build < 1) fail("IDENTITY_MISMATCH", "release.json does not contain the canonical ZUULI release identity");
  exactKeys(manifest, ["schemaVersion", "phase", "publicationReady", "application", "locales", "classification", "brandMedia", "screenshotSets", "capturePolicy"], "store manifest");
  if (manifest.schemaVersion !== 1 || manifest.phase !== (publish ? "ready" : manifest.phase) || !new Set(["foundation", "ready"]).has(manifest.phase) || manifest.publicationReady !== (manifest.phase === "ready")) {
    fail(publish ? "NOT_PUBLICATION_READY" : "INVALID_MANIFEST", publish ? "store manifest is not approved for publication" : "manifest phase/readiness is inconsistent");
  }
  exactKeys(manifest.application, ["bundleId", "appleAppId", "playPackageName", "defaultLocale", "supportEmail", "supportUrl", "marketingUrl", "privacyPolicyUrl"], "manifest.application");
  if (manifest.application.bundleId !== "cash.free2z.zuuli" || manifest.application.playPackageName !== "cash.free2z.zuuli" || manifest.application.appleAppId !== "6799322201" || manifest.application.defaultLocale !== "en-US") fail("IDENTITY_MISMATCH", "store application identity is not canonical ZUULI");
  requireEmail(manifest.application.supportEmail, "application.supportEmail");
  for (const key of ["supportUrl", "marketingUrl", "privacyPolicyUrl"]) requireHttps(manifest.application[key], `application.${key}`);

  if (!Array.isArray(manifest.locales) || manifest.locales.length < 1) fail("INVALID_MANIFEST", "manifest.locales must not be empty");
  const localeIds = new Set();
  const appleLocales = new Set();
  const playLocales = new Set();
  const locales = [];
  for (const locale of manifest.locales) {
    exactKeys(locale, ["id", "appleLocale", "playLocale", "copyStatus", "appleMetadata", "playMetadata"], `locale ${locale?.id ?? "unknown"}`);
    for (const key of ["id", "appleLocale", "playLocale"]) requireString(locale[key], `locale.${key}`, { max: 35, singleLine: true });
    if (localeIds.has(locale.id)) fail("INVALID_MANIFEST", `duplicate locale ${locale.id}`);
    if (appleLocales.has(locale.appleLocale) || playLocales.has(locale.playLocale)) fail("INVALID_MANIFEST", "provider locale mappings must be unique");
    localeIds.add(locale.id);
    appleLocales.add(locale.appleLocale);
    playLocales.add(locale.playLocale);
    if (locale.copyStatus !== (manifest.phase === "ready" ? "approved" : "proposed-owner-legal-review-required")) fail("INVALID_MANIFEST", `locale ${locale.id} copy review status does not match the manifest phase`);
    const applePath = await resolveDeclaredFile(root, locale.appleMetadata, `${locale.id} Apple metadata`);
    const playPath = await resolveDeclaredFile(root, locale.playMetadata, `${locale.id} Play metadata`);
    const apple = await readCanonicalJson(applePath, `${locale.id} Apple metadata`);
    const play = await readCanonicalJson(playPath, `${locale.id} Play metadata`);
    assertMetadata(apple, "apple", manifest.application, `${locale.id} Apple metadata`);
    assertMetadata(play, "play", manifest.application, `${locale.id} Play metadata`);
    locales.push({ id: locale.id, appleLocale: locale.appleLocale, playLocale: locale.playLocale, copyStatus: locale.copyStatus, appleMetadata: apple, playMetadata: play });
  }
  if (!localeIds.has(manifest.application.defaultLocale)) fail("INVALID_MANIFEST", "default locale is not declared");

  exactKeys(manifest.classification, ["reviewStatus", "applePrimaryCategory", "appleSecondaryCategory", "playCategory", "contentRatingNotes", "automaticRatingSubmissionAllowed"], "classification");
  for (const key of ["applePrimaryCategory", "appleSecondaryCategory", "playCategory"]) requireString(manifest.classification[key], `classification.${key}`, { max: 80, singleLine: true });
  if (manifest.classification.reviewStatus !== (manifest.phase === "ready" ? "approved" : "proposed-owner-store-review-required") || !Array.isArray(manifest.classification.contentRatingNotes) || manifest.classification.contentRatingNotes.length < 1 || manifest.classification.automaticRatingSubmissionAllowed !== false) fail("INVALID_MANIFEST", "classification requires owner review notes and must forbid automatic rating submission");
  for (const note of manifest.classification.contentRatingNotes) requireString(note, "classification.contentRatingNotes entry", { max: 500 });

  if (!Array.isArray(manifest.brandMedia) || manifest.brandMedia.length !== 3) fail("INVALID_MANIFEST", "exactly three canonical brand media assets are required");
  const shaSet = new Set();
  const brandMedia = [];
  const mediaText = [];
  const brandIds = new Set();
  for (const spec of manifest.brandMedia) {
    const contract = BRAND_CONTRACTS.get(spec.id);
    if (!contract || brandIds.has(spec.id) || Object.entries(contract).some(([key, value]) => spec[key] !== value)) fail("INVALID_MANIFEST", `brand media ${spec?.id ?? "unknown"} does not match its fixed store contract`);
    brandIds.add(spec.id);
    const validated = await validateMedia(root, spec, `brand media ${spec?.id ?? "unknown"}`, shaSet);
    mediaText.push(pngText(validated.bytesForTextScan, `brand media ${spec.id}`));
    delete validated.bytesForTextScan;
    brandMedia.push(validated);
  }

  if (!Array.isArray(manifest.screenshotSets) || manifest.screenshotSets.length !== SCREENSHOT_CONTRACTS.size * localeIds.size) fail("INVALID_MANIFEST", "every locale must declare all five canonical screenshot sets");
  const screenshotIds = new Set();
  const screenshotTuples = new Set();
  const declaredScreenshots = new Set();
  for (const set of manifest.screenshotSets) {
    validateScreenshotSet(set, localeIds, screenshotIds);
    const tuple = `${set.locale}:${set.provider}:${set.apiType}`;
    if (screenshotTuples.has(tuple)) fail("INVALID_MANIFEST", `duplicate screenshot contract ${tuple}`);
    screenshotTuples.add(tuple);
    if (publish && set.files.length < set.minCount) fail("NOT_PUBLICATION_READY", `${set.id} requires at least ${set.minCount} reviewed screenshots`);
    if (!publish && manifest.phase === "foundation" && set.files.length !== 0) fail("INVALID_MANIFEST", "foundation phase must not carry unapproved screenshots");
    const screenshotFileIds = new Set();
    for (const file of set.files) {
      exactKeys(file, ["id", "path", "sha256", "sourceSha", "reviewIssue"], `${set.id} screenshot declaration`);
      requireString(file.id, `${set.id} screenshot id`, { max: 80, singleLine: true });
      if (screenshotFileIds.has(file.id)) fail("INVALID_MANIFEST", `${set.id} screenshot file IDs must be unique`);
      screenshotFileIds.add(file.id);
      if (!/^[0-9a-f]{40}$/.test(file.sourceSha) || !Number.isSafeInteger(file.reviewIssue) || file.reviewIssue < 1) fail("INVALID_MANIFEST", `${set.id} screenshot requires an exact capture source SHA and review issue`);
      const filePath = await resolveDeclaredFile(root, file.path, `${set.id} screenshot`);
      const rel = relative(root, filePath).split(sep).join("/");
      if (!rel.startsWith("store/media/")) fail("UNSAFE_PATH", `${set.id} screenshot must live under store/media`);
      declaredScreenshots.add(filePath);
      const validated = await validateMedia(root, { id: `${set.id}:${file.id}`, path: file.path, sha256: file.sha256, width: set.width, height: set.height, maxBytes: set.maxBytes, opaque: true, encodedRgbOnly: true }, `${set.id} screenshot ${file.id}`, shaSet);
      mediaText.push(pngText(validated.bytesForTextScan, `${set.id} screenshot ${file.id}`));
    }
  }
  for (const locale of localeIds) for (const contract of SCREENSHOT_CONTRACTS.keys()) if (!screenshotTuples.has(`${locale}:${contract}`)) fail("INVALID_MANIFEST", `locale ${locale} is missing screenshot contract ${contract}`);
  const actualScreenshots = await listPngs(resolve(root, "store/media"));
  for (const file of actualScreenshots) if (!declaredScreenshots.has(file)) fail("UNDECLARED_MEDIA", `undeclared store media: ${relative(root, file)}`);

  exactKeys(manifest.capturePolicy, ["status", "blockedByIssues", "fixtureProfile", "releaseEquivalentBuildRequired", "safeAreasRequired", "realSeedOrPrivateDataAllowed", "testerIdentityAllowed", "debugOrMockDisclosureAllowed", "reviewRequired", "forbiddenEmbeddedText"], "capturePolicy");
  const policy = manifest.capturePolicy;
  if (policy.fixtureProfile !== "store-v1" || policy.releaseEquivalentBuildRequired !== true || policy.safeAreasRequired !== true || policy.realSeedOrPrivateDataAllowed !== false || policy.testerIdentityAllowed !== false || policy.debugOrMockDisclosureAllowed !== false || policy.reviewRequired !== true || !Array.isArray(policy.forbiddenEmbeddedText) || policy.forbiddenEmbeddedText.length < 1) fail("INVALID_MANIFEST", "capture policy does not preserve the store safety contract");
  if (manifest.phase === "foundation" && (policy.status !== "deferred" || JSON.stringify(policy.blockedByIssues) !== "[267,1257,255]")) fail("INVALID_MANIFEST", "foundation screenshots must remain deferred behind issues #267, #1257, and #255");
  if (manifest.phase === "ready" && (!Array.isArray(policy.blockedByIssues) || policy.blockedByIssues.length !== 0)) fail("INVALID_MANIFEST", "publication-ready screenshots cannot retain unresolved blocker issues");
  if (publish && policy.status !== "approved") fail("NOT_PUBLICATION_READY", "capture policy has not been approved");
  for (const phrase of policy.forbiddenEmbeddedText) {
    requireString(phrase, "capturePolicy.forbiddenEmbeddedText entry", { max: 100, singleLine: true });
    if (mediaText.some((text) => text.includes(phrase.toLowerCase()))) fail("FORBIDDEN_MEDIA_TEXT", "declared store media contains a forbidden embedded-text marker");
  }

  return { schemaVersion: 1, phase: manifest.phase, publicationReady: manifest.publicationReady, application: { bundleId: manifest.application.bundleId, appleAppId: manifest.application.appleAppId, playPackageName: manifest.application.playPackageName, defaultLocale: manifest.application.defaultLocale }, release: { version: release.version, build: release.build }, locales, brandMedia, screenshotSets: manifest.screenshotSets.map(({ id, provider, apiType, locale, width, height, minCount, maxCount, files }) => ({ id, provider, apiType, locale, width, height, minCount, maxCount, count: files.length })) };
}

export async function main(argv = process.argv.slice(2)) {
  const allowed = new Set(["--publish"]);
  for (const arg of argv) if (!allowed.has(arg)) fail("INVALID_ARGUMENT", `unknown argument: ${arg}`);
  const result = await validateStoreContract({ publish: argv.includes("--publish") });
  process.stdout.write(`${JSON.stringify({ ...result, locales: result.locales.map(({ appleMetadata: _apple, playMetadata: _play, ...locale }) => locale) }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const code = error instanceof StoreContractError ? error.code : "STORE_CONTRACT_FAILED";
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
