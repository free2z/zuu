#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const canonicalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CAPTURE_CONFIG_PATH = "store/capture.json";
export const CAPTURE_RECORD_PATH = "store/capture-record.json";
export const CAPTURE_FIXTURE_PATH = "store/fixtures/en-US/articles.json";
export const VITE_PRODUCTION_ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];
export const CAPTURE_LOCAL_OVERRIDE_FILES = [...VITE_PRODUCTION_ENV_FILES, ".npmrc"];
export const CAPTURE_NPM_ENVIRONMENT = Object.freeze({
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_GLOBALCONFIG: "/tmp/zuuli-empty-global-npmrc",
  NPM_CONFIG_IGNORE_SCRIPTS: "true",
  NPM_CONFIG_USERCONFIG: "/tmp/zuuli-empty-user-npmrc",
});
export const CAPTURE_NPM_CI_ARGUMENTS = Object.freeze([
  "ci",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--userconfig=/tmp/zuuli-empty-user-npmrc",
  "--globalconfig=/tmp/zuuli-empty-global-npmrc",
]);

export const CAPTURE_RENDER_INPUTS = [
  "index.html",
  "package.json",
  "package-lock.json",
  "postcss.config.cjs",
  "public",
  "src",
  "tailwind.config.cjs",
  "tsconfig.json",
  "vite.config.ts",
];

export const CAPTURE_CONTRACT_INPUTS = [
  CAPTURE_CONFIG_PATH,
  "store/fixtures",
  "scripts/store-screenshot-preflight.mjs",
  "scripts/store-screenshot-capture.mjs",
  "scripts/store-screenshot-contract.mjs",
];

export const CAPTURE_INPUTS = [...CAPTURE_RENDER_INPUTS, ...CAPTURE_CONTRACT_INPUTS];

export const CAPTURE_SHOTS = new Map([
  ["01-articles-fresh", { route: "/articles", action: "fresh" }],
  ["02-semantic-search", { route: "/articles", action: "search-privacy" }],
  ["03-article-reader", { route: "/articles/why-shielded-defaults-matter", action: "article-reader" }],
  ["04-creator-profile", { route: "/creator/example_editorial", action: "creator-profile" }],
]);

export class ScreenshotContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScreenshotContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ScreenshotContractError(code, message);
}

function plainObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    fail("INVALID_CAPTURE_CONTRACT", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(plainObject(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) {
    fail("INVALID_CAPTURE_CONTRACT", `${label} must have exactly: ${wanted.join(", ")}`);
  }
}

function requireString(value, label, pattern, { singleLine = true } = {}) {
  const forbidden = singleLine ? /[\r\n\u0000-\u001f\u007f]/u : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
  if (typeof value !== "string" || value.length < 1 || value !== value.trim() || forbidden.test(value)) {
    fail("INVALID_CAPTURE_CONTRACT", `${label} must be a nonempty${singleLine ? " single-line" : ""} string`);
  }
  if (pattern && !pattern.test(value)) fail("INVALID_CAPTURE_CONTRACT", `${label} has an invalid format`);
  return value;
}

function requireInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("INVALID_CAPTURE_CONTRACT", `${label} must be an integer from ${min} through ${max}`);
  }
  return value;
}

export async function readCanonicalJson(path, label) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    fail("MISSING_CAPTURE_FILE", `${label} is missing`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("INVALID_CAPTURE_JSON", `${label} is not valid JSON`);
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))) {
    fail("NONCANONICAL_CAPTURE_JSON", `${label} must be canonical pretty JSON with one final newline`);
  }
  return value;
}

async function walkFiles(root, relativePath, result) {
  const absolute = resolve(root, relativePath);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch {
    fail("MISSING_CAPTURE_INPUT", `capture input is missing: ${relativePath}`);
  }
  if (stat.isSymbolicLink()) fail("UNSAFE_CAPTURE_INPUT", `capture input must not be a symlink: ${relativePath}`);
  if (stat.isFile()) {
    result.push(relativePath.split(sep).join("/"));
    return;
  }
  if (!stat.isDirectory()) fail("UNSAFE_CAPTURE_INPUT", `capture input is not a regular file or directory: ${relativePath}`);
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    await walkFiles(root, `${relativePath}/${entry.name}`, result);
  }
}

