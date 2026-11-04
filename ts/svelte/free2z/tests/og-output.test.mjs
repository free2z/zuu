import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import sharp from "sharp";

let server, encodeSocialPng;
before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ encodeSocialPng } = await server.ssrLoadModule(
    "/src/lib/server/og-output.ts",
  ));
});
after(async () => {
  await server?.close();
});

test("the static house card is a decodable1200×630 PNG under550KB", async () => {
  const bytes = readFileSync(
    new URL("../static/brand/free2z-og.png", import.meta.url),
  );
  assert.ok(bytes.length <= 550_000);
  const decoded = await sharp(bytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 1200);
  assert.equal(decoded.info.height, 630);
  assert.ok(
    (await sharp(bytes).stats()).entropy > 1,
    "house card must contain visible artwork",
  );
  assert.equal(
    await encodeSocialPng(bytes),
    bytes,
    "already-small output must avoid re-encoding",
  );
});

test("even a full-frame noise raster has a bounded PNG output", async () => {
  const raw = Buffer.alloc(1200 * 630 * 3);
  let state = 77123;
  for (let i = 0; i < raw.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    raw[i] = state & 255;
  }
  const source = await sharp(raw, {
    raw: { width: 1200, height: 630, channels: 3 },
  })
    .png()
    .toBuffer();
  assert.ok(source.length > 600_000, "fixture must require compression");
  const output = await encodeSocialPng(source);
  assert.ok(output.byteLength <= 550_000);
  const stats = await sharp(output).stats();
  assert.ok(stats.entropy > 2, "budget fallback must preserve image detail");
});
