import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
let server, download;
before(async () => {
  server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  ({ accountDataExportDownload: download } = await server.ssrLoadModule(
    "/src/lib/api/exports/exports.ts",
  ));
});
after(async () => {
  await server.close();
});
test("generated download parses ZIP bytes and preserves errors and content-type checks", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal("responseType" in init, false);
      return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), {
        headers: { "content-type": "application/zip" },
      });
    };
    const blob = await download("test");
    assert.ok(blob instanceof Blob);
    assert.deepEqual(
      [...new Uint8Array(await blob.arrayBuffer())],
      [0x50, 0x4b, 3, 4],
    );
    globalThis.fetch = async () =>
      Response.json({ detail: "expired" }, { status: 410 });
    await assert.rejects(
      download("test"),
      (error) => error.status === 410 && error.message === "expired",
    );
    globalThis.fetch = async () =>
      new Response("<html/>", { headers: { "content-type": "text/html" } });
    await assert.rejects(
      download("test"),
      (error) =>
        error.status === 200 && /Unexpected content type/.test(error.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});
