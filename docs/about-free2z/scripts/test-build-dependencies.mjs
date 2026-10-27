import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);

test('Docusaurus worker protocol is supported by its patched Tinypool', async () => {
  const core = createRequire(require.resolve('@docusaurus/core/package.json'));
  const { default: Tinypool } = await import(pathToFileURL(core.resolve('tinypool')).href);
  const directory = await mkdtemp(join(tmpdir(), 'free2z-docs-worker-'));
  let pool;
  try {
    const filename = join(directory, 'worker.cjs');
    await writeFile(filename, `module.exports.default = (task) => ({
      task,
      workerId: process.__tinypool_state__.workerId,
      params: require('node:worker_threads').workerData[1].params,
    });`);
    pool = new Tinypool({
      filename,
      minThreads: 1,
      maxThreads: 1,
      concurrentTasksPerWorker: 1,
      runtime: 'worker_threads',
      isolateWorkers: false,
      workerData: { params: { site: 'synthetic-docs' } },
    });
    const result = await pool.run({ pathnames: ['/'] });
    assert.ok(result.workerId);
    assert.deepEqual(result.task, { pathnames: ['/'] });
    assert.deepEqual(result.params, { site: 'synthetic-docs' });
  } finally {
    await pool?.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const parent of ['copy-webpack-plugin', 'css-minimizer-webpack-plugin']) {
  test(`${parent} can require its patched serializer without changing serialized values`, () => {
    const parentRequire = createRequire(require.resolve(parent));
    const serialize = parentRequire('serialize-javascript');
    const value = { text: '</script><script>synthetic</script>', pattern: /free2z/i };
    const encoded = serialize(value);
    assert.doesNotMatch(encoded, /<\/script/i);
    const restored = runInNewContext(`(${encoded})`);
    assert.equal(restored.text, value.text);
    assert.equal(restored.pattern.source, value.pattern.source);
    assert.equal(restored.pattern.flags, value.pattern.flags);
  });
}

test('SockJS can use the patched UUID CommonJS v4 API', () => {
  const sockjs = createRequire(require.resolve('sockjs'));
  const uuid = sockjs('uuid');
  const id = uuid.v4();
  assert.equal(uuid.validate(id), true);
  assert.equal(uuid.version(id), 4);
});
