import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import { createServer } from "vite";
import sharp from "sharp";

let server, GET, articleGET, house, imageBytes;
const ORIGIN = "https://free2z.cash";
const previous = {
  PUBLIC_CANONICAL_BASE_URL: process.env.PUBLIC_CANONICAL_BASE_URL,
  OG_MAX_QUEUE: process.env.OG_MAX_QUEUE,
};
before(async () => {
  process.env.PUBLIC_CANONICAL_BASE_URL = ORIGIN;
  process.env.OG_MAX_QUEUE = "2";
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ GET } = await server.ssrLoadModule("/src/routes/og/image.png/+server.ts"));
  ({ GET: articleGET } = await server.ssrLoadModule(
    "/src/routes/og/zpage/[id].png/+server.ts",
  ));
  ({ DEFAULT_SOCIAL_IMAGE: house } =
    await server.ssrLoadModule("/src/lib/seo.ts"));
  imageBytes = await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: "#ff00aa" },
  })
    .webp()
    .toBuffer();
});
after(async () => {
  await server?.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function request(
  fetch,
  {
    source = "/uploadz/public/owner/cover.webp?v=one%2Btwo",
    origin = ORIGIN,
  } = {},
) {
  const url = new URL("/og/image.png", origin);
  url.searchParams.set("source", source);
  url.searchParams.set("renderer", "1");
  const headers = {};
  return {
    event: { url, fetch, setHeaders: (value) => Object.assign(headers, value) },
    headers,
  };
}
const imageResponse = (
  bytes = imageBytes,
  type = "image/webp",
  length = true,
) =>
  new Response(bytes, {
    headers: {
      "content-type": type,
      ...(length ? { "content-length": String(bytes.byteLength) } : {}),
    },
  });

test("canonical public source fetch omits credentials, refuses redirects, preserves revision and ignores Host", async () => {
  const source = "/uploadz/public/owner/cover.webp?generation=123&v=one%2Btwo";
  let calls = 0;
  const { event } = request(
    async (target, options) => {
      calls++;
      assert.equal(String(target), ORIGIN + source);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "manual");
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers, undefined);
      return imageResponse();
    },
    { source, origin: "https://attacker.example" },
  );
  const response = await GET(event);
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-free2z-og-outcome"), "ok");
  // Exact assertion protects the upload revocation boundary: neither a fresh
  // derivative TTL nor stale serving may bypass source auth after a takedown.
  assert.equal(response.headers.get("cache-control"), "no-store");
  const png = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 630);
  assert.ok(png.byteLength <= 550_000);
});

test("query-controlled private/off-origin/encoded traversal inputs never fetch", async () => {
  for (const source of [
    "https://free2z.cash/uploadz/public/a.png",
    "http://169.254.169.254/latest/meta-data",
    "//localhost/uploadz/public/a.png",
    "/api/private",
    "/uploadz/private/a.png",
    "/uploadz/public/../a.png",
    "/uploadz/public/%2e%2e/a.png",
    "/uploadz/public/%252e%252e%252fa.png",
    "/uploadz/public/a%2fb.png",
  ]) {
    let fetched = false;
    const { event, headers } = request(
      async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
      { source },
    );
    await assert.rejects(GET(event), (error) => error.status === 400);
    assert.equal(fetched, false);
    assert.equal(headers["cache-control"], "no-store");
  }
});

test("ambiguous query keys and renderer versions reject before fetching", async () => {
  for (const query of [
    "",
    "source=a&source=b&renderer=1",
    "source=%2Fuploadz%2Fpublic%2Fx.png&renderer=999",
    "source=%2Fuploadz%2Fpublic%2Fx.png&renderer=1&other=x",
  ]) {
    const { event, headers } = request(async () => {
      throw new Error("must not fetch");
    });
    event.url.search = query;
    await assert.rejects(GET(event), (error) => error.status === 400);
    assert.equal(headers["cache-control"], "no-store");
  }
});

test("redirects are not followed; missing/unsupported sources use only the relative house fallback", async () => {
  for (const make of [
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/" },
      }),
    () => new Response(null, { status: 404 }),
    () =>
      new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
  ]) {
    let calls = 0;
    const { event } = request(
      async () => {
        calls++;
        return make();
      },
      { origin: "https://stage.free2z.cash" },
    );
    const response = await GET(event);
    assert.equal(calls, 1);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), house);
    assert.ok(house.startsWith("/brand/"));
    assert.match(house, /[?&]v=/);
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=60, s-maxage=300",
    );
    assert.equal(response.headers.get("x-free2z-og-outcome"), "permanent");
  }
});

