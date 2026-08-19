import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { StoreContractError, validateStoreContract } from "./store-contract.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-store-contract-"));
  await mkdir(resolve(root, "assets"), { recursive: true });
  await cp(resolve(projectRoot, "store"), resolve(root, "store"), { recursive: true });
  await cp(resolve(projectRoot, "assets/store"), resolve(root, "assets/store"), { recursive: true });
  await cp(resolve(projectRoot, "release.json"), resolve(root, "release.json"));
  return root;
}

async function manifest(root) {
  return JSON.parse(await readFile(resolve(root, "store/manifest.json"), "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => error instanceof StoreContractError && error.code === code);
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

function insertTextChunk(png, text) {
  const type = Buffer.from("tEXt");
  const data = Buffer.from(`review\0${text}`);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)]);
}

test("the repository foundation contract validates and publication fails closed", async () => {
  const result = await validateStoreContract({ root: projectRoot });
  assert.equal(result.phase, "foundation");
  assert.equal(result.publicationReady, false);
  assert.deepEqual(result.screenshotSets.map(({ count }) => count), [0, 0, 0, 0, 0]);
  await rejectsCode(() => validateStoreContract({ root: projectRoot, publish: true }), "NOT_PUBLICATION_READY");
});

test("metadata must be canonical and within provider limits", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const applePath = resolve(root, "store/locales/en-US/apple.json");
  const apple = JSON.parse(await readFile(applePath, "utf8"));
  apple.name = "X".repeat(31);
  await writeJson(applePath, apple);
  await rejectsCode(() => validateStoreContract({ root }), "INVALID_METADATA");
  apple.name = "ZUULI";
  await writeFile(applePath, JSON.stringify(apple));
  await rejectsCode(() => validateStoreContract({ root }), "NONCANONICAL_JSON");
});

test("media hashes, dimensions, RGB encoding, and fixed contracts are authoritative", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = resolve(root, "store/manifest.json");
  const value = await manifest(root);
  value.brandMedia[1].sha256 = value.brandMedia[0].sha256;
  value.brandMedia[1].path = value.brandMedia[0].path;
  value.brandMedia[1].width = 1024;
  value.brandMedia[1].height = 1024;
  await writeJson(manifestPath, value);
  await rejectsCode(() => validateStoreContract({ root }), "INVALID_MANIFEST");

  const fresh = await manifest(projectRoot);
  const imagePath = resolve(root, fresh.brandMedia[0].path);
  const png = new PNG({ width: 3, height: 2 });
  png.data.fill(255);
  const bytes = PNG.sync.write(png, { colorType: 2 });
  await writeFile(imagePath, bytes);
  fresh.brandMedia[0].sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeJson(manifestPath, fresh);
  await rejectsCode(() => validateStoreContract({ root }), "INVALID_MEDIA");
});

