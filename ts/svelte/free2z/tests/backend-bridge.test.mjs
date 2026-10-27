import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BackendBridgeError,
  assertTrustedRequestOrigin,
  buildBackendMutationRequest,
  resolveBackendApiUrl,
} from "../src/lib/server/backend-policy.ts";

const API_BASE = "http://localhost:8080";
const PUBLIC_ORIGIN = "https://free2z.cash";
const NEW_UI_ORIGIN = "https://new.free2z.cash";
const TRUSTED_ORIGINS = `${PUBLIC_ORIGIN},https://test.free2z.cash,${NEW_UI_ORIGIN},https://new.free2z.com,https://new.free2give.xyz`;
const billingSource = readFileSync(
  new URL(
    "../src/routes/[username]/dashboard/billing/+page.server.ts",
    import.meta.url,
  ),
  "utf8",
);

const productionSettingsSource = readFileSync(
  new URL("../../../../py/free2z/dj/free2z/prod_settings.py", import.meta.url),
  "utf8",
);

const dockerfileSource = readFileSync(
  new URL("../../../../build/free2z/web.Dockerfile", import.meta.url),
  "utf8",
);

function request(overrides = {}) {
  return buildBackendMutationRequest({
    apiBase: API_BASE,
    configuredOrigins: TRUSTED_ORIGINS,
    requestDestinationOrigin: PUBLIC_ORIGIN,
    initiatingOrigin: PUBLIC_ORIGIN,
    path: "/api/tuzis/subscribe/example_creator",
    method: "PATCH",
    sessionId: "session-secret",
    csrfToken: "csrf-secret",
    json: { max_price: "100" },
    ...overrides,
  });
}

test("the production public-origin/internal-localhost topology is explicit", () => {
  const built = request();
  assert.equal(
    built.target,
    "http://localhost:8080/api/tuzis/subscribe/example_creator",
  );
  assert.equal(built.init.headers.get("origin"), PUBLIC_ORIGIN);
  assert.equal(built.init.headers.get("x-csrftoken"), "csrf-secret");
  assert.equal(
    built.init.headers.get("cookie"),
    "sessionid=session-secret; csrftoken=csrf-secret",
  );
  assert.equal(built.init.redirect, "manual");
  assert.equal(built.init.body, '{"max_price":"100"}');
});

test("POST, PATCH, PUT, and DELETE all use the same hardened request", () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const built = request({ method, json: undefined });
    assert.equal(built.init.method, method);
    assert.equal(built.init.redirect, "manual");
    assert.equal(built.init.headers.get("origin"), PUBLIC_ORIGIN);
    assert.equal(built.init.headers.get("x-csrftoken"), "csrf-secret");
  }
});

test("missing session and CSRF credentials fail before a request is built", () => {
  for (const [field, code] of [
    ["sessionId", "missing-session"],
    ["csrfToken", "missing-csrf"],
  ]) {
    assert.throws(
      () => request({ [field]: undefined }),
      (error) => error instanceof BackendBridgeError && error.code === code,
    );
  }
});

test("only exact configured public origins are trusted", () => {
  assert.equal(
    assertTrustedRequestOrigin(
      PUBLIC_ORIGIN,
      PUBLIC_ORIGIN,
      TRUSTED_ORIGINS,
      API_BASE,
    ),
    PUBLIC_ORIGIN,
  );
  assert.equal(
    assertTrustedRequestOrigin(
      NEW_UI_ORIGIN,
      NEW_UI_ORIGIN,
      TRUSTED_ORIGINS,
      API_BASE,
    ),
    NEW_UI_ORIGIN,
  );
  for (const origin of [
    "https://evil.example",
    "https://free2z.cash.evil.example",
    "https://sub.free2z.cash",
    "null",
  ]) {
    assert.throws(
      () =>
        request({ requestDestinationOrigin: origin, initiatingOrigin: origin }),
      (error) =>
        error instanceof BackendBridgeError &&
        error.code === "untrusted-origin",
      origin,
    );
  }
});

