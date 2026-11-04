import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

//  classic-only paths used to fall through SvelteKit's greedy
// `[username]` route and 404. These tests pin WHICH answer each one gives,
// because the difference between 301, 302 and 410 is the entire point:
//
//   301 + no-store — the content moved; permanent for search engines, but
//                    not sticky in a browser while classic still owns the
//                    old URL and cannot serve the new one
//   302 + private/no-store — the destination is derived from the session
//   410 — the feature is gone and nothing replaced it
//
// The end-to-end proof that a static route really outranks `[username]`, and
// that each redirect lands on a 200, lives in
// tests/browser/legacy-route-redirects.spec.ts (real HTTP, real router).

const UI_ROOT = fileURLToPath(new URL("..", import.meta.url));

let vite;
const routes = {};
let legacyRoutes;
let mapToClassicUi;
let storytimeLegacyCreatorMatch;

const previousApiBase = process.env.PRIVATE_API_BASE_URL;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = "https://api.free2z.test";
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });

  legacyRoutes = await vite.ssrLoadModule("/src/lib/server/legacy-routes.ts");
  ({ mapToClassicUi } = await vite.ssrLoadModule(
    "/src/lib/utils/classic-ui.ts",
  ));
  ({ match: storytimeLegacyCreatorMatch } = await vite.ssrLoadModule(
    "/src/params/storytimeLegacyCreator.ts",
  ));

  for (const [name, file] of Object.entries({
    ai: "/src/routes/ai/+page.server.ts",
    aiPublic: "/src/routes/ai/public/+page.server.ts",
    aiConversation: "/src/routes/ai/conversation/[...rest]/+page.server.ts",
    storytimeDisplay:
      "/src/routes/storytime/[creator=storytimeLegacyCreator]/[slug]/+page.server.ts",
    storytimeEdit:
      "/src/routes/storytime/edit/[creator]/[slug]/+page.server.ts",
    tools: "/src/routes/tools/p2pe2e/+page.server.ts",
    toolsMeeting: "/src/routes/tools/p2pe2e/[meeting]/+page.server.ts",
  })) {
    routes[name] = (await vite.ssrLoadModule(file)).load;
  }

  for (const [name, file] of Object.entries({
    find: "/src/routes/find/+server.ts",
    begin: "/src/routes/begin/+server.ts",
    beginAlt: "/src/routes/begin/alt/+server.ts",
    edit: "/src/routes/edit/[id]/+server.ts",
    profile: "/src/routes/profile/+server.ts",
    profileKyc: "/src/routes/profile/kyc/+server.ts",
    profileUploads: "/src/routes/profile/uploads/+server.ts",
    events: "/src/routes/events/+server.ts",
  })) {
    routes[name] = (await vite.ssrLoadModule(file)).GET;
  }
});

after(async () => {
  await vite?.close();
  if (previousApiBase === undefined) {
    delete process.env.PRIVATE_API_BASE_URL;
  } else {
    process.env.PRIVATE_API_BASE_URL = previousApiBase;
  }
});

/** Call a `+server.ts` GET and report its status/location as a plain object. */
function redirectFrom(handler, event) {
  const response = handler(event);
  return {
    status: response.status,
    location: response.headers.get("location"),
  };
}

test("Stage 4 retains rollback controls without advertising classic UI", () => {
  const read = (relative) =>
    fs.readFileSync(path.join(UI_ROOT, relative), "utf8");
  const layout = read("src/routes/+layout.svelte");
  const advertisedChrome = [
    "src/lib/components/layout/Navbar.svelte",
    "src/lib/components/layout/MobileNavMenu.svelte",
    "src/lib/components/auth/AuthUserDropdown.svelte",
  ].map(read);

  assert.doesNotMatch(layout, /ClassicUiBanner/);
  for (const source of advertisedChrome) {
    assert.doesNotMatch(source, /classicUi(?:Available|SwitchHref)/);
    assert.doesNotMatch(source, /switchToClassicUi|\/classic-ui/);
  }
  assert.equal(
    fs.existsSync(
      path.join(UI_ROOT, "src/lib/components/layout/ClassicUiBanner.svelte"),
    ),
    true,
    "rollback source stays packaged until the later asset-retirement phase",
  );
});

/** The same, plus the cache policy, for the assertions that care. */
function hopFrom(handler, event) {
  const response = handler(event);
  return {
    status: response.status,
    location: response.headers.get("location"),
    cacheControl: response.headers.get("cache-control"),
  };
}