test("publication-ready screenshot declarations reject duplicate content", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = resolve(root, "store/manifest.json");
  const value = await manifest(root);
  value.phase = "ready";
  value.publicationReady = true;
  value.locales[0].copyStatus = "approved";
  value.classification.reviewStatus = "approved";
  value.capturePolicy.status = "approved";
  value.capturePolicy.blockedByIssues = [];
  const set = value.screenshotSets[0];
  const png = new PNG({ width: set.width, height: set.height });
  png.data.fill(255);
  const bytes = PNG.sync.write(png, { colorType: 2 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  await mkdir(resolve(root, "store/media/en-US"), { recursive: true });
  await writeFile(resolve(root, "store/media/en-US/duplicate.png"), bytes);
  set.files = Array.from({ length: 4 }, (_, index) => ({ id: `duplicate-${index}`, path: "store/media/en-US/duplicate.png", sha256: digest, sourceSha: "a".repeat(40), reviewIssue: 387 }));
  await writeJson(manifestPath, value);
  await rejectsCode(() => validateStoreContract({ root, publish: true }), "DUPLICATE_MEDIA");
});

test("screenshot file IDs are unique within each upload set", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = resolve(root, "store/manifest.json");
  const value = await manifest(root);
  value.phase = "ready";
  value.publicationReady = true;
  value.locales[0].copyStatus = "approved";
  value.classification.reviewStatus = "approved";
  value.capturePolicy.status = "approved";
  value.capturePolicy.blockedByIssues = [];
  const set = value.screenshotSets[0];
  const png = new PNG({ width: set.width, height: set.height });
  png.data.fill(255);
  const bytes = PNG.sync.write(png, { colorType: 2 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  await mkdir(resolve(root, "store/media/en-US"), { recursive: true });
  await writeFile(resolve(root, "store/media/en-US/duplicate-id.png"), bytes);
  set.files = Array.from({ length: 4 }, () => ({ id: "same-id", path: "store/media/en-US/duplicate-id.png", sha256: digest, sourceSha: "a".repeat(40), reviewIssue: 387 }));
  await writeJson(manifestPath, value);
  await rejectsCode(() => validateStoreContract({ root, publish: true }), "INVALID_MANIFEST");
});

test("forbidden textual PNG chunks are rejected without logging their payload", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = resolve(root, "store/manifest.json");
  const value = await manifest(root);
  const spec = value.brandMedia[0];
  const mediaPath = resolve(root, spec.path);
  const bytes = insertTextChunk(await readFile(mediaPath), "seed phrase");
  await writeFile(mediaPath, bytes);
  spec.sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeJson(manifestPath, value);
  await assert.rejects(() => validateStoreContract({ root }), (error) => error instanceof StoreContractError && error.code === "FORBIDDEN_MEDIA_TEXT" && !error.message.includes("seed phrase"));
});

test("declared paths cannot traverse or resolve through symlinks", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = resolve(root, "store/manifest.json");
  const value = await manifest(root);
  value.locales[0].appleMetadata = "store/locales/en-US/../en-US/apple.json";
  await writeJson(manifestPath, value);
  await rejectsCode(() => validateStoreContract({ root }), "UNSAFE_PATH");

  const actual = resolve(root, "store/locales/en-US/apple.json");
  const link = resolve(root, "store/locales/en-US/link.json");
  await symlink(actual, link);
  value.locales[0].appleMetadata = "store/locales/en-US/link.json";
  await writeJson(manifestPath, value);
  await rejectsCode(() => validateStoreContract({ root }), "UNSAFE_PATH");
});

test("undeclared screenshot media is rejected during foundation", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "store/media/en-US"), { recursive: true });
  await writeFile(resolve(root, "store/media/en-US/unreviewed.png"), await readFile(resolve(root, "assets/store/play-store-icon-512.png")));
  await rejectsCode(() => validateStoreContract({ root }), "UNDECLARED_MEDIA");
});

test("application and contact identities cannot drift", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = resolve(root, "store/manifest.json");
  const value = await manifest(root);
  value.application.bundleId = "example.invalid";
  await writeJson(manifestPath, value);
  await rejectsCode(() => validateStoreContract({ root }), "IDENTITY_MISMATCH");
});

test("release identity is canonical, returned, and cannot drift", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const valid = await validateStoreContract({ root });
  assert.deepEqual(valid.release, { version: "0.1.0", build: 10 });
  const releasePath = resolve(root, "release.json");
  const release = JSON.parse(await readFile(releasePath, "utf8"));
  release.applicationId = "example.invalid";
  await writeJson(releasePath, release);
  await rejectsCode(() => validateStoreContract({ root }), "IDENTITY_MISMATCH");
});

test("provider locale mappings must be one-to-one", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = resolve(root, "store/manifest.json");
  const value = await manifest(root);
  value.locales.push({ ...value.locales[0], id: "fr-FR" });
  await writeJson(manifestPath, value);
  await rejectsCode(() => validateStoreContract({ root }), "INVALID_MANIFEST");
});
