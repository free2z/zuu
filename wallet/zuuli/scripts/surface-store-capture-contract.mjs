import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureInputFiles, assertNoLocalCaptureOverrides, readCanonicalJson } from './store-screenshot-contract.mjs';

export const walletRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const BROWSER = Object.freeze({ engine: 'chromium', playwrightVersion: '1.62.1', containerImage: 'mcr.microsoft.com/playwright@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac', platform: 'linux/amd64' });
export const TARGETS = [
  { setId: 'play-phone-portrait', cssWidth: 360, cssHeight: 640, deviceScaleFactor: 3 },
  { setId: 'play-7-inch-tablet-portrait', cssWidth: 600, cssHeight: 960, deviceScaleFactor: 2 },
  { setId: 'play-10-inch-tablet-portrait', cssWidth: 800, cssHeight: 1280, deviceScaleFactor: 2 },
].map((target) => ({ ...target, safeArea: { top: 24, right: 0, bottom: 24, left: 0 } }));
export const SHOTS = {
  free2z: [{ id: '01-articles-fresh', route: '/articles', action: 'fresh' }, { id: '02-article-reader', route: '/articles/why-shielded-defaults-matter', action: 'article-reader' }],
  e2e2z: [{ id: '01-enrollment-unavailable', route: '/', action: 'enrollment-unavailable' }, { id: '02-local-diagnostics', route: '/', action: 'local-diagnostics' }],
};
export const FORBIDDEN_TEXT = /\b(?:mock|fixture|debug|localhost|playwright|seed phrase|private key|secret key)\b|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/iu;
export const RUNTIME_EVIDENCE = 'linux-chromium-fixture-render-not-physical-android-device';
const HEX = /^[0-9a-f]{64}$/;
const CONFIG = 'store/capture.json';
const RECORD = 'store/capture-record.json';
const commonInputs = ['index.html', 'package.json', 'package-lock.json', 'postcss.config.cjs', 'src', 'tailwind.config.cjs', 'tsconfig.json', 'tsconfig.build.json', 'release.json'];
export function renderInputs(app) {
  assert(Object.hasOwn(SHOTS, app), 'unknown capture app');
  return [...commonInputs.map((p) => `${app}/${p}`), ...(app === 'free2z' ? ['free2z/vite.config.ts', 'free2z/public'] : ['e2e2z/src-tauri/src', 'plugins/tauri-plugin-f2zmsg/src']), 'shared/package.json', 'shared/src'];
}
export function contractInputs(app) {
  return [`${app}/${CONFIG}`, 'zuuli/package.json', 'zuuli/package-lock.json',
    'zuuli/scripts/surface-store-capture.mjs', 'zuuli/scripts/surface-store-capture-contract.mjs',
    'zuuli/scripts/surface-store-catalogs.mjs', 'zuuli/scripts/store-contract.mjs',
    'zuuli/scripts/store-screenshot-contract.mjs', 'zuuli/scripts/store-screenshot-capture.mjs',
    'zuuli/store/fixtures/en-US/articles.json'];
}
export async function inputDigest(root, inputs) {
  const base = await realpath(root);
  const digest = createHash('sha256');
  for (const file of await captureInputFiles(root, inputs)) {
    const path = await realpath(resolve(root, file));
    assert(path.startsWith(`${base}${sep}`), 'capture input escapes wallet root');
    const bytes = await readFile(path);
    digest.update(`${file}\0${bytes.length}\0`).update(bytes).update('\0');
  }
  return digest.digest('hex');
}
export async function captureDigests(app, root = walletRoot) {
  return { sourceDigest: await inputDigest(root, renderInputs(app)), contractDigest: await inputDigest(root, contractInputs(app)) };
}
export async function assertSourceCommit(app, sourceSha, root = walletRoot) {
  assert(/^[0-9a-f]{40}$/.test(sourceSha), 'capture needs exact source commit');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['cat-file', '-e', `${sourceSha}^{commit}`]);
  const inputs = renderInputs(app);
  assert.equal(git(['diff', '--name-only', sourceSha, '--', ...inputs]), '', 'render inputs differ from source commit');
  assert.equal(git(['ls-files', '--others', '--exclude-standard', '--', ...inputs]), '', 'untracked render inputs');
}
export async function assertCaptureEnvironment(app, root = walletRoot) {
  for (const subdir of ['', app, 'shared', 'zuuli']) await assertNoLocalCaptureOverrides(resolve(root, subdir));
  const files = await readdir(resolve(root, app));
  const configs = files.filter((file) => /^(?:vite|postcss|tailwind)\.config\./.test(file)).sort();
  const expected = ['postcss.config.cjs', 'tailwind.config.cjs', ...(app === 'free2z' ? ['vite.config.ts'] : [])].sort();
  assert.deepEqual(configs, expected, 'unregistered build configuration could bypass source hashing');
  assert(app === 'free2z' || !files.includes('public'), 'register the new public assets in the capture source inventory first');
}
export function captureConfig(app, sourceSha) {
  assert(Object.hasOwn(SHOTS, app), 'unknown capture app');
  return { schemaVersion: 1, app, sourceSha, fixtureProfile: app === 'free2z' ? 'store-v1' : 'unenrolled-native-v1', locale: 'en-US', timezone: 'UTC', fixedTime: '2026-09-07T12:00:00.000Z', colorScheme: 'dark', browser: BROWSER, targets: TARGETS, shots: SHOTS[app] };
}
export async function validateSurfaceCaptureConfig(app, root = walletRoot) {
  const config = await readCanonicalJson(resolve(root, app, CONFIG), 'surface capture config');
  assert(/^[0-9a-f]{40}$/.test(config.sourceSha), 'invalid capture source SHA');
  assert.deepEqual(config, captureConfig(app, config.sourceSha), 'capture config differs from reviewed app plan');
  for (const project of [app, 'zuuli']) {
    const manifest = await readCanonicalJson(resolve(root, project, 'package.json'), 'capture package');
    const lock = await readCanonicalJson(resolve(root, project, 'package-lock.json'), 'capture lock');
    const versions = [manifest.devDependencies['@playwright/test'], lock.packages[''].devDependencies['@playwright/test'], ...['@playwright/test', 'playwright', 'playwright-core'].map((p) => lock.packages[`node_modules/${p}`].version)];
    assert(versions.every((v) => v === BROWSER.playwrightVersion), 'Playwright lock/version mismatch');
  }
  return config;
}