/** Run a page `load` and report the HttpError it threw, or null. */
function errorFrom(load, event) {
  try {
    load(event);
  } catch (thrown) {
    if (thrown?.status && thrown?.body) {
      return { status: thrown.status, message: thrown.body.message };
    }
    throw thrown;
  }
  return null;
}

function pageEvent(pathname, search = "", params = {}) {
  return {
    params,
    url: new URL(`https://free2z.cash${pathname}${search}`),
    setHeaders: () => {},
  };
}

/** A page event that records what the load asked `setHeaders` for. */
function recordingPageEvent(pathname) {
  const headers = {};
  return {
    headers,
    event: {
      params: {},
      url: new URL(`https://free2z.cash${pathname}`),
      setHeaders: (next) => Object.assign(headers, next),
    },
  };
}

/** A cookie jar and a backend whose /api/auth/user/ answer is scripted. */
function serverEvent({ session, user, status = 200, pathname = "/profile" }) {
  const requests = [];
  return {
    requests,
    event: {
      url: new URL(`https://free2z.cash${pathname}`),
      cookies: {
        get: (name) => (name === "sessionid" ? session : undefined),
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        if (status !== 200) {
          return new Response("nope", { status });
        }
        return new Response(JSON.stringify(user), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
}

// --------------------------------------------------------------------------
// Permanent, session-independent redirects
// --------------------------------------------------------------------------

test("/find 301s to the search route and renames search= to q=", () => {
  assert.deepEqual(
    redirectFrom(routes.find, pageEvent("/find", "?search=zcash")),
    {
      status: 301,
      location: "/search?q=zcash",
    },
  );
});

test("/find carries only the parameters the destination honours", () => {
  const { location } = redirectFrom(
    routes.find,
    pageEvent("/find", "?search=zec&page=3&ordering=-updated_at&unfunded=0"),
  );
  const params = new URLSearchParams(
    new URL(location, "https://x.test").search,
  );
  assert.equal(params.get("q"), "zec");
  assert.equal(params.get("page"), "3");
  // `search` must not survive alongside `q`, or the destination sees both.
  assert.equal(params.has("search"), false);
  // `/search` implements neither of these. Forwarding them would produce a
  // URL that claims a filter nobody applies.
  assert.equal(params.has("ordering"), false);
  assert.equal(params.has("unfunded"), false);
});

test("a query-less /find lands on a browsable listing, not an empty form", () => {
  // Classic's /find doubled as a listing: with no query it still rendered
  // pages. Bare `/search` shows an empty form AND declares `noindex, follow`,
  // so redirecting there would permanently move a crawlable discovery page
  // onto a noindex dead end.
  for (const search of ["", "?ordering=-updated_at", "?search="]) {
    assert.deepEqual(
      redirectFrom(routes.find, pageEvent("/find", search)),
      { status: 301, location: "/trending" },
      search || "(no query)",
    );
  }
});

test("/find keeps a classic tag filter, which now has a destination", () => {
  // Classic emitted `/find?tags=video` from a tag click. That used to become a
  // bare `/trending` because nothing in the new UI could apply a tag filter, so
  // carrying the parameter would have promised a filter the page ignored.
  // `/search?tag=` applies it, so the promise is now kept — and since
  //  the destination is the indexable topic hub itself.
  //
  // ONE hop. `/search?tag=` 301s to the hub on its own, so routing through it
  // would make this a 301 -> 301 chain.
  assert.deepEqual(
    redirectFrom(routes.find, pageEvent("/find", "?tags=video")),
    { status: 301, location: "/tag/video" },
  );
  // Case and separators normalise on the way, so the classic link lands on the
  // canonical URL rather than on a second 301.
  assert.deepEqual(
    redirectFrom(routes.find, pageEvent("/find", "?tags=Zebra%20Husbandry")),
    { status: 301, location: "/tag/zebra-husbandry" },
  );
  // Several tags are ANDed by the API and a hub is one tag, so the value keeps
  // the `/search` destination that can still express the AND — crossing over
  // verbatim, as before.
  assert.deepEqual(
    redirectFrom(routes.find, pageEvent("/find", "?tags=video,zcash")),
    { status: 301, location: "/search?tag=video%2Czcash" },
  );
  // A tag with no slug has no hub URL at all, so it keeps `/search` too.
  assert.deepEqual(
    redirectFrom(routes.find, pageEvent("/find", "?tags=%F0%9F%94%A5")),
    { status: 301, location: "/search?tag=%F0%9F%94%A5" },
  );
  // A text query and a tag filter are independent and both survive.
  assert.deepEqual(
    redirectFrom(routes.find, pageEvent("/find", "?search=zec&tags=video")),
    { status: 301, location: "/search?q=zec&tag=video" },
  );
});

test("/find refuses to hand the destination a malformed page number", () => {
  for (const bad of ["abc", "-3", "0", "2.5", ""]) {
    const { location } = redirectFrom(
      routes.find,
      pageEvent("/find", `?search=zec&page=${encodeURIComponent(bad)}`),
    );
    const params = new URLSearchParams(
      new URL(location, "https://x.test").search,
    );
    assert.equal(params.has("page"), false, bad);
    assert.equal(params.get("q"), "zec", bad);
  }
});

test("/find and mapToClassicUi are inverses, so the two cannot drift", () => {
  // Forward: the new UI's own switch maps /search?q= back to /find?search=.
  assert.equal(mapToClassicUi("/search", "?q=zcash"), "/find?search=zcash");
  // Back: this route maps it to the new shape again.
  assert.equal(
    redirectFrom(routes.find, pageEvent("/find", "?search=zcash")).location,
    "/search?q=zcash",
  );
});

test("a query value that needs escaping survives the /find hop intact", () => {
  const { location } = redirectFrom(
    routes.find,
    pageEvent("/find", `?search=${encodeURIComponent("a b&c=d")}`),
  );
  const params = new URLSearchParams(
    new URL(location, "https://x.test").search,
  );
  assert.equal(params.get("q"), "a b&c=d");
});

test("/begin and /begin/alt 301 to the sign-up view of a real login page", () => {
  for (const load of [routes.begin, routes.beginAlt]) {
    assert.deepEqual(redirectFrom(load, pageEvent("/begin")), {
      status: 301,
      location: "/login?view=signup",
    });
  }
});

test("no legacy route sends anyone to the inert /?login=true", () => {
  // `?login=true` was once used ~27 times in this app and NOTHING read it:
  // the homepage ignored the parameter and AuthButton starts closed, so the
  // visitor got a plain homepage with no prompt.  retired every call
  // site (tests/login-flow.test.mjs keeps it retired); these routes were the
  // first to use `/login`, a real page that opens UnifiedAuthModal.
  const anonymous = [routes.begin, routes.beginAlt].map(
    (handler) => redirectFrom(handler, pageEvent("/begin")).location,
  );

  for (const location of anonymous) {
    assert.doesNotMatch(location, /login=true/);
    assert.match(location, /^\/login(\?|$)/);
  }
});

test("a permanent redirect is never left in a browser's cache", () => {
  // Classic still owns /find, /begin and /edit/<id> and cannot serve their
  // new destinations. A bare 301 is remembered indefinitely by Chrome, so a
  // user who tried the new UI and went back via /classic-ui would keep being
  // redirected to a URL classic 404s — a break that outlives the cookie and
  // the rollback. `no-store` keeps the search-engine signal without that.
  const hops = [
    hopFrom(routes.find, pageEvent("/find", "?search=zcash")),
    hopFrom(routes.begin, pageEvent("/begin")),
    hopFrom(routes.beginAlt, pageEvent("/begin/alt")),
    hopFrom(routes.edit, pageEvent("/edit/42", "", { id: "42" })),
  ];

  for (const hop of hops) {
    assert.equal(hop.status, 301, hop.location);
    assert.equal(hop.cacheControl, "no-store", hop.location);
  }
});

test("/edit/<id> 301s to the query-string editor route", () => {
  assert.deepEqual(
    redirectFrom(routes.edit, pageEvent("/edit/42", "", { id: "42" })),
    { status: 301, location: "/edit?id=42" },
  );
});

test("/edit/<id> preserves ?lang= and re-encodes an awkward identifier", () => {
  const { location } = redirectFrom(
    routes.edit,
    pageEvent("/edit/a%20b", "?lang=fr", { id: "a b" }),
  );
  const url = new URL(location, "https://free2z.cash");
  assert.equal(url.pathname, "/edit");
  assert.equal(url.searchParams.get("id"), "a b");
  assert.equal(url.searchParams.get("lang"), "fr");
});

test("an explicit ?id= in the old URL loses to the path segment", () => {
  // /edit/real?id=spoof must not hand the editor `spoof`.
  const { location } = redirectFrom(
    routes.edit,
    pageEvent("/edit/real", "?id=spoof", { id: "real" }),
  );
  const url = new URL(location, "https://free2z.cash");
  assert.deepEqual(url.searchParams.getAll("id"), ["real"]);
});

// --------------------------------------------------------------------------
// Retired features — 410 Gone, never a soft-404 redirect
// --------------------------------------------------------------------------

test("retired classic shapes answer 410, not 404 and not a redirect", () => {
  const cases = [
    [routes.ai, pageEvent("/ai"), "errors.gone.ai"],
    [routes.aiPublic, pageEvent("/ai/public"), "errors.gone.ai"],
    // The shape /feeds/ai/recent.xml published into feed readers.
    [
      routes.aiConversation,
      pageEvent("/ai/conversation/3f9a1c2e-0000-4000-8000-abcdefabcdef"),
      "errors.gone.ai",
    ],
    [routes.tools, pageEvent("/tools/p2pe2e"), "errors.gone.tools"],
    [
      routes.toolsMeeting,
      pageEvent("/tools/p2pe2e/3f9a1c2e-0000-4000-8000-abcdefabcdef"),
      "errors.gone.tools",
    ],
    [
      routes.storytimeDisplay,
      pageEvent("/storytime/creator/shared-story"),
      "errors.gone.storytime",
    ],
    [
      routes.storytimeEdit,
      pageEvent("/storytime/edit/creator/shared-story"),
      "errors.gone.storytime",
    ],
  ];

  for (const [load, event, message] of cases) {
    assert.deepEqual(
      errorFrom(load, event),
      { status: 410, message },
      event.url.pathname,
    );
  }
});

test("a 410 is not left in a browser's cache either", () => {
  // 410 is heuristically cacheable, while the pinned predecessor image still
  // serves these classic paths. A remembered 410 would keep refusing one
  // after an operator performed the fenced rollback.
  for (const [route, pathname] of [
    ["ai", "/ai"],
    ["aiPublic", "/ai/public"],
    ["aiConversation", "/ai/conversation/abc"],
    ["tools", "/tools/p2pe2e"],
    ["toolsMeeting", "/tools/p2pe2e/abc"],
    ["storytimeDisplay", "/storytime/creator/shared-story"],
    ["storytimeEdit", "/storytime/edit/creator/shared-story"],
  ]) {
    const { headers, event } = recordingPageEvent(pathname);
    assert.equal(errorFrom(routes[route], event).status, 410, pathname);
    assert.equal(headers["cache-control"], "no-store", pathname);
  }
});

// --------------------------------------------------------------------------
// The namespace rule. A literal top-level route SHADOWS `[username]`, and a
// literal two-segment one shadows `[username]/[vanity]` — which resolves on
// the globally unique vanity ALONE. So every literal segment is a claim on a
// creator's namespace, and `FORBIDDEN_USERNAMES` does not back that claim: it
// is serializer validation on NEW registrations, not a database constraint,
// and it was extended long after signups began.
//
// This PR learned that the expensive way. It originally answered 410 for
// `/storytime` and everything under it on the strength of that list.
// `Storytime` is a REAL creator with three published zPages, so the rule
// would have replaced their profile AND their whole vanity namespace with a
// "permanently gone" signal. Those broad routes were deleted. Stage 4 adds
// only the non-colliding three/four-segment classic story shapes; the exact
// route and built-adapter tests below prove the creator root and vanity still
// reach the dynamic routes. The same review found `/ai/[...rest]` had the
// latent version of the bug: it swallowed every `/ai/<vanity>`. The one exact
// classic path `/ai/public` is deliberately retired below: `ai` is a reserved
// username, so no creator can own that canonical two-segment URL, while
// falling through globally resolves the live `public` vanity under an
// unrelated creator.
// --------------------------------------------------------------------------

// Every literal first path segment the app serves. Adding one is a namespace
// claim, so it belongs here only after this probe returns 404:
//
//     curl -o /dev/null -w '%{http_code}' https://free2z.cash/api/creator/<name>/
//
// Verified 2026-08-09 for the six this PR introduced: ai, begin, edit, events,
// find, profile -> 404. storytime -> 200, which is why it is absent.
//
// BE CLEAR ABOUT WHAT THIS IS. The list is a recorded ACKNOWLEDGEMENT, not a
// verification — CI cannot reach the production creator table, so nothing here
// re-runs the probe. It buys one thing: a new literal route cannot be added
// without someone editing this list, which is the moment to run the probe. It
// does NOT protect against a creator appearing later via an admin edit, an
// import, or a migration; `FORBIDDEN_USERNAMES` is the only forward-looking
// guard and it is serializer validation, not a constraint.
const CLAIMED_TOP_LEVEL_SEGMENTS = new Set([
  // Pre-existing, inherited from main.
  "article",
  "buy-2z",
  "checkout",
  "converse",
  "creators",
  "healthz",
  "live",
  "login",
  "og",
  "projects",
  "reset-password",
  "robots.txt",
  "search",
  "sitemap",
  "sitemap-v2.xml",
  "sitemap.xml",
  "trending",
  // Introduced by. Each one probed; see above.
  "ai",
  "begin",
  "edit",
  "events",
  "find",
  "profile",
  //. Probed 2026-08-30: GET /api/creator/tools/ -> 404, and `tools`
  // remains reserved in FORBIDDEN_USERNAMES.
  "tools",
  //. Probed 2026-08-22: GET /api/creator/csp-report/ -> 404, so no live
  // creator holds the name. It is also reserved in FORBIDDEN_USERNAMES
  // (py/free2z/dj/apps/g12f/usernames.py) and claimed by an exact-match nginx
  // location, so nobody can register it from here on.
  "csp-report",
  //. Probed 2026-08-25: GET /api/creator/tag/ -> 404, so no live creator
  // holds the name. It is also reserved in FORBIDDEN_USERNAMES
  // (py/free2z/dj/apps/g12f/usernames.py), listed in the crawler tier's
  // LITERAL_TWO_SEGMENT_PREFIXES, and claimed by a `^~ /tag/` nginx location,
  // so nobody can register it from here on. Note the nginx claim is on
  // `/tag/` WITH the trailing slash: `/tagalog` stays a registrable username
  //.
  "tag",
  //, the OIDC provider's pages. Probed 2026-09-27: GET
  // /api/creator/{oauth,account,developers}/ -> 404 each (control:
  // /api/creator/storytime/ -> 200). All three are reserved in
  // FORBIDDEN_USERNAMES and listed in the crawler tier's
  // LITERAL_TWO_SEGMENT_PREFIXES.
  "oauth",
  "account",
  "developers",
]);

// A literal directory is not itself a route. Storytime deliberately contains
// only three/four-segment leaves, which cannot collide with the live creator's
// one-segment profile or two-segment vanity URLs. Keep this exception named and
// pair it with the exact-shape assertions below; adding a root, two-segment or
// rest route would be the namespace incident this audit is designed to stop.
const NESTED_ONLY_NONCLAIMING_SEGMENTS = new Set(["storytime"]);

function literalTopLevelSegments() {
  const routesDir = path.join(UI_ROOT, "src/routes");
  const segments = new Set();

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // `(group)` directories are layout groups, not URL segments — descend.
      if (entry.name.startsWith("(") && entry.name.endsWith(")")) {
        walk(path.join(dir, entry.name));
        continue;
      }
      // `[param]` and `[...rest]` are the dynamic routes we must not shadow.
      if (entry.name.startsWith("[")) continue;
      segments.add(entry.name);
    }
  };

  walk(routesDir);
  return segments;
}

test("no route claims a top-level segment without the creator probe", () => {
  const actual = literalTopLevelSegments();
  const unclaimed = [...actual]
    .filter(
      (s) =>
        !CLAIMED_TOP_LEVEL_SEGMENTS.has(s) &&
        !NESTED_ONLY_NONCLAIMING_SEGMENTS.has(s),
    )
    .sort();

  assert.deepEqual(
    unclaimed,
    [],
    "A new literal top-level route shadows `[username]` for that name. Run\n" +
      "  curl -o /dev/null -w '%{http_code}' https://free2z.cash/api/creator/<name>/\n" +
      "and only add it to CLAIMED_TOP_LEVEL_SEGMENTS if that returns 404. If it\n" +
      "returns 200 the route would delete a live creator's profile — see the\n" +
      "/storytime incident in the comment above.",
  );

  const stale = [...CLAIMED_TOP_LEVEL_SEGMENTS]
    .filter((s) => !actual.has(s))
    .sort();
  assert.deepEqual(stale, [], "Claimed segments with no route; drop them.");

  const missingNestedOnly = [...NESTED_ONLY_NONCLAIMING_SEGMENTS]
    .filter((s) => !actual.has(s))
    .sort();
  assert.deepEqual(
    missingNestedOnly,
    [],
    "Nested-only segment exception has no route; drop the exception.",
  );
});

test("only non-colliding classic Storytime shapes retire", () => {
  // GET /api/creator/storytime/ -> 200, username "Storytime", 3 zPages, and
  // https://free2z.cash/storytime serves their profile today. A literal route
  // here takes that profile and every /storytime/<vanity> zPage with it.
  assert.equal(CLAIMED_TOP_LEVEL_SEGMENTS.has("storytime"), false);
  assert.equal(
    fs.existsSync(path.join(UI_ROOT, "src/routes/storytime/+page.server.ts")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(UI_ROOT, "src/routes/storytime/[...rest]")),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        UI_ROOT,
        "src/routes/storytime/[creator=storytimeLegacyCreator]/[slug]/+page.server.ts",
      ),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        UI_ROOT,
        "src/routes/storytime/edit/[creator]/[slug]/+page.server.ts",
      ),
    ),
    true,
  );

  for (const middle of ["zpage", "private", "dashboard"]) {
    assert.equal(
      storytimeLegacyCreatorMatch(middle),
      false,
      `/storytime/${middle}/<x> must fall through to the real creator route`,
    );
    assert.equal(storytimeLegacyCreatorMatch(middle.toUpperCase()), false);
  }
  for (const legacyCreator of ["fixtureowner", "zpage-owner", "privateer"]) {
    assert.equal(
      storytimeLegacyCreatorMatch(legacyCreator),
      true,
      "ordinary classic Storytime share owners must still retire",
    );
  }
});

