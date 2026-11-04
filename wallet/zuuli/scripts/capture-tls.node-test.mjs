import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { captureTlsDockerArguments } from './capture-tls.mjs';

test('tampered trust data fails before a Docker command can be constructed', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'capture-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'scripts/tls'), { recursive: true });
  await writeFile(resolve(root, 'scripts/tls/ca-certificates.pem'), 'untrusted data');
  await assert.rejects(captureTlsDockerArguments(root), /CA bundle checksum mismatch/);
});
