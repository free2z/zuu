import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  inspectSocialHead,
  inspectSocialImage,
  checkSocialPreview,
} from "../scripts/social-preview.mjs";

const tags = {
  "og:title": "A & B",
  "og:description": "A story",
  "og:type": "article",
  "og:url": "https://free2z.cash/a/story",
  "og:image": "https://free2z.cash/og/story.png?v=1&renderer=3",
  "og:image:alt": "Artwork",
  "twitter:card": "summary_large_image",
  "twitter:title": "A & B",
  "twitter:description": "A story",
  "twitter:image": "https://free2z.cash/og/story.png?v=1&renderer=3",
  "twitter:image:alt": "Artwork",
};
const meta = (key, value) =>
  `<meta content='${value.replaceAll("&", "&amp;")}' ${key.startsWith("og:") ? "property" : "name"}='${key}'>`;
const html = () =>
  `<html><head><link rel="canonical" href="https://free2z.cash/a/story">${Object.entries(
    tags,
  )
    .map(([key, value]) => meta(key, value))
    .join("")}</head><body></body></html>`;
const image = () =>
  sharp({
    create: { width: 1200, height: 630, channels: 3, background: "#ff00aa" },
  })
    .png()
    .toBuffer();

test("head parser handles reordered attributes, quote styles and entities", () => {
  const result = inspectSocialHead(html());
  assert.deepEqual(result.errors, []);
  assert.equal(result.tags["twitter:image"], tags["og:image"]);
  assert.equal(result.tags["og:title"], "A & B");
});

test("missing, duplicate and body-only Twitter tags are rejected", () => {
  const missing = html().replace(
    meta("twitter:image", tags["twitter:image"]),
    "",
  );
  assert.ok(
    inspectSocialHead(missing).errors.includes("missing twitter:image"),
  );
  const bodyOnly = missing.replace(
    "<body>",
    `<body>${meta("twitter:image", tags["twitter:image"])}`,
  );
  assert.ok(
    inspectSocialHead(bodyOnly).errors.includes("missing twitter:image"),
  );
  const duplicate = html().replace(
    "</head>",
    `${meta("twitter:image", tags["twitter:image"])}</head>`,
  );
  assert.ok(
    inspectSocialHead(duplicate).errors.includes("duplicate twitter:image"),
  );
});

test("late tags and disagreeing image URLs are rejected", () => {
  assert.ok(
    inspectSocialHead(
      html().replace("<head>", `<head><!--${"a".repeat(300_000)}-->`),
    ).errors.some((error) => error.includes("300KB")),
  );
  assert.ok(
    inspectSocialHead(
      html().replace(
        meta("twitter:image", tags["twitter:image"]),
        meta("twitter:image", "https://free2z.cash/wrong.png"),
      ),
    ).errors.includes("OG and Twitter image URLs differ"),
  );
});

test("image validation checks actual MIME, dimensions and decoded pixels", async () => {
  const bytes = await image();
  assert.deepEqual(
    (
      await inspectSocialImage(bytes, "image/png", {
        "og:image:width": "1200",
        "og:image:height": "630",
      })
    ).errors,
    [],
  );
  const wrong = await inspectSocialImage(bytes, "application/octet-stream", {
    "og:image:type": "image/jpeg",
    "og:image:width": "400",
  });
  assert.equal(wrong.errors.length, 3);
  assert.ok(
    (
      await inspectSocialImage(bytes.subarray(0, 100), "image/png")
    ).errors.includes("image pixels cannot be decoded"),
  );
  assert.ok(
    (
      await inspectSocialImage(
        Buffer.concat([bytes, Buffer.alloc(600_000)]),
        "image/png",
      )
    ).errors.some((error) => error.includes("600KB")),
  );
});