test("the AI 410 is scoped to a shape no creator URL can take", () => {
  // `[username]/[vanity]` is two segments; the only three-segment creator
  // routes carry a literal middle of zpage/private/dashboard. So a
  // three-segment `/ai/conversation/<x>` cannot collide with anything, which
  // is why the broad `/ai/[...rest]` was replaced by it.
  assert.equal(
    fs.existsSync(path.join(UI_ROOT, "src/routes/ai/[...rest]")),
    false,
    "A catch-all under /ai swallows /ai/<vanity>; `public` is a live vanity.",
  );
  assert.equal(
    fs.existsSync(
      path.join(
        UI_ROOT,
        "src/routes/ai/conversation/[...rest]/+page.server.ts",
      ),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(UI_ROOT, "src/routes/ai/public/+page.server.ts")),
    true,
    "the exact retired gallery path must not fall through global vanity lookup",
  );
  for (const middle of ["zpage", "private", "dashboard"]) {
    assert.notEqual(
      "conversation",
      middle,
      "the literal middle segment must not be a real creator sub-route",
    );
  }
});

test("the 410 message keys resolve in every shipped catalog", () => {
  const localeDir = path.join(UI_ROOT, "src/lib/locales");
  const keys = Object.values(legacyRoutes.RETIRED_FEATURE_MESSAGES);
  assert.ok(keys.length > 0);

  for (const file of fs.readdirSync(localeDir)) {
    if (!file.endsWith(".json")) continue;
    const catalog = JSON.parse(
      fs.readFileSync(path.join(localeDir, file), "utf8"),
    );
    for (const key of [...keys, "errors.http.410.title"]) {
      const value = key
        .split(".")
        .reduce((node, part) => (node == null ? node : node[part]), catalog);
      assert.equal(
        typeof value === "string" && value.trim().length > 0,
        true,
        `${file} is missing ${key}`,
      );
    }
  }
});

