// The OIDC consent screen's decisions (; zuu docs/free2z/sdk/spec/oidc.md §5).
//
// The rule these pin: an approval that grants ai:invoke ALWAYS carries an
// explicit spend cap — a number, or null that the user chose — and the
// builder throws rather than send a body without one. The browser specs
// (tests/browser/oauth-consent.spec.ts) prove the page wires it; these prove
// what it computes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTHORIZATION_PARAMETERS,
  LOGIN_TICKET,
  MissingCapDecisionError,
  REAUTH_MARKER,
  authorizationParams,
  buildConsentDecision,
  isCapRaise,
  isNavigableRedirect,
  markupPercent,
  SPEND_CAP_HINT,
  SPEND_PERIOD_HINT,
  parseCapAmount,
  raiseBaseline,
  reauthReturnPath,
  resolveCap,
  withLoginTicket,
} from "../src/lib/oidc/consent.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..", "..");

const REQUEST = { client_id: "abc", scope: "openid ai:invoke", state: "s" };
const PRE = { spend_cap_2z: 1000, cap_period: "month" };

test("approving ai:invoke without a resolved cap throws instead of omitting the key", () => {
  assert.throws(
    () =>
      buildConsentDecision({
        requestId: "r",
        authorizationRequest: REQUEST,
        allow: true,
        capRequired: true,
      }),
    MissingCapDecisionError,
  );
  // A malformed cap is not a decision either.
  for (const cap of [
    { spend_cap_2z: -1, cap_period: "month" },
    { spend_cap_2z: 1.5, cap_period: "month" },
    { spend_cap_2z: 10, cap_period: "fortnight" },
  ]) {
    assert.throws(
      () =>
        buildConsentDecision({
          requestId: "r",
          authorizationRequest: REQUEST,
          allow: true,
          capRequired: true,
          cap,
        }),
      MissingCapDecisionError,
    );
  }
});

test("an approval carries the cap explicitly, including null for no cap", () => {
  const withCap = buildConsentDecision({
    requestId: "r",
    authorizationRequest: REQUEST,
    allow: true,
    capRequired: true,
    cap: PRE,
  });
  assert.deepEqual(withCap, {
    request_id: "r",
    authorization_request: REQUEST,
    allow: true,
    spend_cap_2z: 1000,
    cap_period: "month",
  });

  const noCap = buildConsentDecision({
    requestId: "r",
    authorizationRequest: REQUEST,
    allow: true,
    capRequired: true,
    cap: { spend_cap_2z: null, cap_period: "month" },
  });
  // Present and null: the backend reads an ABSENT key as "keep the old cap"
  // (re-consent) or refuses it (first consent). Null is the explicit choice.
  assert.equal(Object.hasOwn(noCap, "spend_cap_2z"), true);
  assert.equal(noCap.spend_cap_2z, null);
});

test("a denial and a consent without ai:invoke carry no cap", () => {
  const denied = buildConsentDecision({
    requestId: "r",
    authorizationRequest: REQUEST,
    allow: false,
    capRequired: true,
  });
  assert.deepEqual(denied, {
    request_id: "r",
    authorization_request: REQUEST,
    allow: false,
  });
  const plain = buildConsentDecision({
    requestId: "r",
    authorizationRequest: REQUEST,
    allow: true,
    capRequired: false,
    cap: PRE,
  });
  assert.equal(Object.hasOwn(plain, "spend_cap_2z"), false);
});

test("the pre-selection resolves to the backend's cap exactly", () => {
  assert.deepEqual(resolveCap({ kind: "preselected" }, PRE, false), {
    ok: true,
    cap: PRE,
  });
});

test("choosing no cap needs a second, deliberate confirmation", () => {
  assert.deepEqual(resolveCap({ kind: "none" }, PRE, false), {
    ok: false,
    reason: "confirmNoCap",
  });
  assert.deepEqual(resolveCap({ kind: "none" }, PRE, true), {
    ok: true,
    cap: { spend_cap_2z: null, cap_period: "month" },
  });
  // A re-consent whose existing grant already has no cap keeps the user's
  // own earlier choice without asking twice.
  const uncapped = { spend_cap_2z: null, cap_period: "week" };
  assert.deepEqual(resolveCap({ kind: "none" }, uncapped, false), {
    ok: true,
    cap: uncapped,
  });
});

