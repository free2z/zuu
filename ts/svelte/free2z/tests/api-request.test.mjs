// Regression cover for: the shared API client used to discard the
// caller's request headers, so the session cookie every `+page.server.ts`
// forwards never reached the backend and all SSR rendered anonymous.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mergeRequestHeaders,
  resolveRequestBody,
} from "../src/lib/api/request.js";

const mutatorSource = readFileSync(
  new URL("../src/lib/api/mutator.ts", import.meta.url),
  "utf8",
);
const homepageServerSource = readFileSync(
  new URL("../src/routes/+page.server.ts", import.meta.url),
  "utf8",
);
const trendingServerSource = readFileSync(
  new URL("../src/routes/trending/+page.server.ts", import.meta.url),
  "utf8",
);
const articleServerSource = readFileSync(
  new URL("../src/routes/article/[id]/+page.server.ts", import.meta.url),
  "utf8",
);
const articlePageSource = readFileSync(
  new URL("../src/routes/article/[id]/+page.svelte", import.meta.url),
  "utf8",
);
const converseServerSource = readFileSync(
  new URL("../src/routes/converse/[uuid]/+page.server.ts", import.meta.url),
  "utf8",
);
const usernameServerSource = readFileSync(
  new URL("../src/routes/[username]/+page.server.ts", import.meta.url),
  "utf8",
);
const liveServerSource = readFileSync(
  new URL("../src/routes/live/[username]/+page.server.ts", import.meta.url),
  "utf8",
);
const livePageLoaderSource = readFileSync(
  new URL("../src/lib/server/live-page.ts", import.meta.url),
  "utf8",
);
const liveSource = `${liveServerSource}\n${livePageLoaderSource}`;
const dashboardPagesServerSource = readFileSync(
  new URL(
    "../src/routes/[username]/dashboard/pages/+page.server.ts",
    import.meta.url,
  ),
  "utf8",
);
const dashboardProfileServerSource = readFileSync(
  new URL(
    "../src/routes/[username]/dashboard/profile/+page.server.ts",
    import.meta.url,
  ),
  "utf8",
);
const dashboardStreamServerSource = readFileSync(
  new URL(
    "../src/routes/[username]/dashboard/stream/+page.server.ts",
    import.meta.url,
  ),
  "utf8",
);
const dashboardSettingsServerSource = readFileSync(
  new URL(
    "../src/routes/[username]/dashboard/settings/+page.server.ts",
    import.meta.url,
  ),
  "utf8",
);
const dashboardBillingServerSource = readFileSync(
  new URL(
    "../src/routes/[username]/dashboard/billing/+page.server.ts",
    import.meta.url,
  ),
  "utf8",
);

// --- mergeRequestHeaders -----------------------------------------------

test("the forwarded session cookie survives the merge", () => {
  const headers = mergeRequestHeaders(
    { "Content-Type": "application/json" },
    { cookie: "sessionid=abc123; csrftoken=xyz" },
  );

  assert.equal(headers.get("cookie"), "sessionid=abc123; csrftoken=xyz");
  assert.equal(headers.get("content-type"), "application/json");
});

test("a generated request with no headers still forwards caller headers", () => {
  // Every orval GET descriptor omits `headers` entirely — this is the exact
  // shape that used to blow the cookie away.
  const headers = mergeRequestHeaders(undefined, { cookie: "sessionid=abc" });
  assert.equal(headers.get("cookie"), "sessionid=abc");
});

test("caller headers override generated headers case-insensitively", () => {
  const headers = mergeRequestHeaders(
    { "Content-Type": "application/json" },
    { "content-type": "text/plain" },
  );

  assert.equal(headers.get("content-type"), "text/plain");
  // Exactly one Content-Type reaches the wire, never a differently-cased pair.
  assert.deepEqual(
    [...headers].filter(([key]) => key === "content-type").length,
    1,
  );
});

test("Content-Type defaults to JSON only when nothing supplied one", () => {
  assert.equal(
    mergeRequestHeaders(undefined, undefined).get("content-type"),
    "application/json",
  );
  assert.equal(
    mergeRequestHeaders({ "Content-Type": "text/csv" }, undefined).get(
      "content-type",
    ),
    "text/csv",
  );
});

test("a nullish header value is dropped, not stringified or thrown on", () => {
  // `new Headers({'X-Foo': undefined})` throws; the old object spread turned it
  // into the literal string "undefined". Neither is acceptable once orval emits
  // an optional header parameter.
  assert.doesNotThrow(() =>
    mergeRequestHeaders({ "X-Optional": undefined }, { cookie: undefined }),
  );

  const headers = mergeRequestHeaders(
    { "X-Optional": undefined, "X-Null": null },
    { cookie: undefined, "X-Present": "1" },
  );

  assert.equal(headers.has("X-Optional"), false);
  assert.equal(headers.has("X-Null"), false);
  assert.equal(headers.has("cookie"), false);
  assert.equal(headers.get("X-Present"), "1");
});