export async function captureInputFiles(root = canonicalRoot, inputs = CAPTURE_INPUTS) {
  const files = [];
  for (const input of inputs) await walkFiles(root, input, files);
  return [...new Set(files)].sort();
}

async function computeInputDigest(root, inputs) {
  const actualRoot = await realpath(root);
  const hash = createHash("sha256");
  for (const path of await captureInputFiles(root, inputs)) {
    const absolute = resolve(root, path);
    const actual = await realpath(absolute);
    if (!actual.startsWith(`${actualRoot}${sep}`)) fail("UNSAFE_CAPTURE_INPUT", `capture input escapes the project root: ${path}`);
    const bytes = await readFile(absolute);
    hash.update(path);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function computeCaptureSourceDigest(root = canonicalRoot) {
  return computeInputDigest(root, CAPTURE_INPUTS);
}

export async function computeCaptureContractDigest(root = canonicalRoot) {
  return computeInputDigest(root, CAPTURE_CONTRACT_INPUTS);
}

export async function assertNoLocalCaptureOverrides(root = canonicalRoot) {
  for (const relativePath of CAPTURE_LOCAL_OVERRIDE_FILES) {
    try {
      await lstat(resolve(root, relativePath));
      fail("NONDETERMINISTIC_CAPTURE_ENV", "capture refuses local Vite or npm configuration; use the canonical production defaults");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

// Retain the original export for downstream callers while enforcing the
// complete capture boundary, including npm's otherwise implicit project file.
export const assertNoLocalViteEnvironment = assertNoLocalCaptureOverrides;

async function gitOutput(root, args) {
  const output = [];
  const code = await new Promise((accept, reject) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.on("error", reject);
    child.on("exit", accept);
  });
  return { code, output: Buffer.concat(output).toString("utf8") };
}

export async function assertCaptureSourceCommit(sourceSha, root = canonicalRoot) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) fail("INVALID_CAPTURE_SOURCE", "capture source must be an exact commit SHA");
  const commit = await gitOutput(root, ["cat-file", "-e", `${sourceSha}^{commit}`]);
  if (commit.code !== 0) fail("INVALID_CAPTURE_SOURCE", "capture source commit is unavailable");
  const changed = await gitOutput(root, ["diff", "--name-only", "-z", sourceSha, "--", ...CAPTURE_RENDER_INPUTS]);
  const untracked = await gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...CAPTURE_RENDER_INPUTS]);
  if (changed.code !== 0 || untracked.code !== 0) fail("INVALID_CAPTURE_SOURCE", "capture source comparison failed");
  const drift = `${changed.output}${untracked.output}`.split("\0").filter(Boolean);
  if (drift.length) fail("STALE_CAPTURE", `rendered product source differs from capture sourceSha: ${[...new Set(drift)].sort().join(", ")}`);
}

function validateSafeArea(value, target) {
  exactKeys(value, ["top", "right", "bottom", "left"], `${target.setId} safe area`);
  for (const edge of ["top", "right", "bottom", "left"]) {
    requireInteger(value[edge], `${target.setId} safeArea.${edge}`, { min: 0, max: 100 });
  }
  if (value.top + value.bottom >= target.cssHeight / 3 || value.left + value.right >= target.cssWidth / 3) {
    fail("INVALID_CAPTURE_CONTRACT", `${target.setId} safe area consumes an implausible share of the viewport`);
  }
}

function fixtureText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(fixtureText).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(fixtureText).join(" ");
  return "";
}

