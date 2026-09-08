import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, validateSurfaceCatalog } from './surface-store-catalogs.mjs';

const walletRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
for (const app of ['free2z', 'e2e2z']) {
  test(`${app} validates its draft catalog and refuses publication`, async () => {
    assert.deepEqual(await validateSurfaceCatalog({ app }), { app, phase: 'foundation', publicationReady: false, brandMedia: 2, screenshots: 0 });
    await assert.rejects(validateSurfaceCatalog({ app, publish: true }), /not approved/);
  });
}
test('publication flag cannot become a generation request', async () => {
  await assert.rejects(main(['--generate', '--publish']), /not approved/);
});
test('catalog mutation controls fail closed', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'surface-store-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['store', 'assets/store', 'src-tauri/icons/icon.png', 'src-tauri/tauri.conf.json', 'store-identity.json']) {
    await cp(resolve(walletRoot, 'e2e2z', file), resolve(root, file), { recursive: true });
  }
  const path = resolve(root, 'store/manifest.json');
  const original = await readFile(path, 'utf8');
  const cases = [
    ['publication bypass', (m) => { m.publicationReady = true; }],
    ['captured without provenance', (m) => { m.phase = 'captured'; }],
    ['wrong application', (m) => { m.application.bundleId = 'cash.free2z.zuuli'; }],
    ['unreviewed copy approval', (m) => { m.locales[0].copyStatus = 'approved'; }],
    ['incorrect phone geometry', (m) => { m.screenshotSets[0].width = 1000; }],
    ['unproven screenshot', (m) => { m.screenshotSets[0].files.push({ path: 'conversation.png' }); }],
    ['unsafe capture policy', (m) => { m.capturePolicy.realSeedOrPrivateDataAllowed = true; }],
    ['hash drift', (m) => { m.brandMedia[0].sha256 = '0'.repeat(64); }],
    ['path traversal', (m) => { m.brandMedia[0].path = '../icon.png'; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const manifest = JSON.parse(original);
      mutate(manifest);
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(validateSurfaceCatalog({ app: 'e2e2z', root }));
    });
  }
  await writeFile(path, original);
  await t.test('undeclared screenshot', async () => {
    await cp(resolve(root, 'assets/store/play-store-icon-512.png'), resolve(root, 'store/conversation.png'));
    await assert.rejects(validateSurfaceCatalog({ app: 'e2e2z', root }), /undeclared PNGs/);
    await rm(resolve(root, 'store/conversation.png'));
  });
  await t.test('corrupted image', async () => {
    await writeFile(resolve(root, 'assets/store/play-store-icon-512.png'), 'not a PNG');
    await assert.rejects(validateSurfaceCatalog({ app: 'e2e2z', root }), /not a PNG/);
  });
});
