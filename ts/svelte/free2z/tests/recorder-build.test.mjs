import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  gzipSync,
  brotliCompressSync,
  gunzipSync,
  brotliDecompressSync,
} from "node:zlib";

test("build replaces stale compressed dev HTML along with the final recorder page", async () => {
  const output = await mkdtemp(join(tmpdir(), "recorder-build-"));
  try {
    const page = join(output, "tools/recording/index.html");
    await mkdir(join(output, "tools/recording"), { recursive: true });
    await writeFile(page, "stale dev HTML");
    await writeFile(`${page}.gz`, gzipSync("stale dev HTML"));
    await writeFile(`${page}.br`, brotliCompressSync("stale dev HTML"));
    execFileSync(process.execPath, ["scripts/build-recorder.mjs", output]);
    const html = await readFile(page);
    assert.match(
      html.toString(),
      /\/_app\/immutable\/recorder\/[a-f0-9]{24}\/app.js/,
    );
    assert.deepEqual(gunzipSync(await readFile(`${page}.gz`)), html);
    assert.deepEqual(brotliDecompressSync(await readFile(`${page}.br`)), html);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