test("authentication, storage outages, incomplete transfer and decoder uncertainty are retryable, never house success", async () => {
  const png = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  for (const fetch of [
    async () => {
      throw new Error("network timeout");
    },
    async () => new Response(null, { status: 403 }),
    async () => new Response(null, { status: 503 }),
    async () =>
      imageResponse(png.subarray(0, png.length - 12), "image/png", false),
    async () => imageResponse(png.subarray(0, 12), "image/png", false),
    async () =>
      new Response(new Uint8Array(4), {
        headers: { "content-type": "image/png", "content-length": "100" },
      }),
    async () => {
      const corrupt = Buffer.from(png);
      const dataStart = corrupt.indexOf(Buffer.from("IDAT")) + 4;
      assert.ok(dataStart > 4);
      corrupt[dataStart + 3] ^= 0xff;
      return imageResponse(corrupt, "image/png");
    },
  ]) {
    const { event, headers } = request(fetch);
    await assert.rejects(GET(event), (error) => error.status === 503);
    assert.equal(headers["cache-control"], "no-store");
  }
});

test("byte, pixel and edge limits reject before normalized-image work", async () => {
  for (const [width, height] of [
    [2049, 2048],
    [4097, 100],
  ]) {
    const png = await sharp({
      create: { width, height, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    assert.equal(
      (await GET(request(async () => imageResponse(png, "image/png")).event))
        .status,
      302,
    );
  }
  let cancelled = false;
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-type": "image/png",
      "content-length": String(8 * 1024 * 1024 + 1),
    }),
    body: {
      async cancel() {
        cancelled = true;
      },
      getReader() {
        throw new Error("oversize body must not be read");
      },
    },
  };
  assert.equal((await GET(request(async () => response).event)).status, 302);
  assert.equal(cancelled, true);
});

test("noisy square and landscape uploads stay within the PNG byte budget", async () => {
  // The square is the exact input-pixel ceiling; the landscape nearly fills
  // the output canvas and exercises the encoder's smaller palette fallback.
  for (const [width, height] of [
    [2048, 2048],
    [2816, 1489],
  ]) {
    const bytes = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    assert.ok(bytes.length < 8 * 1024 * 1024);
    const response = await GET(
      request(async () => imageResponse(bytes, "image/jpeg")).event,
    );
    assert.equal(response.status, 200);
    const output = Buffer.from(await response.arrayBuffer());
    assert.ok(output.length <= 550_000);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 1200);
    assert.equal(metadata.height, 630);
  }
});

test("article and public-image handlers share slots before article CPU cooldown refusal", async () => {
  const cover = await sharp(imageBytes).resize(800).webp().toBuffer();
  let releaseFetch, bothStarted;
  const held = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const started = new Promise((resolve) => {
    bothStarted = resolve;
  });
  let active = 0,
    peak = 0,
    count = 0;
  const fetch = async (target) => {
    if (String(target).includes("/api/"))
      return Response.json({
        free2zaddr: "article",
        title: "Shared gate",
        creator: { username: "free2z" },
        featured_image: { url: "/uploadz/public/cover.webp" },
      });
    active++;
    count++;
    peak = Math.max(peak, active);
    if (count === 2) bothStarted();
    await held;
    active--;
    return imageResponse(cover);
  };
  const article = () =>
    articleGET({
      params: { id: "article" },
      url: new URL("/og/zpage/article.png", ORIGIN),
      fetch,
      setHeaders() {},
    });
  const first = GET(request(fetch).event);
  const second = article();
  await started;
  const third = GET(request(fetch).event);
  const fourth = article();
  await new Promise((resolve) => setImmediate(resolve));
  try {
    const { event, headers } = request(fetch);
    await assert.rejects(GET(event), (error) => error.status === 503);
    assert.equal(headers["cache-control"], "no-store");
    assert.equal(count, 2);
  } finally {
    releaseFetch();
  }
  const results = await Promise.all([first, second, third, fourth]);
  // Public-image requests share the memory semaphore but not the article-only
  // measured-CPU budget. The last queued article may be retryably refused
  // after the first article render's cooldown, before reading its cover;
  // whether the measured cooldown has elapsed depends on concurrent SSR CPU.
  // In either case it must respect the independent article admission bound.
  assert.deepEqual(
    results.slice(0, 3).map((result) => result.status),
    [200, 200, 200],
  );
  if (results[3].status === 503) {
    assert.equal(results[3].headers.get("cache-control"), "no-store");
    assert.equal(results[3].headers.get("x-f2z-og-admission-limited"), "1");
    assert.ok(Number(results[3].headers.get("retry-after")) > 0);
    assert.equal(count, 3); // refused before the last cover-byte fetch
  } else {
    assert.equal(results[3].status, 200);
    assert.equal(count, 4);
  }
  assert.equal(peak, 2);
});