test("a custom cap is a whole number of 2Z from 1, with a known period", () => {
  assert.deepEqual(
    resolveCap(
      { kind: "custom", amount: " 2500 ", period: "week" },
      PRE,
      false,
    ),
    { ok: true, cap: { spend_cap_2z: 2500, cap_period: "week" } },
  );
  for (const amount of ["", "0", "-5", "1.5", "1e3", "abc", "10000001"]) {
    assert.deepEqual(
      resolveCap({ kind: "custom", amount, period: "day" }, PRE, false),
      { ok: false, reason: "amount" },
      amount,
    );
  }
  assert.deepEqual(
    resolveCap({ kind: "custom", amount: "5", period: "year" }, PRE, false),
    { ok: false, reason: "amount" },
  );
  assert.equal(parseCapAmount("007"), 7);
});

test("isCapRaise mirrors the backend's spec §5 rule", () => {
  const month = (n) => ({ spend_cap_2z: n, cap_period: "month" });
  assert.equal(isCapRaise(month(100), month(200)), true);
  assert.equal(isCapRaise(month(100), month(50)), false);
  assert.equal(isCapRaise(month(100), month(100)), false);
  // ANY change of period is a raise -- shorter or longer, and even with a
  // smaller amount: the ledger counts spend per window, so a new period
  // starts an empty one.
  for (const period of ["day", "week", "total"]) {
    assert.equal(
      isCapRaise(month(100), { spend_cap_2z: 100, cap_period: period }),
      true,
      period,
    );
    assert.equal(
      isCapRaise(month(100), { spend_cap_2z: 50, cap_period: period }),
      true,
      `${period} at a lower amount`,
    );
  }
  assert.equal(
    isCapRaise(
      { spend_cap_2z: 100, cap_period: "total" },
      { spend_cap_2z: 100, cap_period: "month" },
    ),
    true,
  );
  // A cap of 0 admits nothing in any window: never a raise.
  assert.equal(
    isCapRaise(month(100), { spend_cap_2z: 0, cap_period: "total" }),
    false,
  );
  // Removing the cap is a raise; adding one to an uncapped grant is not.
  assert.equal(isCapRaise(month(100), month(null)), true);
  assert.equal(isCapRaise(month(null), month(5)), false);
  assert.equal(
    isCapRaise(month(null), { spend_cap_2z: 5, cap_period: "total" }),
    false,
  );
});

