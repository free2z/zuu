//the developer console's origin and URL checks, and the connected-
// apps cap editor. The server is the authority for all of it
// (py/free2z/dj/apps/oidc/registration_policy.py, consent.update_grant_cap); these
// pin that the page refuses the same things before a round trip, that the
// cap editor never sends a body without an explicit cap, and that a second
// step-up after a fresh sign-in stops instead of looping.
//
// NEGATIVE CONTROLS (run by hand, ): making `isFirstPartySite` return
// false turns "same-site origins are refused" red; dropping the canonical
// comparison in `originVerdict` turns "only the browser's exact form" red;
// making `stepUpPhase` always return "stepUp" turns the loop-guard test red.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIRST_PARTY_SITES,
  emptyForm,
  formFromApp,
  isAcceptableMetadataUrl,
  isFirstPartySite,
  originVerdict,
  payloadFromForm,
} from "../src/lib/oidc/developer.ts";
import {
  MissingCapDecisionError,
  REAUTH_MARKER,
  capEditFrom,
  capUpdateBody,
  resolveCapEdit,
  sameCap,
  stepUpPhase,
} from "../src/lib/oidc/consent.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..", "..");

test("the first-party sites match the backend's registration policy", () => {
  const source = fs.readFileSync(
    path.join(REPO, "py/free2z/dj/apps/oidc/registration_policy.py"),
    "utf8",
  );
  const tuple =
    /FIRST_PARTY_SITES: tuple\[str, \.\.\.\] = \(([\s\S]*?)\)/.exec(
      source,
    )?.[1] ?? "";
  const sites = [...tuple.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sites.length > 0, "could not read FIRST_PARTY_SITES");
  assert.deepEqual([...FIRST_PARTY_SITES], sites);
});

test("same-site origins are refused", () => {
  for (const origin of [
    "https://free2z.cash",
    "https://stage.free2z.cash",
    "https://a.b.free2give.xyz",
    "https://free2z.com:8443",
    "https://FREE2Z.NET",
  ]) {
    const verdict = originVerdict(origin);
    assert.equal(verdict.ok, false, origin);
    assert.equal(verdict.problem, "sameSite", origin);
  }
  assert.equal(isFirstPartySite("notfree2z.cash"), false);
  assert.equal(isFirstPartySite("free2z.cash.example.org"), false);
  assert.equal(isFirstPartySite("free2z.cash."), true);
});

test("only the browser's exact https://host[:port] form is an origin", () => {
  const refused = {
    "https://app.example.com/": "path",
    "https://app.example.com/cb": "path",
    "https://app.example.com?x=1": "query",
    "https://app.example.com#f": "fragment",
    "http://app.example.com": "notHttps",
    "app.example.com": "notHttps",
    "https://user@app.example.com": "credentials",
    "https://": "noHost",
    "https://app .example.com": "whitespace",
    "https://App.Example.com": "notCanonical",
    "https://app.example.com:443": "notCanonical",
  };
  for (const [origin, problem] of Object.entries(refused)) {
    const verdict = originVerdict(origin);
    assert.equal(verdict.ok, false, origin);
    assert.equal(verdict.problem, problem, origin);
  }
  assert.equal(
    originVerdict("https://App.Example.com:443").canonical,
    "https://app.example.com",
  );
  for (const origin of [
    "https://app.example.com",
    "https://app.example.com:8443",
    "https://notfree2z.cash",
  ]) {
    assert.deepEqual(originVerdict(origin), { ok: true }, origin);
  }
});

test("IPv6 keeps its brackets; an internationalized host is judged as punycode", () => {
  assert.deepEqual(originVerdict("https://[2001:db8::1]:8443"), { ok: true });
  assert.equal(
    originVerdict("https://[2001:DB8::1]").canonical,
    "https://[2001:db8::1]",
  );
  assert.equal(
    originVerdict("https://bücher.example").canonical,
    "https://xn--bcher-kva.example",
  );
  assert.equal(originVerdict("https://ｆｒｅｅ２ｚ.cash").problem, "sameSite");
  // Forms a browser would rewrite are suggested in the rewritten form.
  const rewritten = {
    "https://[2001:0db8:0000:0000:0000:0000:0000:0001]":
      "https://[2001:db8::1]",
    "https://127.1": "https://127.0.0.1",
    "https://%61pp.example.com": "https://app.example.com",
  };
  for (const [origin, canonical] of Object.entries(rewritten)) {
    const verdict = originVerdict(origin);
    assert.equal(verdict.problem, "notCanonical", origin);
    assert.equal(verdict.canonical, canonical, origin);
  }
});