test("network probe checks stage's actual image without changing public metadata", async () => {
  const calls = [];
  const bytes = await image();
  const result = await checkSocialPreview("https://stage.free2z.cash/a/story", {
    assetOrigin: "https://stage.free2z.cash",
    userAgent: "FixtureBot",
    fetchImpl: async (url, options) => {
      calls.push([url, options.headers["user-agent"]]);
      return new Response(calls.length === 1 ? html() : bytes, {
        headers: {
          "content-type": calls.length === 1 ? "text/html" : "image/png",
        },
      });
    },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(
    calls[1][0],
    "https://stage.free2z.cash/og/story.png?v=1&renderer=3",
  );
  assert.equal(calls[1][1], "FixtureBot");
  assert.equal(result.tags["twitter:image"], tags["twitter:image"]);
});

test("network failures and oversized responses cannot produce a pass", async () => {
  await assert.rejects(
    checkSocialPreview("https://free2z.cash/", {
      fetchImpl: async () => new Response("busy", { status: 503 }),
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    checkSocialPreview("https://free2z.cash/", {
      fetchImpl: async () =>
        new Response("x".repeat(2_000_001), {
          headers: { "content-type": "text/html" },
        }),
    }),
    /exceeds/,
  );
});

test("small custom images expose platform-specific limits", async () => {
  const bytes = await sharp({
    create: { width: 400, height: 400, channels: 3, background: "#ff00aa" },
  })
    .png()
    .toBuffer();
  const result = await inspectSocialImage(bytes, "image/png");
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((warning) => warning.includes("LinkedIn")));
  assert.ok(result.warnings.some((warning) => warning.includes("Apple")));
});

test("network probe bounds redirects and rejects unapproved image origins", async () => {
  let calls = 0;
  await assert.rejects(
    checkSocialPreview("https://free2z.cash/", {
      fetchImpl: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "/again" },
        });
      },
    }),
    /too many redirects/,
  );
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(
    checkSocialPreview("https://free2z.cash/", {
      fetchImpl: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example/private" },
        });
      },
    }),
    /origin is not allowed/,
  );
  assert.equal(calls, 1);
  const remoteHead = html().replaceAll(
    "https://free2z.cash/og/",
    "https://images.example/og/",
  );
  await assert.rejects(
    checkSocialPreview("https://free2z.cash/", {
      fetchImpl: async () =>
        new Response(remoteHead, { headers: { "content-type": "text/html" } }),
    }),
    /origin is not allowed/,
  );
  const bytes = await image();
  const allowed = await checkSocialPreview("https://free2z.cash/", {
    allowedImageOrigins: ["https://images.example"],
    fetchImpl: async (url) =>
      new Response(
        String(url).startsWith("https://images.example") ? bytes : remoteHead,
        {
          headers: {
            "content-type": String(url).startsWith("https://images.example")
              ? "image/png"
              : "text/html",
          },
        },
      ),
  });
  assert.deepEqual(allowed.errors, []);
});

test("stage probes identify first-party assets independently of external canonicals", async () => {
  const bytes = await image();
  const externalCanonical = html().replaceAll(
    "https://free2z.cash/a/story",
    "https://publisher.example/original",
  );
  const calls = [];
  const result = await checkSocialPreview("https://stage.free2z.cash/a/story", {
    assetOrigin: "https://stage.free2z.cash",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(calls.length === 1 ? externalCanonical : bytes, {
        headers: {
          "content-type": calls.length === 1 ? "text/html" : "image/png",
        },
      });
    },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.canonical, "https://publisher.example/original");
  assert.equal(
    calls[1],
    "https://stage.free2z.cash/og/story.png?v=1&renderer=3",
  );
  await assert.rejects(
    checkSocialPreview("https://stage.free2z.cash/a/story", {
      assetOrigin: "https://stage.free2z.cash",
      fetchImpl: async () =>
        new Response(
          externalCanonical.replaceAll(
            "https://free2z.cash/og/",
            "https://publisher.example/og/",
          ),
          { headers: { "content-type": "text/html" } },
        ),
    }),
    /origin is not allowed/,
    "an external canonical must not authorize its image origin",
  );
});

test("a cold image inside the origin render deadline is accepted", async (t) => {
  const bytes = await image();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("deadline")), milliseconds);
    return controller.signal;
  });
  let calls = 0;
  const pending = checkSocialPreview("https://free2z.cash/a/story", {
    fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1)
        return new Response(html(), {
          headers: { "content-type": "text/html" },
        });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("image deadline exceeded")),
          { once: true },
        );
        setTimeout(
          () =>
            resolve(
              new Response(bytes, { headers: { "content-type": "image/png" } }),
            ),
          25_000,
        );
      });
    },
  });
  // Let the immediate HTML read settle and schedule the simulated cold image.
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  t.mock.timers.tick(25_000);
  const result = await pending;
  assert.deepEqual(result.errors, []);
});