function validateFixture(fixture, config) {
  exactKeys(fixture, ["schemaVersion", "profile", "locale", "identityClassification", "creators", "articles"], "capture fixture");
  if (fixture.schemaVersion !== 1 || fixture.profile !== config.fixtureProfile || fixture.locale !== config.locale || fixture.identityClassification !== "fictional-editorial" || !Array.isArray(fixture.creators) || fixture.creators.length !== 4 || !Array.isArray(fixture.articles) || fixture.articles.length < 8) {
    fail("INVALID_CAPTURE_FIXTURE", "capture fixture identity or article count is invalid");
  }
  const creatorIds = new Set();
  for (const [index, creator] of fixture.creators.entries()) {
    exactKeys(creator, ["username", "full_name", "avatar_image", "banner_image", "member_price", "description", "is_verified", "can_stream", "total", "zpages", "is_live", "p2paddr"], `capture creator ${index}`);
    if (!/^[a-z_]+$/.test(creator.username) || creatorIds.has(creator.username) || !/^(?:Example|Sample|Illustrative|Reference)\b/.test(creator.full_name) || creator.avatar_image !== null || creator.banner_image !== null || creator.member_price !== null || creator.can_stream !== false || creator.is_live !== false || creator.p2paddr !== null || typeof creator.is_verified !== "boolean" || !Number.isSafeInteger(creator.zpages) || creator.zpages < 1 || typeof creator.total !== "string" || !/^\d+$/.test(creator.total)) {
      fail("INVALID_CAPTURE_FIXTURE", "capture creators must be unique, visibly fictional, non-live, and non-paid");
    }
    creatorIds.add(creator.username);
  }
  const editorialCreator = fixture.creators[0];
  if (editorialCreator.username !== "example_editorial" || editorialCreator.full_name !== "Example Editorial" || editorialCreator.is_verified !== true || editorialCreator.zpages !== fixture.articles.length) {
    fail("INVALID_CAPTURE_FIXTURE", "capture editorial creator does not match the article collection");
  }
  const ids = new Set();
  const slugs = new Set();
  for (const [index, article] of fixture.articles.entries()) {
    exactKeys(article, ["free2zaddr", "vanity", "title", "description", "content", "category", "featured_image", "f2z_score", "created_at", "publish_at", "creator", "tags"], `capture article ${index}`);
    for (const key of ["free2zaddr", "vanity", "title", "description", "category", "f2z_score", "created_at", "publish_at"]) requireString(article[key], `capture article ${index}.${key}`);
    requireString(article.content, `capture article ${index}.content`, undefined, { singleLine: false });
    if (ids.has(article.free2zaddr) || slugs.has(article.vanity)) fail("INVALID_CAPTURE_FIXTURE", "capture article identities must be unique");
    ids.add(article.free2zaddr);
    slugs.add(article.vanity);
    if (article.featured_image !== null || !Array.isArray(article.tags) || article.tags.length < 1 || article.tags.some((tag) => typeof tag !== "string" || !tag)) fail("INVALID_CAPTURE_FIXTURE", `capture article ${index} media/tags are invalid`);
    exactKeys(article.creator, ["username", "full_name", "avatar_image", "member_price", "description", "is_verified", "zpages", "is_live"], `capture article ${index}.creator`);
    if (article.creator.username !== editorialCreator.username || article.creator.full_name !== editorialCreator.full_name || article.creator.avatar_image !== null || article.creator.member_price !== null || article.creator.is_live !== false || article.creator.is_verified !== true) {
      fail("INVALID_CAPTURE_FIXTURE", "capture fixture must use only the fixed fictional, non-live editorial identity");
    }
  }
  const text = fixtureText(fixture).toLowerCase();
  for (const marker of ["mock", "fixture", "debug", "seed phrase", "private key", "secret key", "checkout", "stripe", "social login", "password"]) {
    if (text.includes(marker)) fail("FORBIDDEN_CAPTURE_DISCLOSURE", `capture fixture contains forbidden marker: ${marker}`);
  }
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) fail("PRIVATE_CAPTURE_DATA", "capture fixture contains an email-like identity");
}

