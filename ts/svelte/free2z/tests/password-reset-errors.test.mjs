//the reset-password page said "the link may have expired" for every
// refusal, in every locale, because it chose between two FALLBACKS of one
// catalog key and the catalog entry always wins. These tests drive the
// classifier with each body the backend actually sends and assert the exact
// sentence a reader gets — through the real catalogs, so a key that resolves
// to the wrong entry fails here, not only a missing fallback.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  classifyResetFailure,
  describeResetPasswordFailure,
} from "../src/lib/password-reset-errors.ts";

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES_DIR = path.join(APP_ROOT, "src", "lib", "locales");
const LOCALES = ["en", "es", "fr", "pt-BR"];
const MIN_LENGTH = 8;

function flatten(value, prefix = "", out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object") flatten(child, full, out);
    else out.set(full, child);
  }
  return out;
}

const CATALOGS = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    flatten(
      JSON.parse(
        fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), "utf8"),
      ),
    ),
  ]),
);

/** Same resolution as `translate()`: the catalog entry wins over the fallback. */
function translator(locale) {
  const catalog = CATALOGS[locale];
  return (key, fallback, params) => {
    const template = catalog.has(key) ? catalog.get(key) : fallback;
    return String(template).replace(/\{([^{}]+)\}/g, (whole, name) =>
      params && Object.hasOwn(params, name) ? String(params[name]) : whole,
    );
  };
}

function describe(locale, status, body, retryAfter = null) {
  return describeResetPasswordFailure(
    { status, body, retryAfter, minLength: MIN_LENGTH },
    translator(locale),
  );
}

function entry(locale, key) {
  const value = CATALOGS[locale].get(`auth.passwordReset.errors.${key}`);
  assert.ok(value, `${locale}.json lacks auth.passwordReset.errors.${key}`);
  return value;
}

// ---- what the backend sends today, one body per refusal --------------------

const WEAK = {
  message: "This password is too common. This password is entirely numeric.",
  code: "password_invalid",
  password_errors: [
    { code: "password_too_common", message: "This password is too common." },
    {
      code: "password_entirely_numeric",
      message: "This password is entirely numeric.",
    },
  ],
};

const CASES = [
  {
    name: "expired link",
    status: 400,
    body: { message: "Token has expired.", code: "token_expired" },
    reason: "token_expired",
    key: "expired",
  },
  {
    name: "spent or unknown link",
    status: 400,
    body: { message: "Invalid token.", code: "token_invalid" },
    reason: "token_invalid",
    key: "invalidToken",
  },
  {
    name: "wrong authenticator code",
    status: 400,
    body: { message: "Invalid OTP token.", code: "invalid_otp" },
    reason: "invalid_otp",
    key: "invalidOtp",
  },
  {
    name: "the last allowed wrong code",
    status: 429,
    body: { message: "Invalid OTP token.", code: "otp_attempts_exhausted" },
    reason: "otp_attempts_exhausted",
    key: "otpAttemptsExhausted",
  },
  {
    name: "MFA attempts already spent",
    status: 429,
    body: {
      message: "Too many password reset attempts. Start again.",
      code: "otp_attempts_exhausted",
    },
    reason: "otp_attempts_exhausted",
    key: "otpAttemptsExhausted",
  },
  {
    name: "MFA attempt store down",
    status: 503,
    body: {
      message: "Password reset is temporarily unavailable.",
      code: "unavailable",
    },
    reason: "unavailable",
    key: "unavailable",
  },
  {
    name: "password changed but sign-in failed",
    status: 500,
    body: {
      message: "Password reset failed.",
      code: "reset_but_not_signed_in",
    },
    reason: "reset_but_not_signed_in",
    key: "resetButNotSignedIn",
  },
  {
    name: "missing fields",
    status: 400,
    body: {
      message: "Token and new password are required.",
      code: "missing_fields",
    },
    reason: "missing_fields",
    key: "missingFields",
  },
];

for (const { name, status, body, reason, key } of CASES) {
  test(`${name}: its own sentence, in every locale`, () => {
    for (const locale of LOCALES) {
      const result = describe(locale, status, body);
      assert.equal(result.reason, reason, `${locale}: ${name}`);
      assert.equal(result.message, entry(locale, key), `${locale}: ${name}`);
    }
  });

  test(`${name}: a backend without \`code\` classifies the same`, () => {
    const { code: _code, ...legacy } = body;
    assert.equal(classifyResetFailure(status, legacy), reason);
  });
}

test("the regression: only an expired link is ever called expired", () => {
  for (const locale of LOCALES) {
    const expired = entry(locale, "expired");
    const bodies = [
      [400, { message: "Invalid OTP token.", code: "invalid_otp" }],
      [400, { message: "Invalid OTP token." }],
      [400, WEAK],
      [400, { message: "['This password is too common.']" }],
      [429, { detail: "Request was throttled." }],
      [503, null],
      [500, { message: "Password reset failed." }],
      [502, null],
    ];
    for (const [status, body] of bodies) {
      assert.notEqual(
        describe(locale, status, body).message,
        expired,
        `${locale} ${status} ${JSON.stringify(body)} must not read as expired`,
      );
    }
  }
});

