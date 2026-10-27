import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

//  `/buy-2z` is the one "get 2Z" link, and SDK apps open it as
// `/buy-2z?client_id=<id>` instead of selling 2Z themselves. It lands on the
// billing page — which opens on Zcash — unless the caller asked for card,
// forwards a sanitised `client_id` as `app`, and drops every other parameter:
// an app (or anyone who can put a link in front of a user) must not be able
// to put a `return`, `next` or any other value on a free2z.cash page through
// it.
//
// With no method it writes NO `tab`: the billing page's own default is Zcash,
// and only an undecided page may fall back to Card when Zcash is unavailable
// (tests/browser/billing-zcash-first.spec.ts). `tab=zcash` here would be an
// explicit choice that pins the visitor to an unavailable Zcash tab.
//
// Negative controls: restore the pre- loader (origin/main) and
// `method=card` gets no tab, `app` is never forwarded and the login return
// keeps `return=`; forward every parameter and the drop tests fail; write
// `tab=zcash` by default and the no-method test fails.

const API = "https://api.free2z.test";
const AUTH_USER_URL = `${API}/api/auth/user/`;

let vite;
let load;
let billingActions;
const previousApiBase = process.env.PRIVATE_API_BASE_URL;
const previousTrusted = process.env.PRIVATE_BACKEND_TRUSTED_ORIGINS;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = API;
  process.env.PRIVATE_BACKEND_TRUSTED_ORIGINS = "https://free2z.test";
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ load } = await vite.ssrLoadModule("/src/routes/buy-2z/+page.server.ts"));
  ({ actions: billingActions } = await vite.ssrLoadModule(
    "/src/routes/[username]/dashboard/billing/+page.server.ts",
  ));
});

after(async () => {
  await vite?.close();
  if (previousApiBase === undefined) delete process.env.PRIVATE_API_BASE_URL;
  else process.env.PRIVATE_API_BASE_URL = previousApiBase;
  if (previousTrusted === undefined)
    delete process.env.PRIVATE_BACKEND_TRUSTED_ORIGINS;
  else process.env.PRIVATE_BACKEND_TRUSTED_ORIGINS = previousTrusted;
});

const signedIn = {
  get: (name) => (name === "sessionid" ? "sess-alice" : undefined),
};
const signedOut = { get: () => undefined };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function signedInFetch(input) {
  if (String(input) === AUTH_USER_URL) {
    return json({ id: 1, username: "alice" });
  }
  throw new Error(`unexpected fetch ${input}`);
}

/** The Location `/buy-2z<search>` answers with. */
async function locationFor(search, cookies = signedIn) {
  try {
    await load({
      cookies,
      fetch: signedInFetch,
      url: new URL(`https://free2z.test/buy-2z${search}`),
    });
  } catch (thrown) {
    if (thrown && thrown.status === 302) return thrown.location;
    throw thrown;
  }
  assert.fail("buy-2z must redirect");
}

function billing(location) {
  const url = new URL(location, "https://free2z.test");
  assert.equal(url.pathname, "/alice/dashboard/billing");
  return url.searchParams;
}

test("no method leaves the tab to the billing page, whose default is Zcash", async () => {
  assert.equal(await locationFor(""), "/alice/dashboard/billing");
  // An unknown method is no choice at all.
  assert.equal(await locationFor("?method=paypal"), "/alice/dashboard/billing");
});

test("zcash, stripe and its alias card are explicit choices", async () => {
  assert.equal(billing(await locationFor("?method=zcash")).get("tab"), "zcash");
  assert.equal(
    billing(await locationFor("?method=stripe")).get("tab"),
    "stripe",
  );
  assert.equal(billing(await locationFor("?method=card")).get("tab"), "stripe");
});

test("a usable client_id is forwarded as app", async () => {
  const params = billing(await locationFor("?client_id=aha-ios"));
  assert.deepEqual(Object.fromEntries(params), { app: "aha-ios" });
});

test("an unusable client_id is dropped", async () => {
  for (const bad of [
    "",
    "%20%20",
    "x".repeat(256),
    "a%01b",
    "a%0Ab",
    "a%7Fb",
  ]) {
    const params = billing(await locationFor(`?client_id=${bad}&method=zcash`));
    assert.equal(params.get("app"), null, bad);
    assert.equal(params.get("client_id"), null, bad);
  }
  // The longest usable id still gets through.
  assert.equal(
    billing(await locationFor(`?client_id=${"x".repeat(255)}`)).get("app"),
    "x".repeat(255),
  );
});

