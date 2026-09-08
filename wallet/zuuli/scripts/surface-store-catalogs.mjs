#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
import { assertMetadata, validateMedia, pngText, readCanonicalJson, exactKeys, listPngs } from './store-contract.mjs';
import { RUNTIME_EVIDENCE, validateSurfaceCaptureRecord } from './surface-store-capture-contract.mjs';

const walletRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apps = ['free2z', 'e2e2z'];
const media = [
  ['play-store-icon', 'play-store-icon-512.png', 512, 512, 1048576],
  ['play-feature-graphic', 'play-feature-graphic-1024x500.png', 1024, 500, 15728640],
];
const geometries = [
  ['phone', 'phoneScreenshots', 1080, 1920],
  ['7-inch-tablet', 'sevenInchScreenshots', 1200, 1920],
  ['10-inch-tablet', 'tenInchScreenshots', 1600, 2560],
];
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function renderBrandMedia(root) {
  const source = await readFile(resolve(root, 'src-tauri/icons/icon.png'));
  const input = PNG.sync.read(source, { checkCRC: true });
  assert.equal(input.width, 512, 'existing icon master must remain 512px');
  assert.equal(input.height, 512);
  return media.map(([id, name, width, height, maxBytes]) => {
    const size = Math.min(width, height);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#09090b"/><image x="${(width - size) / 2}" y="0" width="${size}" height="${size}" href="data:image/png;base64,${source.toString('base64')}"/></svg>`;
    const raster = new Resvg(svg).render();
    const bytes = PNG.sync.write({ width, height, data: Buffer.from(raster.pixels) }, { colorType: 2, inputColorType: 6 });
    return { spec: { id, path: `assets/store/${name}`, width, height, maxBytes, opaque: true, encodedRgbOnly: true, sha256: hash(bytes) }, bytes };
  });
}

