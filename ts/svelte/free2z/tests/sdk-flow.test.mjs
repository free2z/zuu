import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

// Which pages an SDK app opens ($lib/sdk-flow). The answer hides the site
// navigation (which reaches Credits) and switches the sign-in sheet to its
// commerce-free, first-party behaviour, so a wrong "no" is a store-policy
// leak and a wrong "yes" strips navigation from ordinary pages. The Manage
// page is SDK-facing only WITH ?client_id=: the plain Connected apps list is
// an ordinary account page, purchase link and all.

let vite;
let isSdkFlow;
let manageAppFocus;
let usableClientId;

before(async () => {
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ isSdkFlow, manageAppFocus, usableClientId } = await vite.ssrLoadModule(
    "/src/lib/sdk-flow.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const at = (path) => new URL(path, "https://free2z.test");
const login = (next) => at(`/login?next=${encodeURIComponent(next)}`);

test("SDK-facing pages", () => {
  for (const path of [
    "/oauth/authorize?client_id=aha",
    "/oauth/reauth-callback",
    "/account/apps?client_id=aha",
    "/account/apps?client_id=",
    "/account/apps/?client_id=aha",
    "/account/delete",
    // "Keep my account?" -- reached from an SDK app's sign-in too.
    "/account/keep",
  ]) {
    assert.equal(isSdkFlow(at(path)), true, path);
  }
});

test("the Manage page is SDK-facing only with ?client_id=", () => {
  assert.equal(isSdkFlow(at("/account/apps")), false);
  assert.equal(isSdkFlow(at("/account/apps?edit_limit=x")), false);
  assert.equal(isSdkFlow(login("/account/apps")), false);
  assert.equal(isSdkFlow(login("/account/apps?client_id=aha")), true);
});

test("/login is SDK-facing exactly when its safe next is", () => {
  assert.equal(isSdkFlow(login("/oauth/authorize?client_id=aha")), true);
  assert.equal(isSdkFlow(login("/account/delete")), true);
  assert.equal(isSdkFlow(at("/login")), false);
  assert.equal(isSdkFlow(login("/fixtureowner/dashboard/billing")), false);
  // An unsafe next is dropped by the login page, so it cannot make /login
  // SDK-facing either.
  assert.equal(isSdkFlow(login("//evil.example/oauth/authorize")), false);
  assert.equal(isSdkFlow(login("/\\evil.example/oauth/authorize")), false);
});

test("ordinary pages are not", () => {
  for (const path of [
    "/",
    "/buy-2z",
    //the billing deep link an app may open is an ordinary page, so
    // it keeps its navigation; the SDK-facing pages never link to it.
    "/buy-2z?client_id=aha",
    "/buy-2z?client_id=aha&method=card",
    "/fixtureowner/dashboard/billing?tab=zcash&app=aha",
    "/account",
    "/oauthx",
    "/fixtureowner/dashboard/billing",
  ]) {
    assert.equal(isSdkFlow(at(path)), false, path);
  }
});

test("manageAppFocus: no parameter, a usable id, an unusable one", () => {
  assert.equal(manageAppFocus(at("/account/apps")), null);
  assert.deepEqual(manageAppFocus(at("/account/apps?client_id=aha")), {
    clientId: "aha",
  });
  assert.deepEqual(manageAppFocus(at("/account/apps?client_id=")), {
    clientId: null,
  });
  assert.deepEqual(
    manageAppFocus(at(`/account/apps?client_id=${"x".repeat(300)}`)),
    { clientId: null },
  );
  assert.deepEqual(manageAppFocus(at("/account/apps?client_id=a%01b")), {
    clientId: null,
  });
});

test("usableClientId: the one rule for an app id carried in a URL (#2705)", () => {
  assert.equal(usableClientId("aha"), "aha");
  assert.equal(usableClientId("  aha  "), "aha");
  assert.equal(usableClientId("x".repeat(255)), "x".repeat(255));
  for (const bad of [
    null,
    undefined,
    "",
    "   ",
    "x".repeat(256),
    "a\u0001b",
    "a\nb",
    "a\u007fb",
  ]) {
    assert.equal(usableClientId(bad), null, JSON.stringify(bad));
  }
});
