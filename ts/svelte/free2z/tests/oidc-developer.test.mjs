// The developer console's form model (; spec §2). A markup typed as a
// percentage must reach the server as the basis points the developer meant,
// and an edit must never try to change the client type.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALL_SCOPES,
  MARKUP_CAP_BPS,
  emptyForm,
  formFromApp,
  parseOptionalCap,
  payloadFromForm,
  percentToBps,
} from "../src/lib/oidc/developer.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..", "..");

test("the platform numbers match the backend's", () => {
  const scopes = fs.readFileSync(
    path.join(REPO, "py/free2z/dj/apps/oidc/scopes.py"),
    "utf8",
  );
  assert.match(scopes, new RegExp(`MARKUP_CAP_BPS = ${MARKUP_CAP_BPS}\\b`));
  const tuple =
    /ALL_SCOPES: tuple\[str, \.\.\.\] = \(([\s\S]*?)\)/.exec(scopes)?.[1] ?? "";
  const names = [...tuple.matchAll(/SCOPE_([A-Z_]+)/g)].map((m) => m[1]);
  const values = names.map((name) => {
    const m = new RegExp(`SCOPE_${name} = "([^"]+)"`).exec(scopes);
    return m?.[1];
  });
  assert.deepEqual([...ALL_SCOPES], values);
});

test("percentToBps converts by digits, never through a float", () => {
  assert.equal(percentToBps("0"), 0);
  assert.equal(percentToBps(""), 0);
  assert.equal(percentToBps("20"), 2000);
  assert.equal(percentToBps("12.5"), 1250);
  assert.equal(percentToBps("0.29"), 29);
  assert.equal(percentToBps("0,5"), 50);
  assert.equal(percentToBps("50"), MARKUP_CAP_BPS);
  for (const bad of ["50.01", "51", "-1", "1.234", "abc", "1e2", "100"]) {
    assert.equal(percentToBps(bad), null, bad);
  }
});

test("parseOptionalCap: empty means no budget suggestion, else a whole number", () => {
  assert.equal(parseOptionalCap(""), null);
  assert.equal(parseOptionalCap(" 250 "), 250);
  assert.equal(parseOptionalCap("0"), 0);
  assert.equal(parseOptionalCap("1.5"), undefined);
  assert.equal(parseOptionalCap("-2"), undefined);
  // The PositiveIntegerField bound: one more is a DB error server-side.
  assert.equal(parseOptionalCap("2147483647"), 2147483647);
  assert.equal(parseOptionalCap("2147483648"), undefined);
});

test("a create sends the client type; an edit never does", () => {
  const form = {
    ...emptyForm(),
    name: "  Tutor  ",
    clientType: "confidential",
    redirectUris: "https://api.example.com/cb\n\nhttps://api.example.com/cb2",
    allowedScopes: ["ai:invoke", "openid"],
    allowedOrigins: "https://ignored.example.com",
    markupPercent: "12.5",
    defaultCap: "",
  };
  const created = payloadFromForm(form, true);
  assert.equal(created.ok, true);
  assert.deepEqual(created.payload, {
    name: "Tutor",
    client_type: "confidential",
    redirect_uris: [
      "https://api.example.com/cb",
      "https://api.example.com/cb2",
    ],
    // In the platform's order, whatever order they were ticked in.
    allowed_scopes: ["openid", "ai:invoke"],
    // Only a public (browser) client has CORS origins.
    allowed_origins: [],
    markup_bps: 1250,
    default_spend_cap_2z: null,
    default_cap_period: "month",
    logo_url: "",
    privacy_url: "",
    terms_url: "",
    // Not children's by default: a developer declares it.
    child_directed: false,
  });
  const edited = payloadFromForm(form, false);
  assert.equal(edited.ok, true);
  assert.equal(Object.hasOwn(edited.payload, "client_type"), false);
});

test("invalid fields are reported, and nothing is built", () => {
  const result = payloadFromForm(
    { ...emptyForm(), name: " ", markupPercent: "60", defaultCap: "x" },
    true,
  );
  assert.deepEqual(result, {
    ok: false,
    problems: ["name", "markup", "defaultCap"],
  });
});

test("formFromApp round-trips an app into the same payload", () => {
  const app = {
    name: "Tutor Web",
    client_type: "public",
    redirect_uris: ["https://app.example.com/cb"],
    allowed_scopes: ["openid", "ai:invoke"],
    allowed_origins: ["https://app.example.com"],
    markup_bps: 2000,
    default_spend_cap_2z: 250,
    default_cap_period: "week",
    logo_url: "",
    privacy_url: "https://app.example.com/privacy",
    terms_url: "",
    child_directed: true,
  };
  const form = formFromApp(app);
  assert.equal(form.childDirected, true);
  assert.equal(form.markupPercent, "20");
  const result = payloadFromForm(form, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    name: "Tutor Web",
    redirect_uris: ["https://app.example.com/cb"],
    allowed_scopes: ["openid", "ai:invoke"],
    allowed_origins: ["https://app.example.com"],
    markup_bps: 2000,
    default_spend_cap_2z: 250,
    default_cap_period: "week",
    logo_url: "",
    privacy_url: "https://app.example.com/privacy",
    terms_url: "",
    child_directed: true,
  });
});