test("+error.svelte knows 410, so it is not rendered as 'Unknown Error'", () => {
  const source = fs.readFileSync(
    path.join(UI_ROOT, "src/routes/+error.svelte"),
    "utf8",
  );
  assert.match(source, /^\s*410: \{/m);
  assert.match(source, /errors\.http\.410\.title/);
});

// --------------------------------------------------------------------------
// Session-derived redirects — never cacheable, never 301
// --------------------------------------------------------------------------

const OWN_DASHBOARD_ROUTES = [
  ["profile", "profile", "/profile"],
  ["profileKyc", "kyc", "/profile/kyc"],
  ["profileUploads", "media", "/profile/uploads"],
  ["events", "notifications", "/events"],
];

test("a signed-in visitor is sent to their own dashboard page", async () => {
  for (const [route, dashboardPage] of OWN_DASHBOARD_ROUTES) {
    const { event, requests } = serverEvent({
      session: "sess-abc",
      user: { username: "alice" },
    });
    const response = await routes[route](event);

    assert.equal(response.status, 302, route);
    assert.equal(
      response.headers.get("location"),
      `/alice/dashboard/${dashboardPage}`,
      route,
    );
    // The session must be forwarded, never dropped — otherwise every visitor
    // looks anonymous and the redirect is useless.
    assert.equal(requests.length, 1, route);
    assert.match(requests[0].init.headers.Cookie, /sessionid=sess-abc/);
  }
});

test("a session-derived redirect is never cacheable and never permanent", async () => {
  // Cloud CDN's key is host+protocol+path+query; the cookie is NOT in it. A
  // 301, or a 302 that a shared cache may store, hands one user's dashboard
  // URL to the next visitor.
  for (const [route] of OWN_DASHBOARD_ROUTES) {
    for (const scenario of [
      { session: "sess-abc", user: { username: "alice" } },
      { session: undefined },
    ]) {
      const { event } = serverEvent(scenario);
      const response = await routes[route](event);

      assert.equal(response.status, 302, route);
      assert.notEqual(response.status, 301, route);
      assert.equal(
        response.headers.get("cache-control"),
        "private, no-store",
        route,
      );
      assert.equal(response.headers.get("vary"), "Cookie", route);
    }
  }
});

test("an anonymous visitor is offered a real login page, not a 404", async () => {
  for (const [route, , pathname] of OWN_DASHBOARD_ROUTES) {
    const { event, requests } = serverEvent({ session: undefined, pathname });
    const response = await routes[route](event);

    assert.equal(response.status, 302, route);
    // `next` resumes the journey: /login -> /profile -> the dashboard. The
    // second hop is this same handler, now carrying a session, so no loop.
    assert.equal(
      response.headers.get("location"),
      `/login?next=${encodeURIComponent(pathname)}`,
      route,
    );
    // No cookie, no reason to ask the backend anything.
    assert.equal(requests.length, 0, route);
  }
});

// Every `next` sink shares ONE guard. These cases are asserted against the
// guard itself — which the login page consumes — rather than only against the
// caller, because that is where the codex review of  found the hole.
const HOSTILE_NEXT = [
  "https://evil.test/steal",
  "//evil.test/steal",
  "javascript:alert(1)",
  // Browsers normalise `\` to `/` while resolving a URL, so all three of
  // these reach https://evil.test/steal despite starting with a single `/`.
  "/\\evil.test/steal",
  "/%5Cevil.test/steal",
  "\\\\evil.test/steal",
  // Stripped by browsers before parsing, so a naive prefix test sees `/…`.
  "\n//evil.test/steal",
  "\t//evil.test/steal",
  " //evil.test/steal",
  // Header injection.
  "/ok\r\nLocation: https://evil.test",
  // A malformed escape is not a path worth guessing at.
  "/%zz",
];

test("the shared next guard rejects every off-site and smuggled path", async () => {
  const { getSafeNextPath } = await vite.ssrLoadModule("/src/lib/safe-next.ts");

  // It must NOT live under $lib/server: the login page's own +page.svelte
  // reads `next` for its post-login goto(), and client code cannot import a
  // server-only module. A guard the interactive path cannot reach is not a
  // guard.
  assert.equal(fs.existsSync(path.join(UI_ROOT, "src/lib/safe-next.ts")), true);
  const loginPage = fs.readFileSync(
    path.join(UI_ROOT, "src/routes/(auth)/login/+page.svelte"),
    "utf8",
  );
  assert.match(loginPage, /getSafeNextPath\(\$page\.url\.searchParams/);

  for (const hostile of HOSTILE_NEXT) {
    assert.equal(getSafeNextPath(hostile), null, JSON.stringify(hostile));
  }

  //...and still passes the ordinary same-site paths these routes produce.
  for (const safe of [
    "/profile",
    "/profile/kyc",
    "/profile/uploads",
    "/events",
    "/a%20b",
  ]) {
    assert.equal(getSafeNextPath(safe), safe, safe);
  }
  assert.equal(getSafeNextPath(""), null);
  assert.equal(getSafeNextPath(null), null);
});

test("the login destination cannot be turned into an open redirect", async () => {
  // `next` is built from our OWN route's pathname, never from user input, but
  // pin the caller too: it must go through the same guard.
  for (const hostile of HOSTILE_NEXT) {
    const { event } = serverEvent({ session: undefined, pathname: "/profile" });
    event.url = { pathname: hostile };
    const response = await routes.profile(event);

    assert.equal(
      response.headers.get("location"),
      "/login",
      JSON.stringify(hostile),
    );
  }
});

test("a rejected session lands on login rather than a broken dashboard URL", async () => {
  for (const [route, , pathname] of OWN_DASHBOARD_ROUTES) {
    for (const status of [401, 403]) {
      const { event } = serverEvent({ session: "expired", status, pathname });
      const response = await routes[route](event);

      assert.equal(response.status, 302, `${route} ${status}`);
      assert.equal(
        response.headers.get("location"),
        `/login?next=${encodeURIComponent(pathname)}`,
        `${route} ${status}`,
      );
    }
  }
});

test("a backend outage 503s instead of pretending the visitor is logged out", async () => {
  // Bouncing a signed-in user to /?login=true during a Django rollout,
  // overload or throttle would present a login modal that cannot succeed, and
  // would look like a session bug rather than an incident. It would also hide
  // the 5xx from nginx, which only ever sees the 302 we chose to return.
  //
  // A dropped connection is the EASY case; the realistic ones are upstream
  // status codes, which `requireAuthenticatedUser` folds into "logged out".
  // That is why these routes classify the response themselves.
  const outages = [
    { label: "connection refused", event: () => ({ throws: true }) },
    { label: "nginx 502", event: () => ({ status: 502 }) },
    { label: "django 503", event: () => ({ status: 503 }) },
    { label: "throttled 429", event: () => ({ status: 429 }) },
    { label: "unexpected 3xx", event: () => ({ status: 302 }) },
  ];

  for (const [route] of OWN_DASHBOARD_ROUTES) {
    for (const outage of outages) {
      const scenario = outage.event();
      const event = {
        url: new URL("https://free2z.cash/profile"),
        cookies: { get: () => "sess-abc" },
        fetch: async () => {
          if (scenario.throws) throw new TypeError("fetch failed");
          return new Response("upstream said no", { status: scenario.status });
        },
      };

      await assert.rejects(
        () => routes[route](event),
        (thrown) => thrown?.status === 503,
        `${route} / ${outage.label}`,
      );
    }
  }
});

test("a stalled backend is abandoned on a deadline, not held open", async () => {
  // Without this, a Django that accepts connections and then stalls leaves
  // one in-flight fetch per visitor for as long as the internal proxy allows
  // (200s) while the public one has already given up (60s) — sockets pile up
  // and take unrelated SSR routes with them.
  assert.equal(typeof legacyRoutes.IDENTITY_TIMEOUT_MS, "number");
  assert.ok(legacyRoutes.IDENTITY_TIMEOUT_MS > 0);
  assert.ok(
    legacyRoutes.IDENTITY_TIMEOUT_MS < 60_000,
    "the deadline must fire before the public proxy stops waiting",
  );

  let observedSignal = null;
  const event = {
    url: new URL("https://free2z.cash/profile"),
    cookies: { get: () => "sess-abc" },
    fetch: (_url, init) => {
      observedSignal = init?.signal;
      // Behave like a real stalled upstream: settle only when aborted.
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        // Fire the abort ourselves so the test does not wait 10s for the
        // real deadline; what is under test is that a signal exists and that
        // aborting it produces a 503 rather than a hang or a 500.
        queueMicrotask(() => init.signal.dispatchEvent(new Event("abort")));
      });
    },
  };

  await assert.rejects(
    () => routes.profile(event),
    (thrown) => thrown?.status === 503,
  );
  assert.ok(observedSignal, "the identity fetch must carry an abort signal");
});