test("the backend's is_cap_raise has the same branches", () => {
  const source = fs.readFileSync(
    path.join(REPO, "py/free2z/dj/apps/oidc/consent.py"),
    "utf8",
  );
  const body = /def is_cap_raise\([\s\S]*?\n\n\n/.exec(source)?.[0] ?? "";
  assert.match(body, /if old_cap is None:\s*(?:#[^\n]*\n\s*)?return False/);
  assert.match(body, /if new_cap is None:\s*\n\s*return True/);
  assert.match(body, /if new_cap == 0:\s*\n\s*return False/);
  assert.match(body, /if new_cap > old_cap:\s*\n\s*return True/);
  assert.match(
    body,
    /return CapPeriod\(new_period\) != CapPeriod\(old_period\)/,
  );
  // The rank rule (a longer period is a lowering) is the bug of.
  assert.doesNotMatch(body, /PERIOD_RANK/);
});

test("markupPercent shows basis points as a plain percentage", () => {
  assert.equal(markupPercent(2000, "en"), "20");
  assert.equal(markupPercent(250, "en"), "2.5");
  assert.equal(markupPercent(1, "en"), "0.01");
  assert.equal(markupPercent(5000, "en"), "50");
  assert.equal(markupPercent(1250, "fr"), "12,5");
});

test("authorizationParams keeps exactly the backend's parameters", () => {
  const views = fs.readFileSync(
    path.join(REPO, "py/free2z/dj/apps/oidc/views.py"),
    "utf8",
  );
  const tuple =
    /AUTHORIZATION_PARAMETERS = \(([\s\S]*?)\)/.exec(views)?.[1] ?? "";
  const backend = [...tuple.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...AUTHORIZATION_PARAMETERS], backend);

  const params = authorizationParams(
    new URLSearchParams(
      "client_id=abc&scope=openid&prompt=&f2z_reauth=1&evil=1&state=xyz",
    ),
  );
  assert.deepEqual(params, { client_id: "abc", scope: "openid", state: "xyz" });
  assert.equal(REAUTH_MARKER in params, false);
});

test("the re-auth return path drops prompt=login, keeps the rest, and marks the loop", () => {
  const next = reauthReturnPath(
    "/oauth/authorize",
    "?client_id=abc&prompt=login%20consent&max_age=300&state=s",
  );
  const url = new URL(next, "https://free2z.test");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("max_age"), "300");
  assert.equal(url.searchParams.get("client_id"), "abc");
  assert.equal(url.searchParams.get(REAUTH_MARKER), "1");

  const only = new URL(
    reauthReturnPath("/oauth/authorize", "?prompt=login&state=s"),
    "https://free2z.test",
  );
  assert.equal(only.searchParams.has("prompt"), false);
  // No ticket (an older backend): nothing added.
  assert.equal(only.searchParams.has(LOGIN_TICKET), false);
});

test("the login ticket rides the return trip and is sent back as a parameter (#2242)", () => {
  const next = new URL(
    reauthReturnPath(
      "/oauth/authorize",
      "?client_id=abc&prompt=login&max_age=0&state=s&f2z_login_ticket=old",
      "fresh:ticket",
    ),
    "https://free2z.test",
  );
  // The newest ticket replaces an older one; max_age=0 is kept.
  assert.deepEqual(next.searchParams.getAll(LOGIN_TICKET), ["fresh:ticket"]);
  assert.equal(next.searchParams.get("max_age"), "0");
  assert.equal(next.searchParams.has("prompt"), false);
  //...and the page sends it: it is one of the parameters the backend reads,
  // so it also lands in the echoed authorization_request the POST repeats.
  assert.equal(
    authorizationParams(next.searchParams)[LOGIN_TICKET],
    "fresh:ticket",
  );

  const signedOut = withLoginTicket(
    "/oauth/authorize",
    "?client_id=abc&max_age=0",
    "t1",
  );
  assert.equal(
    new URL(signedOut, "https://free2z.test").searchParams.get(LOGIN_TICKET),
    "t1",
  );
  assert.equal(
    withLoginTicket("/oauth/authorize", "?client_id=abc", ""),
    "/oauth/authorize?client_id=abc",
  );
});

test("a redirect target is never script", () => {
  assert.equal(isNavigableRedirect("https://app.example.com/cb?code=1"), true);
  assert.equal(isNavigableRedirect("http://127.0.0.1:49152/cb?code=1"), true);
  assert.equal(
    isNavigableRedirect("com.example.tutor:/oauth/callback?code=1"),
    true,
  );
  for (const bad of [
    "javascript:alert(1)",
    " JavaScript:alert(1)",
    "data:text/html,x",
    "vbscript:x",
    "/relative",
    "",
    undefined,
  ]) {
    assert.equal(isNavigableRedirect(bad), false, String(bad));
  }
});

test("the spend-cap hint (#2296) is forwarded to the backend and echoed", () => {
  const params = authorizationParams(
    new URLSearchParams(
      "client_id=abc&state=s&f2z_spend_cap=500&f2z_spend_period=total",
    ),
  );
  assert.equal(params[SPEND_CAP_HINT], "500");
  assert.equal(params[SPEND_PERIOD_HINT], "total");
  // The hint never reaches the POST as a cap: only the resolved choice does.
  const body = buildConsentDecision({
    requestId: "r",
    authorizationRequest: params,
    allow: true,
    capRequired: true,
    cap: { spend_cap_2z: 120, cap_period: "week" },
  });
  assert.equal(body.spend_cap_2z, 120);
  assert.equal(body.cap_period, "week");
  assert.equal(body.authorization_request[SPEND_CAP_HINT], "500");
});

test("a raise is judged against the existing grant, not a lower pre-selection", () => {
  const grant = { spend_cap_2z: 100, cap_period: "month" };
  const hinted = { spend_cap_2z: 100, cap_period: "total" };
  // Choosing the grant's own cap back is not a raise...
  assert.equal(isCapRaise(raiseBaseline(grant, hinted), grant), false);
  //...though it is one against the pre-selection (the negative control).
  assert.equal(isCapRaise(hinted, grant), true);
  // An older backend without current_spend_cap: the pre-selection is used.
  assert.deepEqual(raiseBaseline(undefined, hinted), hinted);
  assert.deepEqual(raiseBaseline(null, hinted), hinted);
  assert.deepEqual(
    raiseBaseline({ spend_cap_2z: 5, cap_period: "year" }, hinted),
    hinted,
  );
  assert.deepEqual(
    raiseBaseline({ spend_cap_2z: null, cap_period: "month" }, hinted),
    { spend_cap_2z: null, cap_period: "month" },
  );
});

test("the 'current' choice keeps the grant's cap as-is, even above the custom ceiling", () => {
  const cap = { spend_cap_2z: 20_000_000, cap_period: "month" };
  assert.deepEqual(
    resolveCap(
      { kind: "current", cap },
      { spend_cap_2z: 40, cap_period: "month" },
      false,
    ),
    { ok: true, cap },
  );
  // Negative control: the same amount as custom input is refused.
  assert.equal(
    resolveCap(
      { kind: "custom", amount: "20000000", period: "month" },
      { spend_cap_2z: 40, cap_period: "month" },
      false,
    ).ok,
    false,
  );
});