test("a weak password names each validator, translated", () => {
  assert.equal(
    describe("en", 400, WEAK).message,
    "This password is too common. This password is entirely numeric. " +
      "Choose a different password and try again.",
  );
  const es = describe("es", 400, WEAK).message;
  assert.ok(es.includes(entry("es", "passwordTooCommon")), es);
  assert.ok(es.includes(entry("es", "passwordEntirelyNumeric")), es);
  assert.ok(!es.includes("too common"), `English leaked into es: ${es}`);
});

test("too short and too similar carry their own copy", () => {
  const body = {
    code: "password_invalid",
    message: "x",
    password_errors: [
      { code: "password_too_short", message: "short" },
      { code: "password_too_similar", message: "similar" },
    ],
  };
  const fr = describe("fr", 400, body).message;
  assert.ok(
    fr.includes(entry("fr", "passwordTooShort").replace("{count}", "8")),
    fr,
  );
  assert.ok(fr.includes(entry("fr", "passwordTooSimilar")), fr);
});

test("a validator the page has no copy for shows the server's own sentence", () => {
  const message = describe("es", 400, {
    code: "password_invalid",
    message: "Needs a symbol.",
    password_errors: [
      { code: "password_no_symbol", message: "Needs a symbol." },
    ],
  }).message;
  assert.ok(message.startsWith("Needs a symbol. "), message);
});

test("the old backend's Python list repr becomes sentences", () => {
  const message = describe("en", 400, {
    message: "['This password is too common.', \"It's entirely numeric.\"]",
  }).message;
  assert.equal(
    message,
    "This password is too common. It's entirely numeric. " +
      "Choose a different password and try again.",
  );
});

test("a rate limit says how long, from Retry-After, and keeps the link", () => {
  const body = {
    detail: "Request was throttled. Expected available in 42 seconds.",
  };
  assert.equal(
    describe("en", 429, body, "42").message,
    "Too many attempts. Wait 42 seconds and try again — your reset link still works.",
  );
  assert.equal(
    describe("pt-BR", 429, body, null).message,
    entry("pt-BR", "throttledNoWait"),
  );
});

test("no body or an unknown status falls back to the generic sentence", () => {
  for (const [status, body] of [
    [502, null],
    [500, null],
    [418, { unexpected: true }],
  ]) {
    const result = describe("en", status, body);
    assert.equal(result.reason, "unknown");
    assert.equal(result.message, entry("en", "generic"));
  }
});

test("every key the classifier uses exists in every catalog", () => {
  const source = fs.readFileSync(
    path.join(APP_ROOT, "src", "lib", "password-reset-errors.ts"),
    "utf8",
  );
  const keys = [...source.matchAll(/\bt\(\s*["'`]([\w.]+)["'`]/g)].map(
    (m) => m[1],
  );
  assert.ok(keys.length >= 15, `found only ${keys.length} keys`);
  for (const locale of LOCALES) {
    for (const key of keys) {
      assert.ok(CATALOGS[locale].has(key), `${locale}.json lacks ${key}`);
    }
  }
});

test("the page hands every refusal to the classifier", () => {
  const page = fs.readFileSync(
    path.join(
      APP_ROOT,
      "src",
      "routes",
      "(auth)",
      "reset-password",
      "+page.svelte",
    ),
    "utf8",
  );
  assert.match(page, /describeResetPasswordFailure\(/);
  assert.match(page, /status:\s*response\.status/);
  assert.match(page, /headers\.get\(\s*["']Retry-After["']\s*\)/);
  // The one-key-two-fallbacks shape is what  was.
  assert.doesNotMatch(page, /["']auth\.passwordReset\.errors\.expired["']/);
});

test("the request half names a rate limit instead of 'failed'", () => {
  const store = fs.readFileSync(
    path.join(APP_ROOT, "src", "lib", "stores", "auth.ts"),
    "utf8",
  );
  assert.match(
    store,
    /response\.status\s*===\s*429\s*\?\s*AUTH_MESSAGES\.passwordResetThrottled/,
  );
  const modal = fs.readFileSync(
    path.join(
      APP_ROOT,
      "src",
      "lib",
      "components",
      "auth",
      "UnifiedAuthModal.svelte",
    ),
    "utf8",
  );
  assert.match(modal, /errors\.general\s*=\s*resetResult\.error\s*\?\?/);
  for (const locale of LOCALES) {
    assert.ok(
      CATALOGS[locale].has("auth.errors.passwordResetThrottled"),
      `${locale}.json lacks auth.errors.passwordResetThrottled`,
    );
  }
});