test("an edit judges only the links and origins it changes", () => {
  const legacy = {
    name: "Tutor",
    client_type: "public",
    redirect_uris: ["https://app.example.com/cb"],
    allowed_origins: ["https://App.example.com"],
    privacy_url: "http://app.example.com/privacy",
  };
  const form = formFromApp(legacy);
  assert.equal(
    payloadFromForm({ ...form, markupPercent: "5" }, false, legacy).ok,
    true,
  );
  const changed = payloadFromForm(
    { ...form, privacyUrl: "http://app.example.com/p2" },
    false,
    legacy,
  );
  assert.deepEqual(changed.problems, ["privacyUrl"]);
  // Without the original (a registration) every field is judged.
  assert.deepEqual(payloadFromForm(form, true).problems.sort(), [
    "origins",
    "privacyUrl",
  ]);
});

test("consent-screen links must be https", () => {
  assert.equal(isAcceptableMetadataUrl(""), true);
  assert.equal(isAcceptableMetadataUrl("https://app.example.com/p"), true);
  assert.equal(isAcceptableMetadataUrl("http://app.example.com/p"), false);
  assert.equal(isAcceptableMetadataUrl("javascript:alert(1)"), false);
  assert.equal(isAcceptableMetadataUrl("https://u:p@app.example.com"), false);
  assert.equal(isAcceptableMetadataUrl("not a url"), false);
});

test("the form refuses bad origins and http links before a round trip", () => {
  const form = {
    ...emptyForm(),
    name: "Tutor",
    redirectUris: "https://app.example.com/cb",
    allowedOrigins: "https://app.example.com\nhttps://x.free2z.cash",
    privacyUrl: "http://app.example.com/privacy",
  };
  const result = payloadFromForm(form, true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.sort(), ["origins", "privacyUrl"]);
  // A confidential client sends no origins at all, so none are judged.
  const confidential = payloadFromForm(
    { ...form, clientType: "confidential", privacyUrl: "" },
    true,
  );
  assert.equal(confidential.ok, true);
  assert.deepEqual(confidential.payload.allowed_origins, []);
});

test("the cap editor starts on the current cap", () => {
  assert.deepEqual(capEditFrom({ spend_cap_2z: 250, cap_period: "week" }), {
    kind: "limit",
    amount: "250",
    period: "week",
    noCapConfirmed: false,
  });
  assert.equal(
    capEditFrom({ spend_cap_2z: null, cap_period: "month" }).kind,
    "none",
  );
});

test("the cap editor resolves like the consent screen", () => {
  const current = { spend_cap_2z: 100, cap_period: "month" };
  const edit = capEditFrom(current);
  assert.deepEqual(resolveCapEdit({ ...edit, amount: "50" }, current), {
    ok: true,
    cap: { spend_cap_2z: 50, cap_period: "month" },
  });
  assert.deepEqual(resolveCapEdit({ ...edit, amount: "0" }, current), {
    ok: false,
    reason: "amount",
  });
  // Lifting a limit takes the confirmation.
  assert.deepEqual(resolveCapEdit({ ...edit, kind: "none" }, current), {
    ok: false,
    reason: "confirmNoCap",
  });
  assert.deepEqual(
    resolveCapEdit({ ...edit, kind: "none", noCapConfirmed: true }, current),
    { ok: true, cap: { spend_cap_2z: null, cap_period: "month" } },
  );
  assert.equal(sameCap(current, { ...current }), true);
  assert.equal(sameCap(current, { ...current, cap_period: "week" }), false);
});

test("the cap PUT body always carries both keys", () => {
  assert.deepEqual(capUpdateBody({ spend_cap_2z: null, cap_period: "day" }), {
    spend_cap_2z: null,
    cap_period: "day",
  });
  assert.throws(
    () => capUpdateBody({ spend_cap_2z: undefined, cap_period: "day" }),
    MissingCapDecisionError,
  );
  assert.throws(
    () => capUpdateBody({ spend_cap_2z: 5, cap_period: "year" }),
    MissingCapDecisionError,
  );
});

test("a second step-up after the fresh sign-in stops instead of looping", () => {
  assert.equal(stepUpPhase(new URLSearchParams("")), "stepUp");
  assert.equal(
    stepUpPhase(new URLSearchParams(`${REAUTH_MARKER}=1`)),
    "stepUpLoop",
  );
});
