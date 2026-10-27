import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import {
  beginAccountBalanceRead,
  recordQuotedBalanceRead,
  snapshotReadOrder,
} from "../src/lib/account-balance.ts";

const root = new URL("../", import.meta.url);
const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, root)), "utf8");

// PayPerViewPrompt is deliberately absent: it no longer pays  -- see
// "the PPV prompt moves no money" below.
const PAID_SOURCES = [
  [
    "src/lib/components/comments/CommentVote.svelte",
    "voting",
    '"Idempotency-Key": requestKey',
    "intentIdempotencyKey",
  ],
  [
    "src/lib/components/comments/CommentForm.svelte",
    "submitting",
    '"Idempotency-Key": requestKey',
    "intentIdempotencyKey",
  ],
  [
    "src/lib/components/converse/ConverseComposer.svelte",
    "submitting",
    '"Idempotency-Key": requestKey',
    "intentIdempotencyKey",
  ],
  [
    "src/lib/components/zpageActions/BoostButton.svelte",
    "submitting",
    '"Idempotency-Key": requestKey',
    "intentIdempotencyKey",
  ],
  [
    "src/lib/components/mdEditor/CoverAIPanel.svelte",
    "generating",
    '"Idempotency-Key": activeRequestKey',
    "intentIdempotencyKey",
  ],
];

const AUTHENTICATED_ACTOR_SOURCES = [
  "src/lib/components/comments/CommentVote.svelte",
  "src/lib/components/comments/CommentForm.svelte",
  "src/lib/components/zpageActions/BoostButton.svelte",
  "src/lib/components/mdEditor/CoverAIPanel.svelte",
];

for (const [relative, lock, requestMarker, keyMarker] of PAID_SOURCES) {
  test(`${relative} locks before authentication and identifies the request`, () => {
    const source = read(relative);
    const lockAt = source.indexOf(`${lock} = true`);
    const authAt = source.indexOf("await authStore.ensureAuthenticated()");
    assert.notEqual(lockAt, -1, "the paid action needs a synchronous lock");
    assert.notEqual(authAt, -1, "the paid action must authenticate");
    assert.ok(
      lockAt < authAt,
      "the lock must be taken before the first authentication await",
    );
    assert.ok(source.includes(keyMarker), `missing ${keyMarker}`);
    assert.ok(source.includes(requestMarker), `missing ${requestMarker}`);
  });
}

test("paid intent keys wait for hydrated identity and keep one actor bucket", () => {
  for (const relative of AUTHENTICATED_ACTOR_SOURCES) {
    const source = read(relative);
    const authAt = source.indexOf("await authStore.ensureAuthenticated()");
    const identityGuardAt = source.indexOf("|| !$currentUser");
    const keyAt = source.indexOf("intentIdempotencyKey(");

    assert.notEqual(authAt, -1, `${relative} must resolve auth first`);
    assert.notEqual(
      identityGuardAt,
      -1,
      `${relative} must prove that auth resolved to an identity`,
    );
    assert.notEqual(keyAt, -1, `${relative} must derive a request key`);
    assert.ok(
      authAt < identityGuardAt && identityGuardAt < keyAt,
      `${relative} must derive its key only after the authenticated identity guard`,
    );
    assert.doesNotMatch(
      source,
      /actor:\s*\$currentUser\?\.username\s*\?\?\s*"(?:unknown|anonymous)"/,
      `${relative} must not put a fallback actor in a paid retry bucket`,
    );
  }

  // A hydration race must not strand cleanup in the pre-hydration bucket. The
  // components capture the exact identity object used to mint the key and
  // pass that object to cleanup (directly or its warning wrapper) after the response.
  for (const relative of AUTHENTICATED_ACTOR_SOURCES) {
    const source = read(relative);
    assert.match(
      source,
      /(?:clearIntentIdempotencyKey|retirePaidIntent)\(\s*(?:requestIdentity|intent)(?:,[^)]*)?\)/,
      `${relative} must retire the same identity it used to mint the key`,
    );
  }

  const coverSource = read("src/lib/components/mdEditor/CoverAIPanel.svelte");
  assert.match(
    coverSource,
    /const activeRequestKey = requestKey/,
    "the key minted for the current identity is the key sent on the request",
  );
  assert.match(
    coverSource,
    /\"Idempotency-Key\": activeRequestKey/,
    "cover generation sends the exact minted active key",
  );
  assert.match(
    coverSource,
    /const expectedActorId = \$currentUser\.id/,
    "cover recovery captures the authenticated actor with the paid intent",
  );
  assert.match(
    coverSource,
    /\$currentUser\?\.id !== expectedActorId[\s\S]*?\"X-Expected-Actor\": String\(expectedActorId\)/,
    "cover recovery rechecks and submits the immutable expected actor after acquiring the lock",
  );
  assert.match(
    coverSource,
    /isLegacyRetry[\s\S]*?\"X-Require-Existing-Receipt\": \"true\"/,
    "adopted legacy keys are restricted to replaying an existing server receipt",
  );
  assert.match(
    coverSource,
    /retirePaidIntent\(\s*intent,\s*previousIntent,\s*operationNotice,\s*activeRequestKey/,
    "cover settlement retires the minted identity and exact request key, plus any adopted legacy identity",
  );
  assert.match(
    coverSource,
    /const legacyKey = previousIntent\s*\? storedIntentIdempotencyKey\(previousIntent\)\s*: undefined/,
    "cover flow detects whether the current key was adopted from the legacy request",
  );
  assert.match(
    coverSource,
    /let isLegacyRetry = false/,
    "cover requests default to the new disclosure-aware fingerprint",
  );
  assert.match(
    coverSource,
    /isLegacyRetry = legacyKey !== undefined && legacyKey === requestKey/,
    "an adopted legacy key must keep its original server fingerprint",
  );
});