// Keep the legacy ZUULI runner/contract byte-identical: its historical capture
// pins those files. This app-selected matrix follows the same closed record
// shape, with explicit two-pass evidence and shared-package source coverage.
export function validateRecordMatrix(config, record, digests) {
  const { entries, reproducibility, ...header } = record;
  assert.deepEqual(header, { schemaVersion: 1, app: config.app, runtimeEvidence: RUNTIME_EVIDENCE, sourceSha: config.sourceSha, ...digests, fixtureProfile: config.fixtureProfile, locale: config.locale, fixedTime: config.fixedTime, browser: config.browser });
  assert(Array.isArray(entries));
  assert.equal(entries.length, config.targets.length * config.shots.length, 'incomplete screenshot matrix');
  const hashes = new Set();
  for (const [index, entry] of entries.entries()) {
    const target = config.targets[Math.floor(index / config.shots.length)];
    const shot = config.shots[index % config.shots.length];
    const { sha256: hash, renderedTextSha256, ...shape } = entry;
    assert(HEX.test(hash) && HEX.test(renderedTextSha256), 'invalid capture hashes');
    assert(!hashes.has(hash), 'duplicate screenshot pixels');
    hashes.add(hash);
    assert.deepEqual(shape, { setId: target.setId, ...shot, path: `store/media/${config.locale}/${target.setId}/${shot.id}.png`, sourceSha: config.sourceSha, sourceDigest: digests.sourceDigest, cssWidth: target.cssWidth, cssHeight: target.cssHeight, deviceScaleFactor: target.deviceScaleFactor, width: target.cssWidth * target.deviceScaleFactor, height: target.cssHeight * target.deviceScaleFactor, safeArea: target.safeArea, disclosureScan: 'passed' });
  }
  const proof = sha256(canonical(entries));
  assert.deepEqual(reproducibility, { passes: 2, firstPassSha256: proof, secondPassSha256: proof }, 'two identical capture passes required');
}
export async function validateSurfaceCaptureRecord(app, { root = walletRoot, enforceCurrentSource = false } = {}) {
  const config = await validateSurfaceCaptureConfig(app, root);
  const record = await readCanonicalJson(resolve(root, app, RECORD), 'surface capture record');
  const contractDigest = await inputDigest(root, contractInputs(app));
  assert(HEX.test(record.sourceDigest), 'invalid source digest');
  const sourceDigest = enforceCurrentSource ? await inputDigest(root, renderInputs(app)) : record.sourceDigest;
  if (enforceCurrentSource) await assertSourceCommit(app, config.sourceSha, root);
  validateRecordMatrix(config, record, { sourceDigest, contractDigest });
  return { config, record };
}
