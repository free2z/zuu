import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { captureConfig, canonical, sha256, validateRecordMatrix, inputDigest, renderInputs, FORBIDDEN_TEXT } from './surface-store-capture-contract.mjs';
import { proveIdenticalPasses, allowedPublicRequest } from './surface-store-capture.mjs';

function example(app = 'e2e2z') {
  const config = captureConfig(app, 'a'.repeat(40));
  const digests = { sourceDigest: 'b'.repeat(64), contractDigest: 'c'.repeat(64) };
  const entries = config.targets.flatMap((target) => config.shots.map((shot) => ({
    setId: target.setId, ...shot, path: `store/media/en-US/${target.setId}/${shot.id}.png`,
    sha256: sha256(`${target.setId}:${shot.id}`), renderedTextSha256: sha256(shot.id),
    sourceSha: config.sourceSha, sourceDigest: digests.sourceDigest,
    cssWidth: target.cssWidth, cssHeight: target.cssHeight, deviceScaleFactor: target.deviceScaleFactor,
    width: target.cssWidth * target.deviceScaleFactor, height: target.cssHeight * target.deviceScaleFactor,
    safeArea: target.safeArea, disclosureScan: 'passed',
  })));
  const record = { schemaVersion: 1, app, sourceSha: config.sourceSha, ...digests, fixtureProfile: config.fixtureProfile, locale: config.locale, fixedTime: config.fixedTime, browser: config.browser, entries, reproducibility: proveIdenticalPasses(entries, structuredClone(entries)) };
  return { config, digests, record };
}
test('each app requires the complete reviewed matrix and two identical passes', () => {
  for (const app of ['free2z', 'e2e2z']) {
    const { config, record, digests } = example(app);
    validateRecordMatrix(config, record, digests);
    for (const mutate of [
      (r) => r.entries.pop(),
      (r) => { r.entries[0].sha256 = r.entries[1].sha256; },
      (r) => { r.entries[0].width = 512; },
      (r) => { r.entries[0].path = '../private.png'; },
      (r) => { r.entries[0].action = 'conversation'; },
      (r) => { r.entries[0].sourceSha = 'd'.repeat(40); },
      (r) => { r.sourceDigest = 'd'.repeat(64); },
      (r) => { r.contractDigest = 'd'.repeat(64); },
      (r) => { r.reproducibility.passes = 1; },
      (r) => { r.reproducibility.secondPassSha256 = 'd'.repeat(64); },
    ]) {
      const changed = structuredClone(record); mutate(changed);
      assert.throws(() => validateRecordMatrix(config, changed, digests));
    }
    const second = structuredClone(record.entries); second[0].renderedTextSha256 = 'e'.repeat(64);
    assert.throws(() => proveIdenticalPasses(record.entries, second), /differ/);
  }
});
test('public fixture allowlist never admits account requests or E2E2Z transport', () => {
  assert(allowedPublicRequest('free2z', 'fresh', 'GET https://free2z.cash/api/zpage/?homeSort=popular&page=1&page_size=24'));
  for (const app of ['free2z', 'e2e2z']) for (const action of ['fresh', 'article-reader', 'enrollment-unavailable', 'local-diagnostics']) {
    assert(!allowedPublicRequest(app, action, 'GET https://free2z.cash/api/creator/me/'));
    assert(!allowedPublicRequest(app, action, 'POST https://free2z.cash/api/zpage/'));
    assert(!allowedPublicRequest(app, action, 'GET https://attacker.example/api/zpage/'));
  }
  assert(!allowedPublicRequest('e2e2z', 'fresh', 'GET https://free2z.cash/api/zpage/?homeSort=popular&page=1&page_size=24'));
  assert(FORBIDDEN_TEXT.test('private key')); assert(FORBIDDEN_TEXT.test('person@example.com'));
});
test('source digest covers shared code and rejects symbolic links', async (t) => {
  for (const app of ['free2z', 'e2e2z']) assert(renderInputs(app).includes('shared/src'));
  const root = await mkdtemp(resolve(tmpdir(), 'surface-source-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'shared/src'), { recursive: true });
  await writeFile(resolve(root, 'shared/src/index.ts'), 'export const value = 1;');
  const before = await inputDigest(root, ['shared/src']);
  await writeFile(resolve(root, 'shared/src/index.ts'), 'export const value = 2;');
  assert.notEqual(await inputDigest(root, ['shared/src']), before);
  await symlink(resolve(root, 'shared/src/index.ts'), resolve(root, 'shared/src/link.ts'));
  await assert.rejects(inputDigest(root, ['shared/src']), /symlink/);
});
