import { expect, test, type APIResponse } from "@playwright/test";
import {
  inspectSocialHead,
  inspectSocialImage,
} from "../../scripts/social-preview.mjs";

// A prior shard test can consume the local renderer's admission budget.
// Honor only its explicit backpressure, with at most three bounded waits.
async function admittedImage<T extends Pick<APIResponse, "status" | "headers">>(
  get: () => Promise<T>,
  wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  let response = await get();
  let waited = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const headers = response.headers();
    const retry = headers["retry-after"];
    if (
      response.status() !== 503 ||
      headers["x-f2z-og-admission-limited"] !== "1" ||
      !/^\d+$/.test(retry ?? "")
    )
      break;
    const delay = Number(retry) * 1_000;
    if (delay <= 0 || waited + delay > 10_000) break;
    await wait(delay);
    waited += delay;
    response = await get();
  }
  return response;
}

// Real routing + SSR bytes; no hydration, browser DOM repair, or live network.
const routes = [
  "/",
  "/trending",
  "/creators",
  "/search?q=zcash",
  "/tag/ssr-tag-fixture",
  "/livefixture",
  "/ssr-body-user/ssr-body-fixture",
  "/article/ssr-body-fixture",
  "/converse",
  "/converse/converse-titled-fixture",
  "/livefixture/broadcast",
  "/live/livefixture",
  "/paidstreamfixture/ppv",
  "/paidstreamfixture/subscribers-only",
  "/checkout/social-card-fixture",
];
for (const path of routes) {
  test(`public share card is complete in raw SSR: ${path}`, async ({
    request,
    baseURL,
  }) => {
    test.slow();
    const response = await request.get(path, {
      headers: { "user-agent": "Twitterbot/1.0" },
    });
    expect(response.status()).toBe(200);
    const contract = inspectSocialHead(await response.text());
    expect(contract.errors).toEqual([]);
    // House and generated cards are real assets provided by this app. Remote
    // creator assets are separately covered by the opt-in network validator.
    const image = new URL(contract.imageUrl!);
    if (
      image.pathname.startsWith("/brand/") ||
      image.pathname.startsWith("/og/")
    ) {
      const pixels = await admittedImage(() =>
        request.get(new URL(image.pathname + image.search, baseURL).href),
      );
      expect(pixels.status()).toBe(200);
      const result = await inspectSocialImage(
        await pixels.body(),
        pixels.headers()["content-type"],
        contract.tags,
      );
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });
}

test("public upload metadata shares one normalized PNG across OG, Twitter and JSON-LD", async ({
  request,
}) => {
  const response = await request.get("/social-image-public");
  expect(response.status()).toBe(200);
  const html = await response.text();
  const contract = inspectSocialHead(html);
  expect(contract.errors).toEqual([]);
  const image = new URL(contract.imageUrl!);
  expect(image.origin).toBe("https://free2z.cash");
  expect(image.pathname).toBe("/og/image.png");
  expect(image.searchParams.get("source")).toBe(
    "/uploadz/public/fixture/cover.webp?generation=123&v=one%2Btwo",
  );
  expect(image.searchParams.get("renderer")).toBe("1");
  expect(contract.tags["og:image:type"]).toBe("image/png");
  expect(contract.tags["og:image:width"]).toBe("1200");
  expect(contract.tags["og:image:height"]).toBe("630");
  expect(contract.tags["twitter:image"]).toBe(image.href);
  const graph = JSON.parse(
    html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1],
  )["@graph"];
  const page = graph.find((item: any) => item.primaryImageOfPage);
  expect(page.primaryImageOfPage.url).toBe(image.href);
  expect(page.primaryImageOfPage.width).toBe(1200);
  expect(page.primaryImageOfPage.height).toBe(630);
});

for (const extension of ["webp", "jpg", "unknown"]) {
  test(`custom ${extension} image does not invent MIME or dimensions`, async ({
    request,
  }) => {
    const response = await request.get(`/social-image-${extension}`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    const contract = inspectSocialHead(html);
    expect(contract.errors).toEqual([]);
    expect(contract.tags["og:image:type"]).toBe(
      extension === "webp"
        ? "image/webp"
        : extension === "jpg"
          ? "image/jpeg"
          : undefined,
    );
    expect(contract.tags["og:image:width"]).toBeUndefined();
    expect(contract.tags["og:image:height"]).toBeUndefined();
    const jsonLd = html.match(
      /<script type="application\/ld\+json">(.*?)<\/script>/s,
    )![1];
    const graph = JSON.parse(jsonLd)["@graph"];
    const page = graph.find((item: any) => item.primaryImageOfPage);
    expect(page.primaryImageOfPage.width).toBeUndefined();
    expect(page.primaryImageOfPage.height).toBeUndefined();
  });
}

test("malformed custom image falls back without breaking SSR", async ({
  request,
}) => {
  const response = await request.get("/social-image-malformed");
  expect(response.status()).toBe(200);
  const contract = inspectSocialHead(await response.text());
  expect(contract.errors).toEqual([]);
  expect(contract.imageUrl).toBe("https://free2z.cash/brand/free2z-og.png?v=2");
  expect(contract.tags["og:image:type"]).toBe("image/png");
  expect(contract.tags["og:image:width"]).toBe("1200");
});

test("image admission retry honors only marked bounded backpressure", async () => {
  const response = (status: number, headers: Record<string, string> = {}) => ({
    status: () => status,
    headers: () => headers,
  });
  const waits: number[] = [];
  let calls = 0;
  const admitted = await admittedImage(
    async () =>
      ++calls === 1
        ? response(503, {
            "x-f2z-og-admission-limited": "1",
            "retry-after": "1",
          })
        : response(200),
    async (ms) => {
      waits.push(ms);
    },
  );
  expect(admitted.status()).toBe(200);
  expect(calls).toBe(2);
  expect(waits).toEqual([1_000]);
  for (const headers of [
    { "retry-after": "1" },
    { "x-f2z-og-admission-limited": "1", "retry-after": "99" },
    { "x-f2z-og-admission-limited": "1", "retry-after": "invalid" },
  ] as Record<string, string>[]) {
    calls = 0;
    const refused = await admittedImage(
      async () => {
        calls += 1;
        return response(503, headers);
      },
      async () => {
        throw new Error("must not wait");
      },
    );
    expect(refused.status()).toBe(503);
    expect(calls).toBe(1);
  }
  calls = 0;
  waits.length = 0;
  const exhausted = await admittedImage(
    async () => {
      calls += 1;
      return response(503, {
        "x-f2z-og-admission-limited": "1",
        "retry-after": "1",
      });
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  expect(exhausted.status()).toBe(503);
  expect(calls).toBe(4);
  expect(waits).toEqual([1_000, 1_000, 1_000]);
});