async function validatePlaywrightDependency(root, expectedVersion) {
  const packageJson = await readCanonicalJson(resolve(root, "package.json"), "package manifest");
  const packageLock = await readCanonicalJson(resolve(root, "package-lock.json"), "package lock");
  const versions = [
    packageJson.devDependencies?.["@playwright/test"],
    packageLock.packages?.[""]?.devDependencies?.["@playwright/test"],
    packageLock.packages?.["node_modules/@playwright/test"]?.version,
    packageLock.packages?.["node_modules/playwright"]?.version,
    packageLock.packages?.["node_modules/playwright-core"]?.version,
  ];
  if (versions.some((version) => version !== expectedVersion)) {
    fail("INVALID_CAPTURE_CONTRACT", "capture browser version must match the exact Playwright manifest and lock entries");
  }
}

export async function validateCaptureConfig({ root = canonicalRoot, screenshotSets, computeSource = true } = {}) {
  if (!Array.isArray(screenshotSets)) fail("INVALID_CAPTURE_CONTRACT", "screenshotSets are required to validate capture targets");
  const config = await readCanonicalJson(resolve(root, CAPTURE_CONFIG_PATH), "capture configuration");
  exactKeys(config, ["schemaVersion", "sourceSha", "fixtureProfile", "locale", "timezone", "fixedTime", "colorScheme", "browser", "targets", "shots"], "capture configuration");
  if (config.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(config.sourceSha) || config.fixtureProfile !== "store-v1" || config.locale !== "en-US" || config.timezone !== "UTC" || config.colorScheme !== "dark" || Number.isNaN(Date.parse(config.fixedTime))) {
    fail("INVALID_CAPTURE_CONTRACT", "capture identity, locale, clock, or color scheme is invalid");
  }
  exactKeys(config.browser, ["engine", "playwrightVersion", "containerImage", "platform"], "capture browser");
  if (config.browser.engine !== "chromium" || config.browser.playwrightVersion !== "1.62.1" || config.browser.containerImage !== "mcr.microsoft.com/playwright@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac" || config.browser.platform !== "linux/amd64") fail("INVALID_CAPTURE_CONTRACT", "capture browser must match the immutable Playwright Chromium contract");
  await validatePlaywrightDependency(root, config.browser.playwrightVersion);
  if (!Array.isArray(config.targets) || config.targets.length !== screenshotSets.length) fail("INVALID_CAPTURE_CONTRACT", "capture must declare one target per screenshot set");
  const sets = new Map(screenshotSets.map((set) => [set.id, set]));
  const targets = new Set();
  for (const target of config.targets) {
    exactKeys(target, ["setId", "cssWidth", "cssHeight", "deviceScaleFactor", "safeArea"], `capture target ${target?.setId ?? "unknown"}`);
    requireString(target.setId, "capture target setId", /^[a-z0-9.-]+$/);
    if (targets.has(target.setId)) fail("INVALID_CAPTURE_CONTRACT", `duplicate capture target ${target.setId}`);
    targets.add(target.setId);
    const set = sets.get(target.setId);
    if (!set) fail("INVALID_CAPTURE_CONTRACT", `capture target has no screenshot set: ${target.setId}`);
    requireInteger(target.cssWidth, `${target.setId} cssWidth`, { min: 320, max: 1400 });
    requireInteger(target.cssHeight, `${target.setId} cssHeight`, { min: 568, max: 1600 });
    requireInteger(target.deviceScaleFactor, `${target.setId} deviceScaleFactor`, { min: 1, max: 4 });
    if (target.cssWidth * target.deviceScaleFactor !== set.width || target.cssHeight * target.deviceScaleFactor !== set.height) {
      fail("INVALID_CAPTURE_CONTRACT", `${target.setId} CSS viewport/DPR does not produce ${set.width}x${set.height}`);
    }
    validateSafeArea(target.safeArea, target);
  }
  if (sets.size !== targets.size || [...sets.keys()].some((id) => !targets.has(id))) fail("INVALID_CAPTURE_CONTRACT", "capture targets and screenshot sets differ");
  if (!Array.isArray(config.shots) || config.shots.length !== CAPTURE_SHOTS.size) fail("INVALID_CAPTURE_CONTRACT", "capture must declare the four reviewed public product surfaces");
  const shots = new Set();
  for (const shot of config.shots) {
    exactKeys(shot, ["id", "route", "action"], `capture shot ${shot?.id ?? "unknown"}`);
    const contract = CAPTURE_SHOTS.get(shot.id);
    if (!contract || shots.has(shot.id) || shot.route !== contract.route || shot.action !== contract.action) fail("INVALID_CAPTURE_CONTRACT", `capture shot does not match the reviewed contract: ${shot?.id ?? "unknown"}`);
    shots.add(shot.id);
  }
  const fixture = await readCanonicalJson(resolve(root, CAPTURE_FIXTURE_PATH), "capture fixture");
  validateFixture(fixture, config);
  return { config, fixture, sourceDigest: computeSource ? await computeCaptureSourceDigest(root) : null };
}