test("the checkout reference still passes, by pattern only", async () => {
  assert.equal(
    billing(await locationFor("?method=zcash&ref=abc_123")).get("checkoutRef"),
    "abc_123",
  );
  assert.equal(
    billing(await locationFor("?method=zcash&ref=%3Cscript%3E")).get(
      "checkoutRef",
    ),
    null,
  );
});

test("every other parameter is dropped: no return, no next", async () => {
  const location = await locationFor(
    "?client_id=aha&return=https%3A%2F%2Fevil.example&next=%2F%2Fevil.example" +
      "&redirect_uri=https%3A%2F%2Fevil.example&tab=stripe&app=spoof",
  );
  assert.doesNotMatch(location, /return|next|redirect|evil|spoof/i);
  // `tab` comes from `method` only and `app` from `client_id` only; a caller
  // cannot set either directly on the billing page through this link.
  assert.deepEqual(Object.fromEntries(billing(location)), { app: "aha" });
});

test("signed out: login returns to /buy-2z with the sanitised parameters only", async () => {
  assert.equal(await locationFor("", signedOut), "/login?next=%2Fbuy-2z");
  assert.equal(
    await locationFor("?return=https%3A%2F%2Fevil.example", signedOut),
    "/login?next=%2Fbuy-2z",
  );
  const location = await locationFor(
    "?client_id=aha&method=card&return=https%3A%2F%2Fevil.example&next=%2F%2Fevil.example",
    signedOut,
  );
  const url = new URL(location, "https://free2z.test");
  assert.equal(url.pathname, "/login");
  const next = new URL(url.searchParams.get("next"), "https://free2z.test");
  assert.equal(next.pathname, "/buy-2z");
  assert.deepEqual(Object.fromEntries(next.searchParams), {
    method: "stripe",
    client_id: "aha",
  });
  assert.doesNotMatch(location, /return|evil/i);
});

// --- the card round trip keeps the app line ---------------------------------

/** The `currentPath` the checkout action sends to Django for these fields. */
async function checkoutReturnPath(extra) {
  const seen = [];
  const fields = new FormData();
  fields.set("quantity", "1000");
  fields.set("expected_actor_id", "1");
  for (const [name, value] of Object.entries(extra)) fields.set(name, value);
  await billingActions.checkout({
    params: { username: "alice" },
    cookies: {
      get: (name) =>
        name === "sessionid"
          ? "sess-alice"
          : name === "csrftoken"
            ? "csrf"
            : undefined,
      set: () => {},
    },
    fetch: async (input, init) => {
      const url = String(input);
      seen.push({ url, init });
      if (url === AUTH_USER_URL) return json({ id: 1, username: "alice" });
      // The session answer itself does not matter here; only what was sent.
      return json({}, 503);
    },
    url: new URL("https://free2z.test/alice/dashboard/billing?/checkout"),
    request: new Request("https://free2z.test/alice/dashboard/billing", {
      method: "POST",
      headers: { origin: "https://free2z.test" },
      body: fields,
    }),
  });
  const create = seen.find(({ url }) =>
    url.includes("/api/stripe/create-checkout-session/"),
  );
  assert.ok(create, "the checkout reached the backend");
  return new URL(JSON.parse(create.init.body).currentPath, "https://x.test");
}

test("a card checkout returns to the Card tab, with the app line when there is one", async () => {
  const plain = await checkoutReturnPath({});
  assert.equal(plain.pathname, "/alice/dashboard/billing");
  assert.deepEqual(Object.fromEntries(plain.searchParams), { tab: "stripe" });

  const fromApp = await checkoutReturnPath({ app: "aha-ios" });
  assert.deepEqual(Object.fromEntries(fromApp.searchParams), {
    tab: "stripe",
    app: "aha-ios",
  });

  // An unusable app is dropped, never a reason to refuse the checkout.
  for (const bad of ["x".repeat(256), "a\u0001b", "  "]) {
    const path = await checkoutReturnPath({ app: bad });
    assert.deepEqual(Object.fromEntries(path.searchParams), { tab: "stripe" });
  }
});