test("the deadline still covers a response that stalls mid-body", async () => {
  // The likelier hang: nginx/Django send `200` headers and then stop. If the
  // timer were cleared as soon as `fetch` resolved, this case would be
  // unbounded — the one most able to accumulate abandoned sockets.
  let bodyAborted = false;
  const event = {
    url: new URL("https://free2z.cash/profile"),
    cookies: { get: () => "sess-abc" },
    fetch: async (_url, init) => ({
      status: 200,
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            bodyAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
          queueMicrotask(() => init.signal.dispatchEvent(new Event("abort")));
        }),
    }),
  };

  await assert.rejects(
    () => routes.profile(event),
    (thrown) => thrown?.status === 503,
  );
  assert.equal(
    bodyAborted,
    true,
    "the abort signal must still be live while the body is read",
  );
});

test("an identity response that is not JSON 503s rather than 500s", async () => {
  const event = {
    url: new URL("https://free2z.cash/profile"),
    cookies: { get: () => "sess-abc" },
    fetch: async () =>
      new Response("<html>a proxy error page</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  };

  await assert.rejects(
    () => routes.profile(event),
    (thrown) => thrown?.status === 503,
  );
});

test("a username needing escaping cannot break out of the dashboard path", async () => {
  const { event } = serverEvent({
    session: "sess-abc",
    user: { username: "a/../b" },
  });
  const response = await routes.profile(event);

  assert.equal(
    response.headers.get("location"),
    "/a%2F..%2Fb/dashboard/profile",
  );
});

test("a 200 identity with no username is a 503, not a silent logout", async () => {
  // Calling this "anonymous" would loop signed-in users through the login
  // page for the whole life of a serializer regression, and nginx would never
  // see the 5xx that triggers its degradation path.
  for (const user of [{ username: "" }, { username: null }, {}, null]) {
    const { event } = serverEvent({
      session: "sess-abc",
      user,
      pathname: "/events",
    });

    await assert.rejects(
      () => routes.events(event),
      (thrown) => thrown?.status === 503,
      JSON.stringify(user),
    );
  }
});
