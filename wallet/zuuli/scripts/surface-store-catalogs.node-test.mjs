import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { main, validateSurfaceCatalog } from './surface-store-catalogs.mjs';
import { canonical, contractInputs, sha256 } from './surface-store-capture-contract.mjs';

const walletRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
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
  const inputs = new Set([...contractInputs('e2e2z'), ...['store', 'assets/store', 'src-tauri/icons/icon.png', 'src-tauri/tauri.conf.json', 'store-identity.json', 'package.json', 'package-lock.json'].map((p) => `e2e2z/${p}`)]);
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
  await t.test('foundation phase still requires empty screenshot inventory', async () => {
    const manifest = JSON.parse(original); manifest.phase = 'foundation';
    manifest.capturePolicy.status = 'deferred';
    for (const key of ['runtimeEvidence', 'sourceSha', 'sourceDigest', 'contractDigest', 'captureConfig', 'captureRecord']) delete manifest.capturePolicy[key];
    for (const set of manifest.screenshotSets) set.files = [];
    await writeFile(path, canonical(manifest));
    await assert.rejects(validateSurfaceCatalog({ app: 'e2e2z', root }), /undeclared PNGs/);
    await rm(resolve(root, 'store/media'), { recursive: true });
    assert.equal((await validateSurfaceCatalog({ app: 'e2e2z', root })).phase, 'foundation');
  });
});
