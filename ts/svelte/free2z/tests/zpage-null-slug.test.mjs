import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

//  the literal string `null` was reaching the API as a zPage
// identifier: `GET /api/zpage/null/` 404s several hundred times a day in prod,
// every one of them behind a full SSR render of `/{username}/null`.
//
// WHO IS ASKING: 100% of those requests are `meta-externalagent` (Meta's
// crawler), and the requested path is always the referring page's directory
// plus `null` — `/tallship` -> `/null`, `/free2z/some-article` ->
// `/free2z/null`, `/converse/{uuid}` -> `/converse/null`. That is the
// signature of a RELATIVE reference to `null` resolved against the referrer,
// and it appears for every page type, so it is not something one article's
// markup is doing. It is NOT reproducible from what we serve today: the SSR
// HTML of those exact referrers contains no `null` URL, and a real headless
// Chrome render of them (with the crawler's own UA, net-log captured) issues
// no such request. See the PR for the full trace.
//
// So these tests pin the half we control: the route must recognise a
// stringified nothing and answer 404 ITSELF, without paying for an API round
// trip we already know the answer to. Both assertions fail on `main`, where
// the load reaches `fetch` before the API's 404 comes back.
//
// The sitemap assertions at the bottom are a different kind of check — a pin,
// not a fix. Publishing `/{username}/null` in a sitemap would be far worse
// than being asked for it, because it would be *us* telling Google the URL
// exists. Both the Django queryset (`_zpage_queryset()` excludes
// `vanity=''`/`vanity__isnull=True`) and this parser already refuse it; the
// test makes removing either refusal a test failure rather than a Search
// Console regression discovered weeks later.

const previousApiBase = process.env.PRIVATE_API_BASE_URL;

let vite;
let isNullishSlug;
let vanityLoad;
let legacyZpageLoad;
let parseSitemapChunkPayload;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = "https://api.free2z.test";
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });

  ({ isNullishSlug } = await vite.ssrLoadModule("/src/lib/zpage-slug.ts"));
  ({ load: vanityLoad } = await vite.ssrLoadModule(
    "/src/routes/[username]/[vanity]/+page.server.ts",
  ));
  ({ load: legacyZpageLoad } = await vite.ssrLoadModule(
    "/src/routes/[username]/zpage/[slug]/+page.server.ts",
  ));
  ({ parseSitemapChunkPayload } = await vite.ssrLoadModule(
    "/src/lib/server/sitemap.ts",
  ));
});

after(async () => {
  await vite?.close();
  if (previousApiBase === undefined) {
    delete process.env.PRIVATE_API_BASE_URL;
  } else {
    process.env.PRIVATE_API_BASE_URL = previousApiBase;
  }
});

/**
 * A page event whose `fetch` records every call and refuses to answer. Any
 * request at all is a failure for these cases: the point is not that the
 * response is a 404, it is that we never asked.
 */
function loudEvent(pathname, params) {
  const calls = [];
  return {
    calls,
    params,
    url: new URL(`https://free2z.cash${pathname}`),
    request: { headers: new Headers() },
    locals: { locale: "en" },
    setHeaders: () => {},
    fetch: (input) => {
      calls.push(String(input));
      throw new Error(`unexpected fetch: ${input}`);
    },
  };
}

/**
 * Run a `load` and report what it threw: `{ status, message }` for an
 * `error()`, `{ status, location }` for a `redirect()`. Both are control flow
 * in SvelteKit, and the whole point of these tests is which one you get.
 */
async function outcomeOf(load, event) {
  try {
    await load(event);
  } catch (thrown) {
    if (thrown?.body?.message !== undefined) {
      return { status: thrown.status, message: thrown.body.message };
    }
    if (thrown?.location !== undefined) {
      return { status: thrown.status, location: thrown.location };
    }
    throw thrown;
  }
  return null;
}

test("isNullishSlug spots a stringified nothing, and only that", () => {
  for (const value of [
    null,
    undefined,
    "",
    "   ",
    "null",
    "NULL",
    "Null",
    " null ",
    "undefined",
    "Undefined",
  ]) {
    assert.equal(isNullishSlug(value), true, `expected nullish: ${value}`);
  }

  // Real slugs, including ones that merely CONTAIN the sentinel or read like
  // it. Shadowing a live article would be a worse bug than the 404 we are
  // fixing, so the match is exact, never a substring.
  for (const value of [
    "nullify",
    "null-and-void",
    "the-null-hypothesis",
    "none",
    "nan",
    "0",
    "false",
    "zcash-shielded-news-53",
  ]) {
    assert.equal(isNullishSlug(value), false, `expected usable: ${value}`);
  }
});

test("/{username}/null 404s without asking the API", async () => {
  for (const vanity of ["null", "undefined", "NULL"]) {
    const event = loudEvent(`/zcashbrazil/${vanity}`, {
      username: "zcashbrazil",
      vanity,
    });
    const failure = await outcomeOf(vanityLoad, event);

    assert.deepEqual(failure, {
      status: 404,
      message: "errors.article.notFound",
    });
    assert.deepEqual(
      event.calls,
      [],
      `\`${vanity}\` was forwarded to the API instead of being refused`,
    );
  }
});

test("the legacy /{username}/zpage/null 404s instead of redirecting into one", async () => {
  const event = loudEvent("/zcashbrazil/zpage/null", {
    username: "zcashbrazil",
    slug: "null",
  });
  const failure = await outcomeOf(legacyZpageLoad, event);

  assert.deepEqual(failure, {
    status: 404,
    message: "errors.article.notFound",
  });
});

test("a real slug still reaches the API on both routes", async () => {
  const event = loudEvent("/zcashbrazil/nullify", {
    username: "zcashbrazil",
    vanity: "nullify",
  });
  await assert.rejects(() => vanityLoad(event));
  assert.equal(event.calls.length, 1);
  assert.match(event.calls[0], /\/api\/zpage\/nullify\/\?/);

  const legacy = loudEvent("/zcashbrazil/zpage/nullify", {
    username: "zcashbrazil",
    slug: "nullify",
  });
  legacy.fetch = async (input, init) => {
    legacy.calls.push(String(input));
    assert.equal(init.signal instanceof AbortSignal, true);
    return Response.json({
      creator: { username: "zcashbrazil" },
      vanity: "nullify",
      free2zaddr: "immutable-nullify",
    });
  };
  const redirected = await outcomeOf(legacyZpageLoad, legacy);
  assert.deepEqual(
    redirected,
    { status: 301, location: "/zcashbrazil/nullify" },
    "a usable slug must still redirect, not 404",
  );
  assert.equal(legacy.calls.length, 1);
  assert.match(legacy.calls[0], /\/api\/zpage\/nullify\/$/);
});

test("the sitemap refuses a backend row with no vanity", () => {
  const row = (vanity) => ({
    kind: "zpages",
    page: 0,
    zpages: [
      { username: "zcashbrazil", vanity, updated_at: "2026-08-16T12:00:00Z" },
    ],
  });

  // The one that would actually publish `/zcashbrazil/null` to Google: JSON
  // `null` from the backend, which `encodeURIComponent` would render as the
  // four-character string "null".
  for (const vanity of [null, undefined, "", 0]) {
    assert.throws(
      () => parseSitemapChunkPayload(row(vanity), "zpages", 0),
      /Backend zPage sitemap row was invalid/,
    );
  }

  const entries = parseSitemapChunkPayload(row("nullify"), "zpages", 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "/zcashbrazil/nullify");
});
