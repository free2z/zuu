import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { main, validateSurfaceCatalog } from './surface-store-catalogs.mjs';
import { canonical, contractInputs, inputDigest, renderInputs, sha256, validateSurfaceCaptureRecord } from './surface-store-capture-contract.mjs';

const walletRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function withTextMarker(png) {
  const data = Buffer.from('review\0fixture');
  const typeAndData = Buffer.concat([Buffer.from('tEXt'), data]);
  let crc = -1;
  for (const byte of typeAndData) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ -1) >>> 0);
  return Buffer.concat([png.subarray(0, -12), length, typeAndData, checksum, png.subarray(-12)]);
}
for (const app of ['free2z', 'e2e2z']) {
  test(`${app} validates its captured draft catalog and refuses publication`, async () => {
    assert.deepEqual(await validateSurfaceCatalog({ app }), { app, phase: 'captured', publicationReady: false, brandMedia: 2, screenshots: 6 });
    await assert.rejects(validateSurfaceCatalog({ app, publish: true }), /not approved/);
  });
}
test('publication flag cannot become a generation request', async () => {
  await assert.rejects(main(['--generate', '--publish']), /not approved/);
});
test('catalog and saved-pixel mutation controls fail closed', async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'surface-store-test-'));
  const root = resolve(fixture, 'e2e2z');
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const inputs = new Set([...contractInputs('e2e2z'), ...renderInputs('e2e2z'), ...['store', 'assets/store', 'src-tauri/icons/icon.png', 'store-identity.json'].map((p) => `e2e2z/${p}`)]);
  for (const file of inputs) {
    await mkdir(dirname(resolve(fixture, file)), { recursive: true });
    await cp(resolve(walletRoot, file), resolve(fixture, file), { recursive: true });
  }
  const path = resolve(root, 'store/manifest.json');
  const original = await readFile(path, 'utf8');
  const cases = [
    ['publication bypass', (m) => { m.publicationReady = true; }],
    ['captured without provenance', (m) => { delete m.capturePolicy.sourceSha; }],
    ['wrong application', (m) => { m.application.bundleId = 'cash.free2z.zuuli'; }],
    ['unreviewed copy approval', (m) => { m.locales[0].copyStatus = 'approved'; }],
    ['incorrect phone geometry', (m) => { m.screenshotSets[0].width = 1000; }],
    ['unproven screenshot', (m) => { m.screenshotSets[0].files.push({ path: 'conversation.png' }); }],
    ['unsafe capture policy', (m) => { m.capturePolicy.realSeedOrPrivateDataAllowed = true; }],
    ['physical device claim', (m) => { m.capturePolicy.runtimeEvidence = 'physical-android'; }],
    ['hash drift', (m) => { m.brandMedia[0].sha256 = '0'.repeat(64); }],
    ['path traversal', (m) => { m.brandMedia[0].path = '../icon.png'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const manifest = JSON.parse(original); mutate(manifest);
    await writeFile(path, canonical(manifest));
    await assert.rejects(validateSurfaceCatalog({ app: 'e2e2z', root }));
  });
  await writeFile(path, original);
  await validateSurfaceCatalog({ app: 'e2e2z', root });
  await t.test('undeclared screenshot', async () => {
    await cp(resolve(root, 'assets/store/play-store-icon-512.png'), resolve(root, 'store/conversation.png'));
    await assert.rejects(validateSurfaceCatalog({ app: 'e2e2z', root }), /undeclared PNGs/);
    await rm(resolve(root, 'store/conversation.png'));
  });
  const recordPath = resolve(root, 'store/capture-record.json');
  const originalRecord = await readFile(recordPath, 'utf8');
  const screenshotPath = resolve(root, JSON.parse(originalRecord).entries[0].path);
  const originalPng = await readFile(screenshotPath);
  for (const [name, alter, repin, expected] of [
    ['corrupt screenshot', () => Buffer.from('not a PNG'), false, /not a PNG/],
    ['changed screenshot bytes', (b) => Buffer.concat([b, Buffer.from('drift')]), false, /SHA-256/],
    ['wrong dimensions even with repinned hashes', () => PNG.sync.write({ width: 1, height: 1, data: Buffer.from([0, 0, 0, 255]) }, { colorType: 2 }), true, /exactly 1080x1920/],
    ['RGBA even with repinned hashes', (b) => PNG.sync.write(PNG.sync.read(b), { colorType: 6 }), true, /encoded as RGB/],
    ['corrupt CRC even with repinned hashes', (b) => { const changed = Buffer.from(b); changed[29] ^= 1; return changed; }, true, /valid PNG/],
    ['forbidden PNG marker even with repinned hashes', withTextMarker, true, /forbidden PNG marker/],
  ]) await t.test(name, async () => {
    const bytes = alter(originalPng);
    await writeFile(screenshotPath, bytes);
    if (repin) {
      const record = JSON.parse(originalRecord), manifest = JSON.parse(original);
      record.entries[0].sha256 = sha256(bytes);
      const proof = sha256(canonical(record.entries));
      record.reproducibility.firstPassSha256 = proof; record.reproducibility.secondPassSha256 = proof;
      manifest.screenshotSets[0].files[0].sha256 = sha256(bytes);
      await writeFile(recordPath, canonical(record)); await writeFile(path, canonical(manifest));
    }
    await assert.rejects(validateSurfaceCatalog({ app: 'e2e2z', root }), expected);
    await writeFile(screenshotPath, originalPng); await writeFile(recordPath, originalRecord); await writeFile(path, original);
  });
  // A historical record stays valid after product development; a review of
  // current listing media must explicitly refuse that same stale evidence.
  for (const input of ['e2e2z/src/App.tsx', 'shared/src/index.ts', 'plugins/tauri-plugin-f2zmsg/internal-directory.conf']) await t.test(`current-source rejects drift in ${input}`, async () => {
    const record = JSON.parse(originalRecord);
    // Establish the test tree's baseline, independent of future product changes.
    record.sourceDigest = await inputDigest(fixture, renderInputs('e2e2z'));
    for (const entry of record.entries) entry.sourceDigest = record.sourceDigest;
    const proof = sha256(canonical(record.entries));
    record.reproducibility = { passes: 2, firstPassSha256: proof, secondPassSha256: proof };
    await writeFile(recordPath, canonical(record));
    const file = resolve(fixture, input), bytes = await readFile(file);
    await writeFile(file, Buffer.concat([bytes, Buffer.from('\n// changed input\n')]));
    await validateSurfaceCaptureRecord('e2e2z', { root: fixture });
    await assert.rejects(validateSurfaceCaptureRecord('e2e2z', { root: fixture, enforceCurrentSource: true }), /capture render inputs are stale/);
    await assert.rejects(validateSurfaceCatalog({ app: 'e2e2z', root, enforceCurrentSource: true }), /capture render inputs are stale/);
    await writeFile(file, bytes); await writeFile(recordPath, originalRecord);
  });
  await t.test('foundation phase still requires empty screenshot inventory', async () => {
    const manifest = JSON.parse(original); manifest.phase = 'foundation';
    manifest.capturePolicy.status = 'deferred';
    for (const key of ['runtimeEvidence', 'sourceSha', 'sourceDigest', 'contractDigest', 'captureConfig', 'captureRecord']) delete manifest.capturePolicy[key];
    for (const set of manifest.screenshotSets) set.files = [];
    await writeFile(path, canonical(manifest));
    await assert.rejects(validateSurfaceCatalog({ app: 'e2e2z', root }), /undeclared PNGs/);
    await rm(resolve(root, 'store/media'), { recursive: true });
    assert.equal((await validateSurfaceCatalog({ app: 'e2e2z', root })).phase, 'foundation');
    await assert.rejects(validateSurfaceCatalog({ app: 'e2e2z', root, enforceCurrentSource: true }), /requires captured media/);
  });
});
