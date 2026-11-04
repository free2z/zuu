import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

//  P0. "Sign in with X" was broken for 100% of new-UI users for two
// months. `UnifiedAuthModal.handleTwitterLogin` assembled the X authorize URL
// itself from `import.meta.env.VITE_TWITTER_CLIENT_ID`, a BUILD-TIME Vite
// variable that was set in no Dockerfile, no Cloud Build substitution and no
// k8s manifest — so it was `undefined` in every image ever shipped, the guard
// fired on every click, and `/api/twitter/start` returned 200 to all 20+ of
// one real user's rage-clicks. 137 accounts have an unusable password and can
// sign in no other way.
//
// The server owns the authorize URL now. Two halves are pinned here:
//
//   1. BEHAVIOUR — `fetchTwitterAuthorizeUrl` returns exactly what the server
//      supplied, and refuses to hand back anything that is not an absolute
//      https URL on an X host, at X's consent path (the modal assigns the result to
//      `window.location.href`, which is an open redirect if unchecked).
//   2. SOURCE — the modal contains no `import.meta.env` read and builds no
//      URL of its own. A behavioural test alone cannot catch a REGRESSION of
//      the original defect, because the original defect was a gate that lived
//      in the component, not in the helper.

const UI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODULE = "/src/lib/twitter-authorize.ts";
const MODAL = path.join(
  UI_ROOT,
  "src/lib/components/auth/UnifiedAuthModal.svelte",
);

let server;
let assertAuthorizeUrl;
let fetchTwitterAuthorizeUrl;
let TwitterAuthorizeError;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });
  ({ assertAuthorizeUrl, fetchTwitterAuthorizeUrl, TwitterAuthorizeError } =
    await server.ssrLoadModule(MODULE));
});

after(async () => {
  await server?.close();
});

/** A `fetch` that answers `/api/twitter/start` and records the call. */
function stubFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

const SERVER_URL =
  "https://twitter.com/i/oauth2/authorize?response_type=code" +
  "&client_id=server-side-client-id" +
  "&redirect_uri=https%3A%2F%2Ffree2z.cash%2Fapi%2Ftwitter%2Fcallback" +
  "&scope=users.read+follows.read+tweet.read&state=abc" +
  "&code_challenge=xyz&code_challenge_method=S256&intent=authenticate";

test("it navigates to the authorize URL the SERVER supplied, verbatim", async () => {
  const fetchImpl = stubFetch({
    state: "abc",
    code_challenge: "xyz",
    authorize_url: SERVER_URL,
  });

  const url = await fetchTwitterAuthorizeUrl(fetchImpl);

  assert.equal(url, SERVER_URL);
  // The client id is the server's, and appears nowhere in the bundle.
  assert.ok(url.includes("client_id=server-side-client-id"));
});

test("it asks /api/twitter/start with the cookie that binds the handshake", async () => {
  const fetchImpl = stubFetch({ authorize_url: SERVER_URL });

  await fetchTwitterAuthorizeUrl(fetchImpl);

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "/api/twitter/start");
  assert.equal(fetchImpl.calls[0].init.method, "GET");
  // The `/start` response SETS the signed handshake cookie the callback
  // checks `state` against. Without this the flow dies at the callback.
  assert.equal(fetchImpl.calls[0].init.credentials, "include");
});

test("a server that answers 503 (unconfigured) is a start failure, not a URL", async () => {
  const fetchImpl = stubFetch(
    { detail: "Sign-in with X is not configured." },
    { ok: false, status: 503 },
  );

  await assert.rejects(
    () => fetchTwitterAuthorizeUrl(fetchImpl),
    (error) => {
      assert.ok(error instanceof TwitterAuthorizeError);
      assert.equal(error.reason, "start_failed");
      return true;
    },
  );
});

test("a response with no authorize_url fails loudly instead of navigating", async () => {
  // Exactly the shape the endpoint returned BEFORE this fix. If a stale
  // backend is live, the client must say so rather than go nowhere.
  const fetchImpl = stubFetch({ state: "abc", code_challenge: "xyz" });

  await assert.rejects(
    () => fetchTwitterAuthorizeUrl(fetchImpl),
    (error) => {
      assert.equal(error.reason, "bad_authorize_url");
      return true;
    },
  );
});