export async function validateCaptureRecord({ root = canonicalRoot, screenshotSets, enforceCurrentSource = false } = {}) {
  const { config, fixture, sourceDigest: currentSourceDigest } = await validateCaptureConfig({ root, screenshotSets, computeSource: enforceCurrentSource });
  const currentContractDigest = await computeCaptureContractDigest(root);
  const record = await readCanonicalJson(resolve(root, CAPTURE_RECORD_PATH), "capture record");
  exactKeys(record, ["schemaVersion", "sourceSha", "sourceDigest", "contractDigest", "fixtureProfile", "locale", "fixedTime", "browser", "entries"], "capture record");
  if (record.schemaVersion !== 1 || record.sourceSha !== config.sourceSha || !/^[0-9a-f]{64}$/.test(record.sourceDigest) || record.contractDigest !== currentContractDigest || (enforceCurrentSource && record.sourceDigest !== currentSourceDigest) || record.fixtureProfile !== config.fixtureProfile || record.locale !== config.locale || record.fixedTime !== config.fixedTime || JSON.stringify(record.browser) !== JSON.stringify(config.browser) || !Array.isArray(record.entries)) {
    fail("STALE_CAPTURE", "capture record does not match the current deterministic source contract");
  }
  if (enforceCurrentSource) await assertCaptureSourceCommit(config.sourceSha, root);
  const sourceDigest = record.sourceDigest;
  const expectedCount = config.targets.length * config.shots.length;
  if (record.entries.length !== expectedCount) fail("INCOMPLETE_CAPTURE", `capture record requires exactly ${expectedCount} entries`);
  const keys = new Set();
  const hashes = new Set();
  for (const entry of record.entries) {
    exactKeys(entry, ["setId", "id", "path", "sha256", "renderedTextSha256", "sourceSha", "sourceDigest", "route", "action", "cssWidth", "cssHeight", "deviceScaleFactor", "width", "height", "safeArea", "disclosureScan"], `capture record entry ${entry?.setId ?? "unknown"}:${entry?.id ?? "unknown"}`);
    const target = config.targets.find(({ setId }) => setId === entry.setId);
    const shot = config.shots.find(({ id }) => id === entry.id);
    const set = screenshotSets.find(({ id }) => id === entry.setId);
    const key = `${entry.setId}:${entry.id}`;
    if (!target || !shot || !set || keys.has(key) || hashes.has(entry.sha256)) fail("INVALID_CAPTURE_RECORD", `capture record has an unknown or duplicate entry: ${key}`);
    keys.add(key);
    hashes.add(entry.sha256);
    const expectedPath = `store/media/${config.locale}/${entry.setId}/${entry.id}.png`;
    if (entry.path !== expectedPath || !/^[0-9a-f]{64}$/.test(entry.sha256) || !/^[0-9a-f]{64}$/.test(entry.renderedTextSha256) || entry.sourceSha !== config.sourceSha || entry.sourceDigest !== sourceDigest || entry.route !== shot.route || entry.action !== shot.action || entry.cssWidth !== target.cssWidth || entry.cssHeight !== target.cssHeight || entry.deviceScaleFactor !== target.deviceScaleFactor || entry.width !== set.width || entry.height !== set.height || JSON.stringify(entry.safeArea) !== JSON.stringify(target.safeArea) || entry.disclosureScan !== "passed") {
      fail("INVALID_CAPTURE_RECORD", `capture record entry does not match its deterministic plan: ${key}`);
    }
  }
  return { config, fixture, sourceDigest, record };
}
