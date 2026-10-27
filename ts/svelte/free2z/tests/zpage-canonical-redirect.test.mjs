import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let vanityLoad;
let immutableArticleLoad;
let profileOrRootLoad;
let HistoricRootAdmission;
let historicRootClientKey;
let historicRootForwardedFor;
const previousApiBase = process.env.PRIVATE_API_BASE_URL;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = "https://api.free2z.test";
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ load: vanityLoad } = await vite.ssrLoadModule(
    "/src/routes/[username]/[vanity]/+page.server.ts",
  ));
  ({ load: immutableArticleLoad } = await vite.ssrLoadModule(
    "/src/routes/article/[id]/+page.server.ts",
  ));
  ({ load: profileOrRootLoad } = await vite.ssrLoadModule(
    "/src/routes/[username]/+page.server.ts",
  ));
  ({ HistoricRootAdmission, historicRootClientKey, historicRootForwardedFor } =
    await vite.ssrLoadModule("/src/lib/server/historic-root-admission.ts"));
});

after(async () => {
  await vite?.close();
  if (previousApiBase === undefined) {
    delete process.env.PRIVATE_API_BASE_URL;
  } else {
    process.env.PRIVATE_API_BASE_URL = previousApiBase;
  }
});

test("canonical redirects encode both path segments and preserve the query", async () => {
  const requestedUsername = "old-owner";
  // This is the above-Latin-1 shape that caused the production 500.
  const canonicalUsername = "cΔrovΣr0";
  const vanity = "café du matin";
  const query = "?lang=fr&tag=a%2Bb&tag=&empty";
  const expectedLocation =
    "/c%CE%94rov%CE%A3r0/caf%C3%A9%20du%20matin?lang=fr&tag=a%2Bb&tag=&empty";
  const event = {
    params: { username: requestedUsername, vanity },
    url: new URL(
      `https://free2z.cash/${requestedUsername}/${encodeURIComponent(vanity)}${query}`,
    ),
    request: { headers: new Headers() },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async () =>
      new Response(
        JSON.stringify({
          creator: { username: canonicalUsername },
          vanity,
          free2zaddr: "immutable-address",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  };

  await assert.rejects(
    () => vanityLoad(event),
    (thrown) => {
      assert.equal(thrown.status, 301);
      assert.match(
        thrown.location,
        /^[\x20-\x7e]*$/,
        "Location must be ASCII-safe",
      );
      assert.equal(thrown.location, expectedLocation);
      return true;
    },
  );
});

test("canonical redirects escape an nginx-owned creator namespace", async () => {
  const event = {
    params: { username: "wrong-owner", vanity: "ordinary-story" },
    url: new URL("https://free2z.cash/wrong-owner/ordinary-story?lang=es"),
    request: { headers: new Headers() },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async () =>
      Response.json({
        creator: { username: "static" },
        vanity: "ordinary-story",
        free2zaddr: "immutable-address",
      }),
  };

  await assert.rejects(
    () => vanityLoad(event),
    (thrown) => {
      assert.equal(thrown.status, 301);
      assert.equal(thrown.location, "/article/immutable-address?lang=es");
      return true;
    },
  );
});

test("the immutable article route preserves backend absence versus outage", async () => {
  const originalFetch = globalThis.fetch;
  const articleEvent = {
    params: { id: "immutable-address" },
    url: new URL("https://free2z.cash/article/immutable-address"),
    request: {
      headers: new Headers(),
      signal: new AbortController().signal,
    },
    locals: { locale: "en" },
    setHeaders: () => {},
  };

  try {
    for (const [backendStatus, expectedStatus] of [
      [404, 404],
      [503, 503],
    ]) {
      globalThis.fetch = async () =>
        new Response("temporarily unavailable", { status: backendStatus });
      await assert.rejects(
        () => immutableArticleLoad(articleEvent),
        (thrown) => thrown.status === expectedStatus,
        `backend ${backendStatus}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("historic root vanity redirects to the article canonical URL", async () => {
  const requests = [];
  const headers = {};
  const event = {
    params: { username: "legacy café" },
    url: new URL(
      "https://free2z.cash/legacy%20caf%C3%A9?lang=fr&tag=a%2Bb&empty",
    ),
    cookies: { get: () => undefined },
    locals: { locale: "en" },
    request: {
      signal: new AbortController().signal,
      headers: new Headers({
        "x-forwarded-for": "2001:db8:1234:5678::cafe",
      }),
    },
    setHeaders: (next) => Object.assign(headers, next),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/api/creator/")) {
        return new Response(null, { status: 404 });
      }
      if (String(url).includes("/api/get-type/")) {
        return Response.json("zpage");
      }
      if (String(url).includes("/api/zpage/")) {
        return Response.json({
          creator: { username: "cΔrovΣr0" },
          vanity: "café du matin",
          free2zaddr: "immutable-address",
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) => {
      assert.equal(thrown.status, 301);
      assert.equal(
        thrown.location,
        "/c%CE%94rov%CE%A3r0/caf%C3%A9%20du%20matin?lang=fr&tag=a%2Bb&empty",
      );
      return true;
    },
  );
  assert.equal(
    requests.filter(({ url }) => url.includes("/api/zpage/")).length,
    1,
  );
  const requestSignals = requests.map(({ init }) => init?.signal);
  assert.equal(requestSignals.length, 3);
  assert.ok(requestSignals.every((signal) => signal instanceof AbortSignal));
  assert.notEqual(
    requestSignals[0],
    requestSignals[1],
    "the historic resolver has its shorter child deadline",
  );
  assert.equal(
    requestSignals[1],
    requestSignals[2],
    "type and detail share one body-inclusive root resolver deadline",
  );
  const typeRequest = requests.find(({ url }) =>
    url.includes("/api/get-type/"),
  );
  assert.equal(
    typeRequest.init.headers["X-Forwarded-For"],
    "2001:db8:1234:5678::, 127.0.0.1",
    "the internal sidecar hop must keep nginx's bucket on the visitor /64",
  );
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers.vary, "Cookie");
});

test("historic owner-only root links forward the session to detail", async () => {
  const lookupHeaders = [];
  const lookupSignals = [];
  const headers = {};
  const event = {
    params: { username: "draft-address" },
    url: new URL("https://free2z.cash/draft-address"),
    cookies: {
      get: (name) => (name === "sessionid" ? "owner-session" : undefined),
    },
    request: { signal: new AbortController().signal },
    locals: { locale: "en" },
    setHeaders: (next) => Object.assign(headers, next),
    fetch: async (url, init) => {
      if (String(url).includes("/api/auth/user/")) {
        return Response.json({ username: "someone-else" });
      }
      if (String(url).includes("/api/creator/")) {
        return new Response(null, { status: 404 });
      }
      if (String(url).includes("/api/get-type/")) {
        return Response.json("zpage");
      }
      if (String(url).includes("/api/zpage/")) {
        lookupHeaders.push(init?.headers?.Cookie);
        lookupSignals.push(init?.signal);
      }
      if (String(url).includes("/api/zpage/")) {
        return Response.json({
          creator: { username: "owner" },
          vanity: null,
          free2zaddr: "draft-address",
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) =>
      thrown.status === 301 && thrown.location === "/owner/draft-address",
  );
  assert.deepEqual(lookupHeaders, ["sessionid=owner-session"]);
  assert.equal(lookupSignals.length, 1);
  assert.ok(lookupSignals[0] instanceof AbortSignal);
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers.vary, "Cookie");
});

test("historic gated links redirect to the canonical paywall URL", async () => {
  const event = {
    params: { username: "paid-root-link" },
    url: new URL("https://free2z.cash/paid-root-link?from=bookmark"),
    cookies: { get: () => undefined },
    request: { signal: new AbortController().signal },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      if (String(url).includes("/api/creator/")) {
        return new Response(null, { status: 404 });
      }
      if (String(url).includes("/api/get-type/")) {
        return Response.json("zpage");
      }
      if (String(url).includes("/api/zpage/")) {
        return Response.json({
          show_modal: true,
          page: {
            creator: { username: "paid-creator" },
            vanity: "subscriber-post",
            free2zaddr: "paid-root-link",
            content: "",
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) =>
      thrown.status === 301 &&
      thrown.location === "/paid-creator/subscriber-post?from=bookmark",
  );
});

test("a grandfathered stream vanity redirects through its immutable address", async () => {
  const event = {
    params: { username: "broadcast" },
    url: new URL("https://free2z.cash/broadcast"),
    cookies: { get: () => undefined },
    request: { signal: new AbortController().signal },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      if (String(url).includes("/api/creator/")) {
        return new Response(null, { status: 404 });
      }
      if (String(url).includes("/api/get-type/")) {
        return Response.json("zpage");
      }
      if (String(url).includes("/api/zpage/")) {
        return Response.json({
          creator: { username: "legacy-stream-owner" },
          vanity: "broadcast",
          free2zaddr: "collision-safe-address",
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) =>
      thrown.status === 301 &&
      thrown.location === "/legacy-stream-owner/collision-safe-address",
  );
});

test("a grandfathered reserved creator redirects through the cross-UI article route", async () => {
  const event = {
    params: { username: "historic-root" },
    url: new URL("https://free2z.cash/historic-root?from=bookmark"),
    cookies: { get: () => undefined },
    request: { signal: new AbortController().signal },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      if (String(url).includes("/api/creator/")) {
        return new Response(null, { status: 404 });
      }
      if (String(url).includes("/api/get-type/")) {
        return Response.json("zpage");
      }
      if (String(url).includes("/api/zpage/")) {
        return Response.json({
          creator: { username: "live" },
          vanity: "ordinary-vanity",
          free2zaddr: "immutable-address",
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) =>
      thrown.status === 301 &&
      thrown.location === "/article/immutable-address?from=bookmark",
  );
});

test("a safe vanity wins when a grandfathered immutable address is reserved", async () => {
  const event = {
    params: { username: "historic-root" },
    url: new URL("https://free2z.cash/historic-root?from=bookmark"),
    cookies: { get: () => undefined },
    request: { signal: new AbortController().signal },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      if (String(url).includes("/api/creator/")) {
        return new Response(null, { status: 404 });
      }
      if (String(url).includes("/api/get-type/")) {
        return Response.json("zpage");
      }
      if (String(url).includes("/api/zpage/")) {
        return Response.json({
          creator: { username: "legacy-owner" },
          vanity: "ordinary-vanity",
          free2zaddr: "broadcast",
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) =>
      thrown.status === 301 &&
      thrown.location === "/legacy-owner/ordinary-vanity?from=bookmark",
  );
});

test("historic root resolution uses the article escape hatch when every identifier is reserved", async () => {
  const event = {
    params: { username: "historic-root" },
    url: new URL("https://free2z.cash/historic-root"),
    cookies: { get: () => undefined },
    request: { signal: new AbortController().signal },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      if (String(url).includes("/api/creator/")) {
        return new Response(null, { status: 404 });
      }
      if (String(url).includes("/api/get-type/")) {
        return Response.json("zpage");
      }
      if (String(url).includes("/api/zpage/")) {
        return Response.json({
          creator: { username: "legacy-owner" },
          vanity: "broadcast",
          free2zaddr: "ppv",
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) => thrown.status === 301 && thrown.location === "/article/ppv",
  );
});

test("downstream resolver admission keeps its 429 load-shedding response", async () => {
  const requests = [];
  const event = {
    params: { username: "busy-root" },
    url: new URL("https://free2z.cash/busy-root"),
    cookies: { get: () => undefined },
    request: {
      signal: new AbortController().signal,
      headers: new Headers({
        "x-forwarded-for": "203.0.113.88",
      }),
    },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).includes("/api/creator/")) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 429 });
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) => thrown.status === 429,
  );
  assert.equal(requests.length, 2, "429 must stop before zPage detail lookup");
});

test("an unknown historic root vanity stops after one type-resolution pass", async () => {
  const requests = [];
  const event = {
    params: { username: "does-not-exist" },
    url: new URL("https://free2z.cash/does-not-exist"),
    cookies: { get: () => undefined },
    request: { signal: new AbortController().signal },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(null, { status: 404 });
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) => thrown.status === 404,
  );
  assert.equal(
    requests.filter((url) => url.includes("/api/get-type/")).length,
    1,
  );
  assert.equal(
    requests.filter((url) => url.includes("/api/zpage/")).length,
    0,
    "a random scanner miss must not enter detail's repeated resolver path",
  );
});

test("historic root admission is a per-client token bucket", () => {
  const admission = new HistoricRootAdmission();
  const now = 10_000;

  for (let request = 0; request < 10; request += 1) {
    assert.deepEqual(admission.admit("203.0.113.7", now), {
      admitted: true,
    });
  }
  assert.deepEqual(admission.admit("203.0.113.7", now), {
    admitted: false,
    retryAfterSeconds: 1,
  });
  assert.deepEqual(
    admission.admit("198.51.100.8", now),
    { admitted: true },
    "one client must not spend another client's bucket",
  );
  assert.deepEqual(admission.admit("203.0.113.7", now + 1_000), {
    admitted: true,
  });
});

test("historic root admission fails open until trusted XFF supplies identity", () => {
  assert.equal(
    historicRootClientKey({ request: { headers: new Headers() } }),
    null,
  );
  assert.equal(
    historicRootClientKey({
      request: {
        headers: new Headers({
          "x-forwarded-for": "forged, 203.0.113.7",
        }),
      },
    }),
    null,
  );
  for (const malformed of [
    "not-an-ip",
    "2001:db8:::1",
    "203.0.113.999",
    "fe80::1%en0",
    "empty-client, 34.102.196.190",
    "203.0.113.7, ",
  ]) {
    assert.equal(
      historicRootClientKey({
        request: {
          headers: new Headers({
            "x-forwarded-for": malformed,
          }),
        },
      }),
      null,
      malformed,
    );
  }
});

test("old ingress uses GCLB's right suffix and ignores a forged private identity", () => {
  assert.equal(
    historicRootClientKey({
      request: {
        headers: new Headers({
          // Caller prefixes are left of the append-only client/LB suffix.
          "x-forwarded-for":
            "attacker-chosen-prefix, 203.0.113.71, 34.102.196.190",
          "x-free2z-originating-client": "attacker-chosen-bucket",
        }),
      },
    }),
    "203.0.113.71",
  );
});

test("same-revision sidecar supplies one normalized XFF identity", () => {
  assert.equal(
    historicRootClientKey({
      request: {
        headers: new Headers({
          "x-forwarded-for": "2001:db8:1234:5678::beef",
          "x-free2z-originating-client": "attacker-chosen-bucket",
        }),
      },
    }),
    "2001:db8:1234:5678::/64",
  );
});

test("missing sidecar identity reaches the resolver without synthetic XFF", async () => {
  const requests = [];
  const event = {
    params: { username: "old-ingress-root-miss" },
    url: new URL("https://free2z.cash/old-ingress-root-miss"),
    cookies: { get: () => undefined },
    request: {
      signal: new AbortController().signal,
      headers: new Headers(),
    },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 404 });
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) => thrown.status === 404,
  );
  assert.equal(requests.length, 2, "the creator miss must reach get-type");
  assert.match(requests[1].url, /\/api\/get-type\/old-ingress-root-miss$/);
  assert.equal(
    new Headers(requests[1].init?.headers).get("x-forwarded-for"),
    null,
    "missing trusted ingress identity must remain absent through Svelte",
  );
});

test("decoded root parameters stay inside every backend URL segment", async () => {
  const requests = [];
  const decodedUsername = "../get-type/scanner-proof?x";
  const encodedUsername = encodeURIComponent(decodedUsername);
  const event = {
    params: { username: decodedUsername },
    url: new URL("https://free2z.cash/..%2Fget-type%2Fscanner-proof%3Fx"),
    cookies: { get: () => undefined },
    request: {
      signal: new AbortController().signal,
      headers: new Headers({
        "x-forwarded-for": "203.0.113.9, 34.102.196.190",
      }),
    },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (input) => {
      requests.push(String(input));
      return new Response(null, { status: 404 });
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) => thrown.status === 404,
  );
  assert.deepEqual(requests, [
    `https://api.free2z.test/api/creator/${encodedUsername}/`,
    `https://api.free2z.test/api/get-type/${encodedUsername}`,
  ]);
  assert.equal(
    requests.some((request) => request.includes("/api/get-type/scanner-proof")),
    false,
    "the initial creator read must not normalize into the resolver before admission",
  );
});

test("historic root admission groups native IPv6 by canonical /64", () => {
  const clientKey = (address) =>
    historicRootClientKey({
      request: {
        headers: new Headers({
          "x-forwarded-for": address,
        }),
      },
    });

  assert.equal(clientKey("2001:0DB8:1234:5678::1"), "2001:db8:1234:5678::/64");
  assert.equal(
    clientKey("2001:db8:1234:5678:ffff:ffff:ffff:ffff"),
    "2001:db8:1234:5678::/64",
  );
  assert.equal(clientKey("2001:db8:1234:5679::1"), "2001:db8:1234:5679::/64");
  assert.equal(
    clientKey("2001:db8:1234:5678::/64"),
    null,
    "the trusted ingress header must still contain an address, not a prefix",
  );

  const admission = new HistoricRootAdmission();
  const now = 20_000;
  for (let request = 0; request < 10; request += 1) {
    const rotatingAddress = `2001:db8:1234:5678::${request + 1}`;
    assert.deepEqual(admission.admit(clientKey(rotatingAddress), now), {
      admitted: true,
    });
  }
  assert.deepEqual(
    admission.admit(clientKey("2001:db8:1234:5678::ffff"), now),
    { admitted: false, retryAfterSeconds: 1 },
    "rotating an interface identifier must not mint a fresh bucket",
  );
  assert.deepEqual(
    admission.admit(clientKey("2001:db8:1234:5679::1"), now),
    { admitted: true },
    "a different /64 keeps an independent bucket",
  );
});

test("IPv4-mapped IPv6 shares the fixed IPv4 client bucket", () => {
  const clientKey = (address) =>
    historicRootClientKey({
      request: {
        headers: new Headers({
          "x-forwarded-for": address,
        }),
      },
    });
  assert.equal(clientKey("192.0.2.44"), "192.0.2.44");
  assert.equal(clientKey("::ffff:192.0.2.44"), "192.0.2.44");
  assert.equal(clientKey("0:0:0:0:0:ffff:c000:022c"), "192.0.2.44");
  assert.equal(
    historicRootForwardedFor(clientKey("::ffff:192.0.2.44")),
    "192.0.2.44, 127.0.0.1",
  );
  assert.equal(historicRootForwardedFor("not-an-ip"), null);

  const admission = new HistoricRootAdmission();
  const now = 30_000;
  for (let request = 0; request < 10; request += 1) {
    assert.deepEqual(admission.admit("192.0.2.44", now), { admitted: true });
  }
  assert.deepEqual(admission.admit("::ffff:192.0.2.44", now), {
    admitted: false,
    retryAfterSeconds: 1,
  });
});

test("an exhausted client stops before the historic resolver", async () => {
  const client = "192.0.2.150";
  let backendRequests = 0;
  let retryAfter;

  const event = () => ({
    params: { username: "random-scanner-miss" },
    url: new URL("https://free2z.cash/random-scanner-miss"),
    cookies: { get: () => undefined },
    request: {
      signal: new AbortController().signal,
      headers: new Headers({ "x-forwarded-for": client }),
    },
    locals: { locale: "en" },
    setHeaders: (headers) => {
      retryAfter ||= headers["retry-after"];
    },
    fetch: async () => {
      backendRequests += 1;
      return new Response(null, { status: 404 });
    },
  });

  for (let request = 0; request < 10; request += 1) {
    await assert.rejects(
      () => profileOrRootLoad(event()),
      (thrown) => thrown.status === 404,
    );
  }
  assert.equal(backendRequests, 20, "each admitted miss uses two lookups");

  await assert.rejects(
    () => profileOrRootLoad(event()),
    (thrown) => thrown.status === 429,
  );
  assert.equal(
    backendRequests,
    21,
    "a rate rejection may confirm the profile miss but must not enter get-type",
  );
  assert.equal(retryAfter, "1");
});

test("an invalid session cookie cannot bypass anonymous root admission", async () => {
  const client = "192.0.2.151";
  const requestCounts = { auth: 0, creator: 0, type: 0 };

  const event = () => ({
    params: { username: "cookie-scanner-miss" },
    url: new URL("https://free2z.cash/cookie-scanner-miss"),
    cookies: {
      get: (name) => (name === "sessionid" ? "junk-session" : undefined),
    },
    request: {
      signal: new AbortController().signal,
      headers: new Headers({ "x-forwarded-for": client }),
    },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      if (String(url).includes("/api/auth/user/")) {
        requestCounts.auth += 1;
        return new Response(null, { status: 401 });
      }
      if (String(url).includes("/api/creator/")) {
        requestCounts.creator += 1;
        return new Response(null, { status: 404 });
      }
      if (String(url).includes("/api/get-type/")) {
        requestCounts.type += 1;
        return new Response(null, { status: 404 });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  for (let request = 0; request < 10; request += 1) {
    await assert.rejects(
      () => profileOrRootLoad(event()),
      (thrown) => thrown.status === 404,
    );
  }
  await assert.rejects(
    () => profileOrRootLoad(event()),
    (thrown) => thrown.status === 429,
  );
  assert.deepEqual(requestCounts, {
    auth: 11,
    creator: 11,
    type: 10,
  });
});

test("a valid session cannot bypass historic root admission", async () => {
  const client = "192.0.2.153";
  const requestCounts = { auth: 0, creator: 0, type: 0 };

  const event = () => ({
    params: { username: "authenticated-scanner-miss" },
    url: new URL("https://free2z.cash/authenticated-scanner-miss"),
    cookies: {
      get: (name) => (name === "sessionid" ? "valid-session" : undefined),
    },
    request: {
      signal: new AbortController().signal,
      headers: new Headers({ "x-forwarded-for": client }),
    },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      if (String(url).includes("/api/auth/user/")) {
        requestCounts.auth += 1;
        return Response.json({ username: "scanner-account" });
      }
      if (String(url).includes("/api/creator/")) {
        requestCounts.creator += 1;
        return new Response(null, { status: 404 });
      }
      if (String(url).includes("/api/get-type/")) {
        requestCounts.type += 1;
        return new Response(null, { status: 404 });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  for (let request = 0; request < 10; request += 1) {
    await assert.rejects(
      () => profileOrRootLoad(event()),
      (thrown) => thrown.status === 404,
    );
  }
  await assert.rejects(
    () => profileOrRootLoad(event()),
    (thrown) => thrown.status === 429,
  );
  assert.deepEqual(requestCounts, {
    auth: 11,
    creator: 11,
    type: 10,
  });
});

test("creator hover preloads do not spend historic-root admission", async () => {
  const client = "192.0.2.152";
  let creatorRequests = 0;

  const event = (username) => ({
    params: { username },
    url: new URL(`https://free2z.cash/${username}`),
    cookies: { get: () => undefined },
    request: {
      signal: new AbortController().signal,
      headers: new Headers({ "x-forwarded-for": client }),
    },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      if (String(url).includes("/api/creator/")) {
        creatorRequests += 1;
        return Response.json({ username });
      }
      if (String(url).includes("/api/tagging/autocomplete")) {
        return Response.json([]);
      }
      if (String(url).includes("/api/zpage/")) {
        return Response.json({ results: [], count: 0 });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  for (let request = 0; request < 20; request += 1) {
    const data = await profileOrRootLoad(event(`creator-${request}`));
    assert.equal(data.type, "creator");
  }
  assert.equal(creatorRequests, 20);

  for (let request = 0; request < 10; request += 1) {
    await assert.rejects(
      () =>
        profileOrRootLoad({
          ...event("historic-miss"),
          fetch: async (url) => {
            if (String(url).includes("/api/creator/")) {
              return new Response(null, { status: 404 });
            }
            if (String(url).includes("/api/get-type/")) {
              return new Response(null, { status: 404 });
            }
            throw new Error(`unexpected request: ${url}`);
          },
        }),
      (thrown) => thrown.status === 404,
    );
  }
  await assert.rejects(
    () =>
      profileOrRootLoad({
        ...event("historic-miss"),
        fetch: async (url) => {
          if (String(url).includes("/api/creator/")) {
            return new Response(null, { status: 404 });
          }
          throw new Error("historic resolver must be rate limited");
        },
      }),
    (thrown) => thrown.status === 429,
  );
});

test("a root-vanity resolver outage is an honest 503", async () => {
  const event = {
    params: { username: "maybe-a-page" },
    url: new URL("https://free2z.cash/maybe-a-page"),
    cookies: { get: () => undefined },
    request: { signal: new AbortController().signal },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: async (url) => {
      if (String(url).includes("/api/creator/")) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 503 });
    },
  };

  await assert.rejects(
    () => profileOrRootLoad(event),
    (thrown) => thrown.status === 503,
  );
});
