import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "vite";
import sharp from "sharp";

let server,
  publicUploadUrl,
  isSupportedPublicImageVersion,
  publicImageSource,
  normalizedPublicImageUrl,
  normalizePublicImage;
before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({
    publicUploadUrl,
    publicImageSource,
    normalizedPublicImageUrl,
    isSupportedPublicImageVersion,
  } = await server.ssrLoadModule("/src/lib/public-social-image.ts"));
  ({ normalizePublicImage } = await server.ssrLoadModule(
    "/src/lib/server/og-public-image.ts",
  ));
});
after(async () => {
  await server?.close();
});
const ORIGIN = "https://free2z.cash";

test("renderer upgrades retain cached older positive version URLs", () => {
  assert.equal(isSupportedPublicImageVersion("1"), true);
  assert.equal(isSupportedPublicImageVersion("1", "2"), true);
  assert.equal(isSupportedPublicImageVersion("2", "2"), true);
  assert.equal(isSupportedPublicImageVersion("3", "2"), false);
  for (const version of [
    "",
    "0",
    "-1",
    "+1",
    "01",
    "1.0",
    "1e0",
    "1 ",
    "9999999",
  ]) {
    assert.equal(isSupportedPublicImageVersion(version, "2"), false, version);
  }
});

test("projection preserves source revision and uses the selected asset origin", () => {
  const source =
    "/uploadz/public/owner/cover.webp?generation=123&v=a%2Bb&v=two";
  const result = new URL(
    normalizedPublicImageUrl(
      ORIGIN + source,
      ORIGIN,
      "https://stage.free2z.cash",
    ),
  );
  assert.equal(result.origin, "https://stage.free2z.cash");
  assert.equal(result.pathname, "/og/image.png");
  assert.equal(result.searchParams.get("source"), source);
  assert.equal(result.searchParams.get("renderer"), "1");
  assert.equal(
    publicImageSource(result.searchParams.get("source"), ORIGIN).href,
    ORIGIN + source,
  );
  assert.equal(
    normalizedPublicImageUrl("/brand/free2z-og.png?v=2", ORIGIN),
    null,
  );
  assert.equal(
    normalizedPublicImageUrl("/og/zpage/story.png?v=1", ORIGIN),
    null,
  );
  assert.equal(
    normalizedPublicImageUrl("https://other.test/uploadz/public/x.png", ORIGIN),
    null,
  );
});

for (const source of [
  "//127.0.0.1/uploadz/public/x.png",
  "/uploadz/private/x.png",
  "/uploadz/public/../secret.png",
  "/uploadz/public/%2e%2e/secret.png",
  "/uploadz/public/%252e%252e%252fsecret.png",
  "/uploadz/public/a%2fb.png",
  "/uploadz/public/a%5cb.png",
  "/uploadz/public/a\\b.png",
  "/uploadz/public/a//b.png",
  "/uploadz/public/a.png#fragment",
  "/uploadz/public/a%00.png",
  "/uploadz/public/%zz.png",
  "https://user:password@free2z.cash/uploadz/public/a.png",
  "https://free2z.cash.evil.test/uploadz/public/a.png",
  "/uploadz/public/" + "a".repeat(2048),
  "/uploadz/public/" + "界".repeat(240),
]) {
  test(`reject untrusted or ambiguously decoded source: ${source.slice(0, 70)}`, () => {
    assert.equal(publicUploadUrl(source, ORIGIN), null);
    assert.equal(publicImageSource(source, ORIGIN), null);
  });
}

test("the endpoint requires a relative public path and a configured plain origin", () => {
  assert.equal(
    publicImageSource(ORIGIN + "/uploadz/public/x.png", ORIGIN),
    null,
  );
  assert.equal(
    publicImageSource("/uploadz/public/x.png", ORIGIN + "/api"),
    null,
  );
  assert.equal(
    publicImageSource("/uploadz/public/x.png", "https://user@free2z.cash"),
    null,
  );
  assert.ok(
    publicImageSource("/uploadz/public/owner/caf%C3%A9%20image.png", ORIGIN),
  );
});

async function quadrants(width, height) {
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  const bytes = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      bytes.set(
        colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)],
        (y * width + x) * 3,
      );
    }
  return sharp(bytes, { raw: { width, height, channels: 3 } });
}
async function pixels(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1200);
  assert.equal(info.height, 630);
  return (x, y) => [
    ...data.subarray((y * 1200 + x) * 3, (y * 1200 + x) * 3 + 3),
  ];
}
function close(actual, expected) {
  assert.ok(
    actual.every((c, i) => Math.abs(c - expected[i]) < 10),
    `${actual} != ${expected}`,
  );
}
test("portrait normalization retains all four corners with an opaque mat", async () => {
  const input = await (await quadrants(200, 400)).png().toBuffer();
  const pixel = await pixels(await normalizePublicImage(input));
  close(pixel(460, 20), [255, 0, 0]);
  close(pixel(740, 20), [0, 255, 0]);
  close(pixel(460, 610), [0, 0, 255]);
  close(pixel(740, 610), [255, 255, 0]);
  close(pixel(0, 0), [9, 9, 11]);
});
test("EXIF rotation is applied before containment", async () => {
  const input = await (
    await quadrants(400, 200)
  )
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 95 })
    .toBuffer();
  const output = await normalizePublicImage(input);
  const pixel = await pixels(output);
  close(pixel(460, 20), [0, 0, 255]);
  close(pixel(740, 20), [255, 0, 0]);
  close(pixel(460, 610), [255, 255, 0]);
  close(pixel(740, 610), [0, 255, 0]);
  assert.equal((await sharp(output).metadata()).orientation, undefined);
});
test("transparent pixels are flattened onto the same mat", async () => {
  const input = await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const pixel = await pixels(await normalizePublicImage(input));
  assert.deepEqual(pixel(600, 315), [9, 9, 11]);
  assert.equal(sharp.cache().memory.max, 0);
  assert.equal(sharp.concurrency(), 1);
});