test("the initiating Origin must match the public request destination", () => {
  for (const initiatingOrigin of ["", "null", "https://evil.example"]) {
    assert.throws(
      () => request({ initiatingOrigin }),
      (error) =>
        error instanceof BackendBridgeError &&
        error.code === "untrusted-origin",
      initiatingOrigin || "missing Origin",
    );
  }
});

test("unconfigured development permits only loopback-to-loopback origins", () => {
  assert.equal(
    assertTrustedRequestOrigin(
      "http://localhost:5173",
      "http://localhost:5173",
      "",
      API_BASE,
    ),
    "http://localhost:5173",
  );
  assert.throws(
    () =>
      assertTrustedRequestOrigin(
        "https://free2z.cash",
        "https://free2z.cash",
        "",
        API_BASE,
      ),
    (error) =>
      error instanceof BackendBridgeError && error.code === "untrusted-origin",
  );
});

test("caller-controlled destinations cannot receive credentials", () => {
  for (const path of [
    "https://evil.example/steal",
    "//evil.example/steal",
    "/not-api/steal",
    "/api/../steal",
    "/api/%2e%2e/steal",
  ]) {
    assert.throws(
      () => request({ path }),
      (error) =>
        error instanceof BackendBridgeError &&
        error.code === "invalid-destination",
      path,
    );
  }

  assert.equal(
    resolveBackendApiUrl(API_BASE, "/api/zpage/safe-name/"),
    "http://localhost:8080/api/zpage/safe-name/",
  );
});

test("redirect following is disabled so credentials cannot cross a redirect", () => {
  const built = request({ path: "/api/redirect-to-attacker" });
  assert.equal(built.init.redirect, "manual");
});

// Walk src/routes and return every server module, so the inventory below is
// discovered rather than hand-maintained. A hard-coded list silently keeps
// passing after the file it names is deleted (which is how the orphaned
// /edit write proxy survived three weeks past its last caller) and, worse,
// says nothing at all about a NEW server-side write path someone adds later.
function serverRouteModules(dir = new URL("../src/routes/", import.meta.url)) {
  const found = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...serverRouteModules(new URL(`${entry.name}/`, dir)));
      continue;
    }

    // Every kind of server module SvelteKit will load, not just the shapes
    // that exist today: +layout.server runs on every request under its
    // subtree (the least visible place to smuggle a mutation), and.js is
    // as valid as.ts here even though the tree is currently all TypeScript.
    if (/^\+(server|page\.server|layout\.server)\.(ts|js)$/.test(entry.name)) {
      const url = new URL(entry.name, dir);
      found.push({
        path: fileURLToPath(url).split("/src/routes/").at(-1),
        source: readFileSync(url, "utf8"),
      });
    }
  }

  return found.sort((a, b) => a.path.localeCompare(b.path));
}

