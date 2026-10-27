import { expect, test } from "@playwright/test";
import { browserMockApiOrigin } from "./ports";

//  changed `customInstance`, which sits on the path of every API call in
// the app. These tests cover both halves of its blast radius end to end:
//
//   - SSR: the session cookie reaches the upstream API (the actual bug), and
//     an anonymous visitor still produces an anonymous upstream call.
//   - Browser: writes still carry a CSRF token, caller request options reach
//     fetch, and a descriptor-supplied body is not swallowed.
//
// The client is imported straight out of the Vite dev module graph, so this
// exercises the code the app ships rather than a re-implementation.

type Seen = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

async function captureApiRequests(page: import("@playwright/test").Page) {
  const seen: Seen[] = [];

  // Predicate, not a glob: `**/api/**` would also swallow the dev server's
  // own `/src/lib/api/...` module requests.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      seen.push({
        url: request.url(),
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postData(),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, count: 0, results: [] }),
      });
    },
  );

  return seen;
}

const MOCK_API_ORIGIN = browserMockApiOrigin();

test("SSR forwards the session cookie to the API (#726)", async ({
  page,
  context,
  request,
}) => {
  // The bug this PR fixes was invisible from the rendered page: SSR succeeded,
  // it just went out anonymous. Assert on what the upstream actually received.
  await request.delete(`${MOCK_API_ORIGIN}/__requests`);
  await context.addCookies([
    {
      name: "sessionid",
      value: "SSRCOOKIETEST",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);

  await page.goto("/");

  const upstream: { path: string; cookie: string | null }[] = await (
    await request.get(`${MOCK_API_ORIGIN}/__requests`)
  ).json();

  expect(upstream.length).toBeGreaterThan(0);
  const withSession = upstream.filter((r) =>
    r.cookie?.includes("sessionid=SSRCOOKIETEST"),
  );
  // Every homepage call except the deliberately-public feed queries (which use
  // createPublicApiOptions so client pagination stays on one dataset) must
  // carry the session.
  expect(withSession.length).toBeGreaterThan(0);
  expect(withSession.some((r) => r.path.startsWith("/api/creator/"))).toBe(
    true,
  );
});

test("SSR stays anonymous when the visitor has no session", async ({
  page,
  request,
}) => {
  await request.delete(`${MOCK_API_ORIGIN}/__requests`);

  await page.goto("/trending");

  const upstream: { path: string; cookie: string | null }[] = await (
    await request.get(`${MOCK_API_ORIGIN}/__requests`)
  ).json();

  expect(upstream.length).toBeGreaterThan(0);
  expect(upstream.every((r) => !r.cookie?.includes("sessionid="))).toBe(true);
});

test("a generated write sends its JSON payload and a CSRF token", async ({
  page,
}) => {
  await page.goto("/");
  const seen = await captureApiRequests(page);

  const result = await page.evaluate(async () => {
    // Indirect so TypeScript treats this as a runtime path (the module is
    // served by the Vite dev server, not resolvable from tsconfig).
    const path = "/src/lib/api/zpage/zpage.ts";
    const mod: any = await import(/* @vite-ignore */ path);
    return mod.zpageCreate({ title: "browser write", content: "hi" });
  });

  expect(result).toEqual({ ok: true, count: 0, results: [] });

  const writes = seen.filter((r) => r.method === "POST");
  expect(writes).toHaveLength(1);

  // Before  orval's `data` was never mapped onto `body`, so this posted
  // an empty request.
  expect(JSON.parse(writes[0].body ?? "null")).toEqual({
    title: "browser write",
    content: "hi",
  });
  expect(writes[0].headers["content-type"]).toBe("application/json");
  // Django rejects the write without this; it must survive the header merge.
  expect(writes[0].headers["x-csrftoken"]).toMatch(/^[A-Za-z0-9]{32}$/);
});

test("caller request options reach fetch on the client too", async ({
  page,
}) => {
  await page.goto("/");
  const seen = await captureApiRequests(page);

  await page.evaluate(async () => {
    // Indirect so TypeScript treats this as a runtime path (the module is
    // served by the Vite dev server, not resolvable from tsconfig).
    const path = "/src/lib/api/zpage/zpage.ts";
    const mod: any = await import(/* @vite-ignore */ path);
    return mod.zpageList({ page: 1 }, { headers: { "X-Caller": "kept" } });
  });

  const reads = seen.filter((r) => r.method === "GET");
  expect(reads).toHaveLength(1);
  expect(reads[0].headers["x-caller"]).toBe("kept");
  // A GET must not acquire a body or a CSRF header.
  expect(reads[0].body).toBeNull();
  expect(reads[0].headers["x-csrftoken"]).toBeUndefined();
});

test("a descriptor-supplied body still reaches fetch", async ({ page }) => {
  // eventNotificationsApi.ts calls customInstance with a hand-written
  // descriptor as the FIRST argument. If such a descriptor ever carries a
  // `body`, the generated-`data` mapping must not swallow it.
  await page.goto("/");
  const seen = await captureApiRequests(page);

  await page.evaluate(async () => {
    const path = "/src/lib/api/mutator.ts";
    const mod: any = await import(/* @vite-ignore */ path);
    return mod.customInstance({
      url: "/api/events/read/1/",
      method: "POST",
      body: JSON.stringify({ descriptor: true }),
    });
  });

  const writes = seen.filter((r) => r.method === "POST");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0].body ?? "null")).toEqual({ descriptor: true });
});