export async function validateSurfaceCatalog({ app, root = resolve(walletRoot, app), publish = false } = {}) {
  assert(apps.includes(app), 'unknown store app');
  assert.equal(publish, false, 'surface catalogs are not approved for publication');
  const manifest = await readCanonicalJson(resolve(root, 'store/manifest.json'), 'surface manifest');
  exactKeys(manifest, ['schemaVersion', 'phase', 'publicationReady', 'application', 'locales', 'classification', 'brandMedia', 'screenshotSets', 'capturePolicy'], 'surface manifest');
  assert.equal(manifest.schemaVersion, 1);
  assert(['foundation', 'captured'].includes(manifest.phase), 'unknown draft phase');
  assert.equal(manifest.publicationReady, false);
  const identity = JSON.parse(await readFile(resolve(root, 'store-identity.json')));
  const tauri = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json')));
  const expectedId = `cash.free2z.${app}`;
  assert.equal(identity.applicationId, expectedId);
  assert.equal(tauri.identifier, expectedId);
  assert.deepEqual(manifest.application, {
    bundleId: expectedId, playPackageName: expectedId, defaultLocale: 'en-US',
    supportEmail: 'help@free2z.com', supportUrl: 'https://free2z.cash/docs/',
    marketingUrl: 'https://free2z.cash/', privacyPolicyUrl: 'https://free2z.cash/docs/legal/privacy-policy/',
  });
  assert.deepEqual(manifest.locales, [{ id: 'en-US', playLocale: 'en-US', copyStatus: 'proposed-console-reconciliation-required', playMetadata: 'store/locales/en-US/play.json' }]);
  const copy = await readCanonicalJson(resolve(root, 'store/locales/en-US/play.json'), 'Play copy');
  assertMetadata(copy, 'play', manifest.application, `${app} Play copy`);
  assert.equal(copy.title, app === 'free2z' ? 'Free2Z' : 'E2E2Z');
  assert.deepEqual(manifest.classification, { playCategory: app === 'free2z' ? 'SOCIAL' : 'COMMUNICATION', reviewStatus: 'proposed-owner-store-review-required', automaticRatingSubmissionAllowed: false });
  const captured = manifest.phase === 'captured'
    ? (await validateSurfaceCaptureRecord(app, { root: dirname(root) })).record : null;
  const entries = captured?.entries ?? [];
  assert.deepEqual(manifest.screenshotSets, geometries.map(([name, apiType, width, height]) => ({ id: `play-${name}-portrait`, provider: 'play', apiType, locale: 'en-US', width, height, minCount: 2, maxCount: 8, maxBytes: 8388608, files: entries.filter((entry) => entry.setId === `play-${name}-portrait`).map(({ id, path, sha256, sourceSha }) => ({ id, path, sha256, sourceSha, reviewIssue: 989 })) })));
  assert.deepEqual(manifest.capturePolicy, {
    status: captured ? 'captured-owner-review-required' : 'deferred', reviewIssue: 989, releaseEquivalentBuildRequired: true,
    safeAreasRequired: true, realSeedOrPrivateDataAllowed: false, testerIdentityAllowed: false,
    debugOrMockDisclosureAllowed: false, reviewRequired: true,
    forbiddenEmbeddedText: ['seed phrase', 'private key', 'secret key', 'debug build', 'mock mode', 'fixture', 'localhost', 'playwright'],
    ...(captured ? { runtimeEvidence: RUNTIME_EVIDENCE, sourceSha: captured.sourceSha, sourceDigest: captured.sourceDigest, contractDigest: captured.contractDigest, captureConfig: 'store/capture.json', captureRecord: 'store/capture-record.json' } : {}),
  });
  const generated = await renderBrandMedia(root);
  assert.deepEqual(manifest.brandMedia, generated.map(({ spec }) => spec), 'brand source or manifest drift; regenerate and review');
  const hashes = new Set();
  for (const { spec, bytes } of generated) {
    const checked = await validateMedia(root, spec, spec.id, hashes);
    assert(bytes.equals(checked.bytesForTextScan), 'generated brand media drift');
    const embedded = pngText(checked.bytesForTextScan, spec.id);
    for (const phrase of manifest.capturePolicy.forbiddenEmbeddedText) assert(!embedded.includes(phrase), `forbidden PNG marker: ${phrase}`);
  }
  for (const entry of entries) {
    const { id, path, width, height, sha256 } = entry;
    const checked = await validateMedia(root, { id, path, width, height, sha256, maxBytes: 8388608, opaque: true, encodedRgbOnly: true }, `${app} ${entry.setId}/${id}`, hashes);
    const embedded = pngText(checked.bytesForTextScan, path);
    for (const phrase of manifest.capturePolicy.forbiddenEmbeddedText) assert(!embedded.includes(phrase), `forbidden PNG marker: ${phrase}`);
  }
  const declared = [...generated.map(({ spec }) => resolve(root, spec.path)), ...entries.map((entry) => resolve(root, entry.path))].sort();
  const present = [...await listPngs(resolve(root, 'assets/store')), ...await listPngs(resolve(root, 'store'))].sort();
  assert.deepEqual(present, declared, 'undeclared PNGs, including unapproved screenshots, are forbidden');
  return { app, phase: manifest.phase, publicationReady: false, brandMedia: generated.length, screenshots: entries.length };
}

export async function main(argv = process.argv.slice(2)) {
  assert(argv.every((arg) => ['--generate', '--publish'].includes(arg)), 'unknown argument');
  assert(!argv.includes('--publish'), 'surface catalogs are not approved for publication');
  for (const app of apps) {
    const root = resolve(walletRoot, app);
    if (argv.includes('--generate')) {
      const manifestPath = resolve(root, 'store/manifest.json');
      const manifest = await readCanonicalJson(manifestPath, 'surface manifest');
      const generated = await renderBrandMedia(root);
      await mkdir(resolve(root, 'assets/store'), { recursive: true });
      for (const { spec, bytes } of generated) await writeFile(resolve(root, spec.path), bytes);
      manifest.brandMedia = generated.map(({ spec }) => spec);
      await writeFile(manifestPath, canonical(manifest));
    }
    process.stdout.write(`${JSON.stringify(await validateSurfaceCatalog({ app }))}\n`);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