test("both X origins are accepted and normalized", () => {
  for (const origin of ["https://x.com", "https://twitter.com"]) {
    const url = `${origin}/i/oauth2/authorize?client_id=k`;
    assert.equal(assertAuthorizeUrl(url), url);
  }
});

test("a blob: URL really does inherit an X origin (why origin is not checked)", () => {
  // The premise of, pinned so the hostile list below stays meaningful:
  // if a runtime ever stops inheriting, this fails and says why.
  assert.equal(new URL("blob:https://x.com/0d6f1a2b").origin, "https://x.com");
});

test("the default https port is normalized and still accepted", () => {
  assert.equal(
    assertAuthorizeUrl("https://x.com:443/i/oauth2/authorize?client_id=k"),
    "https://x.com/i/oauth2/authorize?client_id=k",
  );
});

test("it refuses to navigate anywhere that is not X", () => {
  const hostile = [
    // A relative path must NOT be resolved against the current page.
    "/i/oauth2/authorize?client_id=k",
    "https://twitter.com.evil.example/i/oauth2/authorize",
    "https://evil.example/i/oauth2/authorize",
    "http://twitter.com/i/oauth2/authorize", // downgraded scheme
    "javascript:alert(1)", // eslint-disable-line no-script-url
    //a blob:/filesystem: URL's ORIGIN is its inner URL's origin, so
    // an origin allowlist accepted these. The scheme is what gets navigated.
    "blob:https://x.com/0d6f1a2b",
    "blob:https://twitter.com/x",
    "filesystem:https://x.com/temporary/a",
    // Same host, wrong port / path / carried credentials.
    "https://x.com:8443/i/oauth2/authorize",
    "https://x.com/",
    "https://x.com/i/oauth2/authorize/../../evil",
    "https://twitter.com/home?next=/i/oauth2/authorize",
    "https://user:pw@x.com/i/oauth2/authorize",
    "https://user@twitter.com/i/oauth2/authorize",
    // Host confusions that resolve somewhere else.
    "https://x.com@evil.example/i/oauth2/authorize",
    "https://x.com.evil.example/i/oauth2/authorize",
    "",
    null,
    undefined,
    42,
  ];
  for (const value of hostile) {
    assert.throws(
      () => assertAuthorizeUrl(value),
      (error) => {
        assert.ok(error instanceof TwitterAuthorizeError);
        assert.equal(error.reason, "bad_authorize_url");
        return true;
      },
      `expected refusal for ${JSON.stringify(value)}`,
    );
  }
});

test("the modal reads no build-time variable and builds no authorize URL", () => {
  const source = fs.readFileSync(MODAL, "utf8");

  // The defect itself, by name.
  assert.ok(
    !source.includes("VITE_TWITTER_CLIENT_ID"),
    "the X client id must never come from the build again",
  );
  // And the whole class of it: nothing in this component may gate a feature
  // on a variable that is baked at image-build time.
  assert.ok(
    !/import\.meta\.env/.test(source),
    "no import.meta.env read belongs in the auth modal",
  );
  // No hand-assembled consent URL, and no hardcoded callback host.
  assert.ok(
    !source.includes("i/oauth2/authorize"),
    "the authorize URL is the server's to build",
  );
  assert.ok(
    !/free2z\.cash\/api\/twitter\/callback/.test(source),
    "the callback URI is derived server-side from CANONICAL_ORIGIN",
  );
  // It goes through the audited helper.
  assert.ok(
    /fetchTwitterAuthorizeUrl\s*\(/.test(source),
    "handleTwitterLogin must use the server-supplied URL helper",
  );
});

test("the dead 'not configured' string is gone from every locale", () => {
  const dir = path.join(UI_ROOT, "src/lib/locales");
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    assert.ok(
      !text.includes("twitterNotConfigured"),
      `${name} still carries the message users wrongly saw for two months`,
    );
  }
});

test("no VITE_ variable survives anywhere in the app source", () => {
  // A `VITE_`-prefixed variable is only ever read at build time, and this
  // repo sets none of them in any Dockerfile, Cloud Build substitution or k8s
  // manifest. SvelteKit's own `$env/dynamic/public` PUBLIC_ variables are the
  // supported mechanism and are unaffected by this assertion.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|js|svelte)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (/import\.meta\.env\.VITE_/.test(text)) offenders.push(full);
      }
    }
  };
  walk(path.join(UI_ROOT, "src"));
  assert.deepEqual(offenders, []);
});