//  /  /. The source assertions in tests/subscribe-idempotency
//.test.mjs prove the call sites ASK for the header; this proves the browser
// actually PUTS IT ON THE WIRE. That distinction is the whole issue: the
// backend protection, the CORS allowance and the spec all existed while the
// deployed UI sent nothing, because orval emits no code at all for an
// `in: header` parameter and regenerating the client changes nothing here.
test("the subscribe POST carries a stable Idempotency-Key (#1003)", async ({
  page,
}) => {
  await page.goto("/");
  const seen = await captureApiRequests(page);

  const keys = await page.evaluate(async () => {
    // Indirect so TypeScript treats these as runtime paths (served by the Vite
    // dev server, not resolvable from tsconfig).
    const tuzisPath = "/src/lib/api/tuzis/tuzis.ts";
    const keyPath = "/src/lib/subscribe-idempotency.js";
    const tuzis: any = await import(/* @vite-ignore */ tuzisPath);
    const idem: any = await import(/* @vite-ignore */ keyPath);

    idem.clearSubscribeIdempotencyKey("astar");

    // Exactly what ProfileSubscribe/SubscribeToCreator do, twice: the first
    // attempt, then the retry after the 15s abort the user is told to make.
    const first = idem.subscribeIdempotencyKey("astar");
    await tuzis.tuzisSubscribeCreate("astar", {
      headers: { "Idempotency-Key": first },
    });
    const second = idem.subscribeIdempotencyKey("astar");
    await tuzis.tuzisSubscribeCreate("astar", {
      headers: { "Idempotency-Key": second },
    });

    return { first, second };
  });

  const writes = seen.filter((r) => r.method === "POST");
  expect(writes).toHaveLength(2);

  // The header is on the wire, not merely computed.
  expect(writes[0].headers["idempotency-key"]).toBe(keys.first);
  expect(writes[1].headers["idempotency-key"]).toBe(keys.second);

  // And the retry replays instead of charging again: a fresh UUID per click
  // would send the header and protect nothing.
  expect(keys.second).toBe(keys.first);

  // The server-side rule from f2z.yaml (contract fixed in ): a
  // canonical UUIDv4 or a 400 `invalid_idempotency_key`. Nothing is truncated.
  expect(keys.first).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("the explicit money endpoints carry their required Idempotency-Key", async ({
  page,
}) => {
  await page.goto("/");
  const seen = await captureApiRequests(page);

  const keys = await page.evaluate(async () => {
    const path = "/src/lib/api/tuzis/tuzis.ts";
    const tuzis: any = await import(/* @vite-ignore */ path);
    const donationKey = "11111111-1111-4111-8111-111111111111";
    const subscriptionKey = "22222222-2222-4222-8222-222222222222";

    await tuzis.tuzisDonateIdempotentCreate(
      "astar",
      { amount: "10", anon: false },
      { headers: { "Idempotency-Key": donationKey } },
    );
    await tuzis.tuzisSubscribeConfirmedCreate(
      "astar",
      { expected_price: "10" },
      { headers: { "Idempotency-Key": subscriptionKey } },
    );

    return { donationKey, subscriptionKey };
  });

  const writes = seen.filter((r) => r.method === "POST");
  expect(writes).toHaveLength(2);
  expect(writes[0].url).toContain("/api/tuzis/donate-idempotent/astar");
  expect(writes[0].headers["idempotency-key"]).toBe(keys.donationKey);
  expect(JSON.parse(writes[0].body ?? "null")).toEqual({
    amount: "10",
    anon: false,
  });
  expect(writes[1].url).toContain("/api/tuzis/subscribe-confirmed/astar");
  expect(writes[1].headers["idempotency-key"]).toBe(keys.subscriptionKey);
  expect(JSON.parse(writes[1].body ?? "null")).toEqual({
    expected_price: "10",
  });
});

test("an undefined header value is omitted rather than throwing", async ({
  page,
}) => {
  await page.goto("/");
  const seen = await captureApiRequests(page);

  await page.evaluate(async () => {
    // Indirect so TypeScript treats this as a runtime path (the module is
    // served by the Vite dev server, not resolvable from tsconfig).
    const path = "/src/lib/api/zpage/zpage.ts";
    const mod: any = await import(/* @vite-ignore */ path);
    return mod.zpageList(
      { page: 1 },
      { headers: { "X-Optional": undefined, "X-Present": "yes" } },
    );
  });

  const reads = seen.filter((r) => r.method === "GET");
  expect(reads).toHaveLength(1);
  expect(reads[0].headers["x-present"]).toBe("yes");
  expect(reads[0].headers["x-optional"]).toBeUndefined();
});

// Loaders use the separate signal argument; write callers can also provide
// options.signal. Neither supported route may lose a pre-send cancellation.
for (const operation of ["read", "write"] as const) {
  test(`a generated ${operation} honors cancellation before sending`, async ({
    page,
  }) => {
    await page.goto("/");
    const seen = await captureApiRequests(page);
    const result = await page.evaluate(async (operation) => {
      const path = "/src/lib/api/zpage/zpage.ts";
      const mod: any = await import(/* @vite-ignore */ path);
      const controller = new AbortController();
      controller.abort();
      try {
        if (operation === "read") {
          await mod.zpageList({ page: 1 }, {}, controller.signal);
        } else {
          await mod.zpagePartialUpdate(
            "cancelled-edit",
            { title: "must not be written" },
            undefined,
            { signal: controller.signal },
          );
        }
        return "completed";
      } catch (error) {
        return error instanceof Error ? error.name : String(error);
      }
    }, operation);
    expect(result).toBe("AbortError");
    const method = operation === "read" ? "GET" : "PATCH";
    expect(seen.filter((request) => request.method === method)).toHaveLength(0);
    if (operation === "write") {
      // An explicit generated argument retains priority over request options.
      await page.evaluate(async () => {
        const path = "/src/lib/api/zpage/zpage.ts";
        const mod: any = await import(/* @vite-ignore */ path);
        const stale = new AbortController();
        stale.abort();
        await mod.zpagePartialUpdate(
          "allowed-edit",
          { title: "explicit current request" },
          undefined,
          { signal: stale.signal },
          new AbortController().signal,
        );
      });
      expect(seen.filter((request) => request.method === "PATCH")).toHaveLength(
        1,
      );
    }
  });
}