test("every server-side mutation route uses the shared bridge", () => {
  const modules = serverRouteModules();
  assert.ok(modules.length > 1, "no server routes were discovered");

  // A module mutates if it exposes a write handler, exposes form actions, or
  // sets a fetch `method` of its own.
  //
  // The method probe is an ALLOWLIST, not a denylist: anything other than a
  // literal GET/HEAD/OPTIONS counts as a mutation. Enumerating the verbs to
  // catch (`method: "POST"`) is what lets `'post'`, a ternary, a variable or
  // the `{ method }` shorthand walk straight past — so instead only the
  // three provably-safe literals are excused and everything else, including
  // shapes nobody has thought of yet, lands in the inventory below and has
  // to be justified there.
  const writeHandler =
    /export (?:const|async function|function) (?:POST|PUT|PATCH|DELETE)\b/;
  // SvelteKit accepts a re-exported handler just as happily as a declared
  // one, and this repo already ships that form (`export { GET } from...`
  // in sitemap-v2.xml/+server.ts), so the write verbs need it too.
  const reExportedHandler =
    /export\s*\{[^}]*\b(?:POST|PUT|PATCH|DELETE)\b[^}]*\}/;
  const formActions = /export const actions\b/;
  // NB: the `\s*` lives INSIDE the lookahead on purpose. Outside it, `\s*`
  // backtracks to empty and the lookahead then fails against the space it
  // gave up — so even `method: "GET"` matched.
  const nonReadMethod = /method:(?!\s*["'`](?:GET|HEAD|OPTIONS)["'`]\s*[,}])/i;
  const shorthandMethod = /[{,]\s*method\s*[,}]/;

  const allMutating = modules.filter(
    ({ source }) =>
      writeHandler.test(source) ||
      reExportedHandler.test(source) ||
      formActions.test(source) ||
      nonReadMethod.test(source) ||
      shorthandMethod.test(source),
  );

  // Routes that accept a write from the BROWSER but never issue one to
  // Django. The bridge exists to stop a credentialed outbound request from
  // reaching an attacker-chosen destination; a handler that makes no outbound
  // request at all has no credentials to leak and nothing to bridge, and
  // requiring an `authenticatedBackendMutation` call it does not need would
  // mean inventing a backend call to satisfy a test.
  //
  // The exemption is NOT a free pass: each entry is proved inert below.
  // Adding a name here without that proof is the failure mode this comment
  // exists to prevent.
  const NON_BACKEND_WRITE_ROUTES = new Set([
    //the CSP report-uri sink. POSTed by the USER AGENT, unauthenticated
    // by construction (a violation report carries no credential we could
    // check), and its entire body of work is `console.log`.
    "csp-report/+server.ts",
  ]);

  for (const path of NON_BACKEND_WRITE_ROUTES) {
    const module = allMutating.find((entry) => entry.path === path);
    assert.ok(
      module,
      `${path} is exempted from the bridge inventory but is no longer a ` +
        `write route — drop it from NON_BACKEND_WRITE_ROUTES`,
    );
    // The whole basis of the exemption: it talks to nothing. If one of these
    // ever grows a fetch, it rejoins the inventory rather than keeping a
    // grandfathered pass.
    assert.doesNotMatch(
      module.source,
      /\bfetch\s*\(/,
      `${path} is exempted from the bridge but issues a fetch`,
    );
    assert.doesNotMatch(
      module.source,
      /buildBackendHeaders|X-CSRFToken|csrftoken=|authenticatedBackendMutation/,
      `${path} is exempted from the bridge but handles credentials`,
    );
  }

  const mutating = allMutating.filter(
    ({ path }) => !NON_BACKEND_WRITE_ROUTES.has(path),
  );

  assert.deepEqual(
    mutating.map(({ path }) => path),
    ["[username]/dashboard/billing/+page.server.ts"],
    "server-side write surface changed — route it through " +
      "authenticatedBackendMutation and update this inventory",
  );

  for (const { path, source } of mutating) {
    // Per-mutation, not per-module. "Contains at least one bridge call"
    // blesses the whole file, so a fourth billing action could raise a raw
    // credentialed fetch alongside the three compliant ones and still pass.
    // Every non-read `method:` in the module must be accounted for by a
    // bridge call — the bridge is the only thing that sets one here.
    const writes = source.match(new RegExp(nonReadMethod, "gi")) ?? [];
    const bridged = source.match(/authenticatedBackendMutation\(\{/g) ?? [];

    assert.ok(bridged.length > 0, `${path} mutates without the shared bridge`);
    assert.equal(
      writes.length,
      bridged.length,
      `${path} issues ${writes.length} non-read request(s) but only ` +
        `${bridged.length} go through authenticatedBackendMutation`,
    );
    // Credentials are the bridge's job; a route assembling them by hand has
    // opted out of the origin allowlist and the redirect pinning.
    assert.doesNotMatch(source, /buildBackendHeaders|X-CSRFToken|csrftoken=/);
  }

  assert.equal(
    billingSource.match(/authenticatedBackendMutation\(\{/g)?.length,
    3,
    "billing POST/PATCH/DELETE",
  );
});

test("the production runtime derives each public origin from proxy headers", () => {
  assert.doesNotMatch(dockerfileSource, /^ENV ORIGIN=/m);
  assert.match(dockerfileSource, /^ENV PORT=3000$/m);
});
