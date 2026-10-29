import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { recorderBuildProcesses } from "./helpers/recorder-build-processes.mjs";

const script = fileURLToPath(
  new URL("../scripts/build-recorder.mjs", import.meta.url),
);
test(
  "parallel recorder builds publish complete identical immutable assets",
  { timeout: 60_000 },
  async (t) => {
    const processes = recorderBuildProcesses(t.signal);
    const build = (output) => processes.run([script, output]);
    const output = await mkdtemp(
      join(tmpdir(), "free2z-recorder-concurrency-"),
    );
    let scanning = true;
    let scanFailure = null;
    let scans = 0;
    async function inventory(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        t.signal.throwIfAborted();
        assert.doesNotMatch(entry.name, /^\.recorder-/);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await inventory(path);
        else await readFile(path, { signal: t.signal });
      }
    }
    const scanner = (async () => {
      while (scanning && !t.signal.aborted) {
        await inventory(output);
        scans++;
        await setImmediate();
      }
    })().catch((error) => {
      if (!t.signal.aborted) scanFailure = error;
    });
    try {
      await Promise.all(Array.from({ length: 4 }, () => build(output)));
      // Reusing an existing immutable generation exercises the collision path.
      await Promise.all([build(output), build(output)]);
      scanning = false;
      await scanner;
      assert.ifError(scanFailure);
      assert.ok(scans > 0, "the public inventory ran concurrently with builds");
      const htmlPath = join(output, "tools/recording/index.html");
      const html = await readFile(htmlPath);
      assert.deepEqual(gunzipSync(await readFile(`${htmlPath}.gz`)), html);
      assert.deepEqual(
        brotliDecompressSync(await readFile(`${htmlPath}.br`)),
        html,
      );
      const prefix = html
        .toString()
        .match(/src="(\/_app\/immutable\/recorder\/[a-f0-9]+\/)app\.js"/)?.[1];
      assert.ok(prefix);
      const assets = join(output, prefix.slice(1));
      assert.equal((await stat(assets)).mode & 0o777, 0o755);
      assert.ok((await readFile(join(assets, "app.js"))).length > 0);
      assert.ok((await readFile(join(assets, "style.css"))).length > 0);
      const ui = await readdir(join(assets, "ui"));
      assert.ok(ui.length > 0);
      assert.deepEqual(await readdir(dirname(assets)), [basename(assets)]);
      assert.deepEqual((await readdir(dirname(htmlPath))).sort(), [
        "index.html",
        "index.html.br",
        "index.html.gz",
      ]);
      await unlink(join(assets, "ui", ui[0]));
      await assert.rejects(
        build(output),
        /Existing recorder generation is incomplete/,
      );
    } finally {
      scanning = false;
      await processes.close();
      await scanner;
      await rm(output, { recursive: true, force: true });
    }
  },
);