test("Headers and entry-array inputs are accepted on both sides", () => {
  const headers = mergeRequestHeaders(new Headers({ "X-Gen": "g" }), [
    ["cookie", "sessionid=abc"],
  ]);

  assert.equal(headers.get("x-gen"), "g");
  assert.equal(headers.get("cookie"), "sessionid=abc");
});

test("a FormData body suppresses Content-Type so fetch sets the boundary", () => {
  const headers = mergeRequestHeaders(
    { "Content-Type": "multipart/form-data" },
    undefined,
    new FormData(),
  );

  assert.equal(headers.has("content-type"), false);
});

test("a self-typed body does not get mislabelled as JSON", () => {
  // fetch types these itself. Stamping application/json on a form post makes
  // Django reject a body it would otherwise have parsed.
  for (const body of [
    new URLSearchParams({ amount: "5" }),
    new Blob(["x"], { type: "text/plain" }),
    new Uint8Array([1, 2, 3]),
    new ArrayBuffer(4),
  ]) {
    assert.equal(
      mergeRequestHeaders(undefined, undefined, body).has("content-type"),
      false,
      `${body.constructor.name} must not be labelled JSON`,
    );
  }

  // An explicit Content-Type is still respected for those bodies.
  assert.equal(
    mergeRequestHeaders(
      undefined,
      { "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ a: "1" }),
    ).get("content-type"),
    "application/x-www-form-urlencoded",
  );

  // A string body and a bodyless GET keep the JSON default every existing
  // call site relies on.
  assert.equal(
    mergeRequestHeaders(undefined, undefined, '{"a":1}').get("content-type"),
    "application/json",
  );
  assert.equal(
    mergeRequestHeaders(undefined, undefined, undefined).get("content-type"),
    "application/json",
  );
});

// --- resolveRequestBody -------------------------------------------------

test("orval's data becomes a JSON body", () => {
  assert.equal(
    resolveRequestBody({ title: "hi" }, undefined),
    JSON.stringify({ title: "hi" }),
  );
});

test("an already-resolved body always wins over generated data", () => {
  // The three in-app generated writes (tuzisDonateCreate,
  // tuzisSubscribeConfirmedCreate, dyteCreate) hand-roll `body` through request options, and the hand-written
  // eventNotificationsApi passes a descriptor as the first argument — both
  // reach this as an existing `body`. Neither may change.
  assert.equal(
    resolveRequestBody({ ignored: true }, '{"amount":5}'),
    '{"amount":5}',
  );
  // An explicitly empty body stays empty.
  assert.equal(resolveRequestBody({ ignored: true }, ""), "");
  // An explicit null body stays null rather than falling back to `data`.
  assert.equal(resolveRequestBody({ ignored: true }, null), null);
});

test("no data and no caller body means no body at all", () => {
  assert.equal(resolveRequestBody(undefined, undefined), undefined);
});

test("pre-encoded bodies pass through untouched", () => {
  const form = new FormData();
  const params = new URLSearchParams({ a: "1" });
  const buffer = new Uint8Array([1, 2, 3]);

  assert.equal(resolveRequestBody("raw", undefined), "raw");
  assert.equal(resolveRequestBody(form, undefined), form);
  assert.equal(resolveRequestBody(params, undefined), params);
  assert.equal(resolveRequestBody(buffer, undefined), buffer);
});

// --- mutator wiring -----------------------------------------------------

test("the mutator merges instead of clobbering the caller's headers", () => {
  // The exact regression: `headers: input.headers` inside the init rebuild.
  assert.doesNotMatch(mutatorSource, /headers:\s*input\.headers\s*,/);
  assert.match(mutatorSource, /const callerHeaders = init\?\.headers;/);
  assert.match(
    mutatorSource,
    /mergeRequestHeaders\(\s*generatedHeaders\s*,\s*callerHeaders\s*,\s*body\s*,?\s*\)/,
  );
});

test("the mutator maps generated data onto the request body", () => {
  // Resolved from `init.body` AFTER the descriptor/options merge, so a
  // descriptor `body` (eventNotificationsApi's shape) keeps its existing
  // precedence and cannot be dropped.
  assert.match(
    mutatorSource,
    /const body = resolveRequestBody\(generatedData, init\?\.body\)/,
  );
  assert.match(mutatorSource, /\bbody,\n\s*headers: defaultHeaders,/);
});

test("CSRF is applied after the header merge so a caller cannot shadow it", () => {
  const mergeIndex = mutatorSource.search(
    /const\s+defaultHeaders\s*=\s*mergeRequestHeaders\s*\(/,
  );
  const csrfIndex = mutatorSource.search(
    /defaultHeaders\s*\.\s*set\(\s*["']X-CSRFToken["']\s*,/,
  );

  assert.ok(mergeIndex >= 0 && csrfIndex >= 0);
  assert.ok(csrfIndex > mergeIndex);
});

// --- cache correctness now that cookies actually flow --------------------

test("every SSR route that forwards a cookie declares Vary: Cookie", () => {
  // zPage.get_queryset ORs `is_published` with `creator=request.user`, so an
  // authenticated render of these routes can contain the viewer's own
  // unpublished pages. A URL-keyed shared cache would hand that to everyone.
  for (const [name, source] of [
    ["homepage", homepageServerSource],
    ["trending", trendingServerSource],
    ["article", articleServerSource],
    ["conversation", converseServerSource],
    ["creator", usernameServerSource],
    ["live", liveSource],
    ["dashboard pages", dashboardPagesServerSource],
    ["dashboard profile", dashboardProfileServerSource],
    ["dashboard stream", dashboardStreamServerSource],
    ["dashboard settings", dashboardSettingsServerSource],
    ["dashboard billing", dashboardBillingServerSource],
  ]) {
    // Cookie may be one of several varying headers: the live viewer also
    // varies on User-Agent.
    assert.match(
      source,
      /vary: "Cookie(?:, [^"]+)?"/,
      `${name} must declare Vary: Cookie`,
    );
  }
});

test("the immutable article route preserves language and subscriber gating", () => {
  assert.match(
    articleServerSource,
    /url\.searchParams\.get\("lang"\)/,
    "the collision escape hatch must fetch the sitemap's localized variant",
  );
  // The variant fetch is a named helper now, so the same call can be made a
  // second time when a language RANGE resolves to a longer tag.
  assert.match(articleServerSource, /\{ lang: language \}/);
  assert.match(articleServerSource, /retrieveVariant\(articleLanguage\)/);
  assert.match(articleServerSource, /const isGated = "page" in response/);
  assert.match(
    articleServerSource,
    /article: isGated \? response\.page : \(response as ZPageDetail\)/,
  );
  assert.match(articleServerSource, /\barticle,\s*\n\s*gated,/);
  assert.match(articlePageSource, /\{#if data\.gated\}/);
  assert.match(
    articlePageSource,
    /<ProfileSubscribe\s+creator=\{article\.creator\}/,
  );
});

test("cookie-forwarding SSR routes make cookie responses private", () => {
  // These routes forward a session cookie only on the request path shown by
  // the condition. Keep the cache policy next to that condition so a future
  // route cannot silently re-enable shared caching for personalized output.
  for (const [name, source, condition] of [
    ["homepage", homepageServerSource, "authenticated"],
    ["trending", trendingServerSource, "cookie"],
    ["conversation", converseServerSource, "cookie"],
    ["creator", usernameServerSource, "sessionId"],
    ["live", liveSource, "cookie"],
  ]) {
    const privacyPattern =
      name === "creator"
        ? /if\s*\(sessionId\)\s*\{[\s\S]*?"cache-control": "private, no-cache"/
        : new RegExp(
            `${condition}\\s*\\?[\\s\\S]*?"cache-control": "private, no-cache"`,
          );
    assert.match(
      source,
      privacyPattern,
      `${name} must make cookie-backed renders private`,
    );
  }
});

test("authenticated dashboard SSR loads make responses private", () => {
  for (const [name, source] of [
    ["dashboard pages", dashboardPagesServerSource],
    ["dashboard profile", dashboardProfileServerSource],
    ["dashboard stream", dashboardStreamServerSource],
    ["dashboard settings", dashboardSettingsServerSource],
    ["dashboard billing", dashboardBillingServerSource],
  ]) {
    assert.match(
      source,
      /setHeaders\(\{\s*"cache-control": "private, no-cache",\s*vary: "Cookie"\s*\}\)/,
      `${name} must make authenticated renders private`,
    );
  }
});

test("an authenticated homepage render is declared uncacheable", () => {
  assert.match(
    homepageServerSource,
    /authenticated\s*\?\s*\{\s*"cache-control": "private, no-cache", vary: "Cookie" \}/,
  );
});

test("trending writes one cache policy after success or failure, never both", () => {
  const fetchIndex = trendingServerSource.indexOf("const response");
  const successHeadersIndex = trendingServerSource.indexOf(
    "event.setHeaders(",
    fetchIndex,
  );
  const catchIndex = trendingServerSource.indexOf("} catch");
  const failureHeadersIndex = trendingServerSource.indexOf(
    'event.setHeaders({ "cache-control": "no-store", vary: "Cookie" })',
    catchIndex,
  );

  assert.ok(fetchIndex >= 0, "trending must fetch the list");
  assert.ok(
    successHeadersIndex > fetchIndex && successHeadersIndex < catchIndex,
    "success cache headers must be deferred until after the fetch",
  );
  assert.ok(
    failureHeadersIndex > catchIndex,
    "failed fetches must set their own no-store policy",
  );
  assert.equal(
    (trendingServerSource.match(/event\.setHeaders\(/g) || []).length,
    2,
    "trending should have one success and one failure header write",
  );
});