test("raw API responses keep actual dispatch order across CSRF preparation and delayed headers", async () => {
  const compiled = ts.transpileModule(read("src/lib/api/config.ts"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", compiled)(
    module.exports,
    (name) => {
      if (name === "$app/env") return { browser: true };
      if (name === "$lib/stores/auth")
        return { authStore: { captureRequestOwnership: () => () => true } };
      if (name === "$lib/account-balance")
        return { beginAccountBalanceRead, recordQuotedBalanceRead };
      return {
        apiRequestTimeoutMs: () => 30000,
        armRequestTimeout: () => ({
          signal: undefined,
          cleanup() {},
          translate: (error) => error,
        }),
      };
    },
    module,
  );
  const nativeDocument = globalThis.document;
  const nativeFetch = globalThis.fetch;
  let settle, dispatched;
  const started = new Promise((resolve) => {
    dispatched = resolve;
  });
  globalThis.document = {
    cookie: "csrftoken=abcdefghijklmnopqrstuvwxyzABCDEF",
  };
  globalThis.fetch = (_url, init) => {
    assert.equal(
      init.headers["X-CSRFToken"],
      "abcdefghijklmnopqrstuvwxyzABCDEF",
    );
    dispatched();
    return new Promise((resolve) => {
      settle = resolve;
    });
  };
  try {
    const request = module.exports.apiFetch("/api/donation/", {
      method: "POST",
    });
    const beforeDispatch = beginAccountBalanceRead();
    await started;
    const afterDispatch = beginAccountBalanceRead();
    const original = new Response('{"code":"insufficient_funds"}', {
      status: 402,
    });
    settle(original);
    const response = await request;
    assert.equal(response, original);
    assert.ok(snapshotReadOrder(response) > beforeDispatch);
    assert.ok(snapshotReadOrder(response) < afterDispatch);
    assert.equal(await response.text(), '{"code":"insufficient_funds"}');
    assert.deepEqual(Object.keys(response), []);
  } finally {
    globalThis.document = nativeDocument;
    globalThis.fetch = nativeFetch;
  }
});

//. The donation and PPV dialogs minted their key BEFORE
// `ensureAuthenticated()` and under a storage name with no payer in it. Both
// halves are fixed together: the key is derived only after authentication has
// resolved to a user, and the identity object that names that user is the one
// passed to both mint and retire. (The store itself refuses to mint without an
// actor — subscribe-idempotency.test.mjs — so this pins the call sites.)
const DONATION_ACTOR_SOURCES = [
  "src/lib/components/profile/ProfileDonate.svelte",
];

test("donation and PPV keys are derived after the authenticated identity guard, from the payer", () => {
  for (const relative of DONATION_ACTOR_SOURCES) {
    const source = read(relative);
    const authAt = source.indexOf("await authStore.ensureAuthenticated()");
    const identityGuardAt = source.indexOf("|| !$currentUser");
    const keyAt = source.indexOf("donationIdempotencyKey(");

    assert.notEqual(authAt, -1, `${relative} must resolve auth first`);
    assert.notEqual(
      identityGuardAt,
      -1,
      `${relative} must prove that auth resolved to an identity`,
    );
    assert.notEqual(keyAt, -1, `${relative} must derive a payment key`);
    assert.ok(
      authAt < identityGuardAt && identityGuardAt < keyAt,
      `${relative} must derive its key only after the authenticated identity guard`,
    );
    assert.match(
      source,
      /donationIdempotencyKey\(paymentIdentity\)/,
      `${relative} must mint from the captured identity object`,
    );
    assert.match(
      source,
      /actor:\s*\$currentUser\.username,\s*creator:\s*(?:creator\.username|submittedCreatorUsername),/,
      `${relative} must put the authenticated payer in the identity`,
    );
    assert.doesNotMatch(
      source,
      /actor:\s*\$currentUser\?\.username/,
      `${relative} must not put a fallback actor in a paid retry bucket`,
    );
    assert.match(
      source,
      /clearDonationIdempotencyKey\(paymentIdentity,\s*\{\s*expectedKey:\s*idempotencyKey/,
      `${relative} must retire the same identity it used to mint the key`,
    );
    assert.doesNotMatch(
      source,
      /clearDonationIdempotencyKey\(\s*creator\.username/,
      `${relative} still retires by the payer-less positional identity`,
    );
  }
});

//. The PPV "unlock" transferred 2Z to the creator and recorded no
// entitlement; admission is a balance reserve, so paying made admission LESS
// likely and a refused viewer could pay again and again. The server now
// refuses `intent: "ppv"` (dyte/test_ppv_unlock_sequence.py); the dialog must
// not move money by any route, and must gate "Start Watching" on the same
// reserve the server's join gate applies.
test("the PPV prompt moves no money and gates on the join reserve", () => {
  const source = read("src/lib/components/stream/PayPerViewPrompt.svelte");
  assert.doesNotMatch(source, /tuzisDonate\w*\s*\(/);
  assert.doesNotMatch(source, /\$lib\/api\/tuzis/);
  assert.doesNotMatch(source, /Idempotency-Key/);
  assert.doesNotMatch(source, /donationIdempotencyKey/);
  assert.doesNotMatch(source, /intent:\s*["']ppv["']/);
  assert.match(source, /ppvJoinThreshold\(/);
  assert.match(source, /\{#if canJoin\}/);
});

test("payment dialogs clear refusals on close and keep an affordable retry reachable", () => {
  const dialogs = [
    "src/lib/components/profile/ProfileDonate.svelte",
    "src/lib/components/profile/ProfileSubscribe.svelte",
    "src/lib/components/stream/SubscribeToCreator.svelte",
  ];
  for (const relative of dialogs) {
    const source = read(relative);
    assert.match(source, /insufficientFunds\s*=\s*null/);
    assert.match(source, /canAfford/);
    assert.doesNotMatch(source, /canAfford\s*&&\s*!insufficientFunds/);
  }
});

test("exact insufficient-funds formatting has no monetary Number coercion", () => {
  const source = read("src/lib/insufficient-funds.ts");
  assert.match(source, /BigInt/);
  assert.doesNotMatch(source, /Number\(/);
});

test("insufficient-funds formatting preserves max-range decimal text", () => {
  const source = read("src/lib/insufficient-funds.ts");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", compiled)(
    module.exports,
    () => ({ ApiError: class ApiError extends Error {} }),
    module,
  );

  assert.equal(
    module.exports.formatDecimalText("99999999999999.010", "en-US"),
    "99,999,999,999,999.01",
  );
  assert.equal(
    module.exports.formatDecimalText("99999999999999.999", "en-US"),
    "99,999,999,999,999.999",
  );
  assert.equal(module.exports.formatDecimalText("0.005", "en-US", 2), "0.01");
  assert.equal(module.exports.formatDecimalText("9.995", "en-US", 2), "10");
  assert.equal(
    module.exports.formatDecimalText("-1234567.890", "de-DE"),
    "-1.234.567,89",
  );
  assert.equal(
    module.exports.formatDecimalText("99999999999999.999", "hi-IN"),
    "9,99,99,99,99,99,999.999",
  );
  assert.deepEqual(
    module.exports.makeInsufficientFunds(
      "99999999999999.010",
      "99999999999999.009",
      "test",
    ),
    {
      code: "insufficient_funds",
      cost: "99999999999999.01",
      balance: "99999999999999.009",
      shortfall: "0.001",
      action: "test",
    },
  );
});

test("the shared insufficient-funds surface exposes exact facts and next steps", () => {
  const source = read("src/lib/components/InsufficientFunds.svelte");
  assert.match(source, /formatDecimalText\(displayFunds\.cost/);
  assert.match(source, /formatDecimalText\(displayFunds\.balance/);
  assert.match(source, /formatDecimalText\(displayFunds\.shortfall/);
  assert.match(source, /href="\/buy-2z"/);
  assert.match(source, /insufficientFunds\.why/);
  assert.match(source, /insufficientFunds\.notCharged/);
});

test("server refusals carry snapshot provenance while client affordability notices do not", async () => {
  const source = read("src/lib/insufficient-funds.ts");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  class ApiError extends Error {
    constructor(data) {
      super("402");
      this.data = data;
    }
  }
  const module = { exports: {} };
  new Function("exports", "require", "module", compiled)(
    module.exports,
    (name) =>
      name === "$lib/account-balance"
        ? { recordQuotedBalanceRead, snapshotReadOrder }
        : { ApiError },
    module,
  );
  const client = module.exports.makeInsufficientFunds("20", "5", "stream_join");
  assert.equal(module.exports.isServerFundsSnapshot(client), false);
  const fromError = module.exports.insufficientFundsFromError(
    recordQuotedBalanceRead(new ApiError(client), 10),
  );
  const fromResponse = await module.exports.insufficientFundsFromResponse(
    recordQuotedBalanceRead(
      new Response(JSON.stringify(client), { status: 402 }),
      20,
    ),
  );
  assert.equal(module.exports.isServerFundsSnapshot(fromError), true);
  assert.equal(module.exports.isServerFundsSnapshot(fromResponse), true);
  assert.equal(snapshotReadOrder(fromError), 10);
  assert.equal(snapshotReadOrder(fromResponse), 20);
  const unknown = module.exports.insufficientFundsFromError(
    new ApiError(client),
  );
  assert.equal(snapshotReadOrder(unknown), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(fromError)), client);
  assert.deepEqual(JSON.parse(JSON.stringify(fromResponse)), client);
});
