//the client's persisted identity for a translation purchase and the
// server's request fingerprint must cover the SAME facts.
//
// The server (`ZPageTranslationView.post` → `charges.request_fingerprint`)
// binds an `Idempotency-Key` to (zpage, language, source_digest, price). The
// client used to persist its key under (article, language, price) — no digest.
// So: buy, lose the response (the key is kept, that is its job), edit the
// article, buy the same language at the same whole-number price. The client
// rebuilt the same identity and re-sent the same key; the server's fingerprint
// had moved, so it answered 409 `idempotency_mismatch` — and kept answering it
// on every later attempt, because a 409 clears nothing. Translation stayed
// wedged for that article until the price happened to change.
//
// Two layers:
//   1. a property, exercised: over every pair of purchases in a small domain,
//      the client identity is equal EXACTLY when the server fingerprint is;
//   2. a contract, read from the server source: the field list the client
//      claims to mirror is the one `request_fingerprint` actually hashes, and
//      `post()` really feeds it the body digest.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TRANSLATION_PURCHASE_FINGERPRINT_FIELDS,
  translationPurchaseIdentity,
} from "../src/lib/zpage-translation-purchase.js";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  fs.readFileSync(path.join(UI_ROOT, "..", relativePath), "utf8");
const repoFile = (relativePath) =>
  fs.readFileSync(
    path.join(UI_ROOT, "..", "..", "..", "..", relativePath),
    "utf8",
  );

/** The server's fingerprint inputs for one purchase, as a comparable tuple. */
function serverFingerprint({ zpage_id, language, source_digest, price }) {
  // `charges.request_fingerprint`: {"zpage", "language", "source_digest",
  // "price": int(price)} through a canonical JSON SHA-256. Equality of the
  // canonical inputs is equality of the hash.
  return JSON.stringify([zpage_id, language, source_digest, Math.trunc(price)]);
}

/** What the editor hands the client identity for the same purchase. */
function clientIdentity({ actor, identifier, language, source_digest, price }) {
  return JSON.stringify(
    translationPurchaseIdentity({
      actor,
      identifier,
      language,
      quote: { price, source_digest },
    }),
  );
}

// Every server field has two values, so every pair of purchases that differ
// in exactly one server field — the case that wedged — is enumerated, along
// with every pair that agrees.
const DOMAIN = {
  identifier: ["hello-world", "hello-world-2"],
  language: ["es", "fr"],
  source_digest: [
    "3f2a9c1d0e8b7a6f5c4d3e2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f",
    "0000000000000000000000000000000000000000000000000000000000000001",
  ],
  price: [3, 4],
};

function* purchases() {
  for (const identifier of DOMAIN.identifier)
    for (const language of DOMAIN.language)
      for (const source_digest of DOMAIN.source_digest)
        for (const price of DOMAIN.price)
          yield {
            actor: "owner",
            identifier,
            // The server keys on the row id; the client on the URL identifier
            // it has. Both name the same article, which is all the property
            // needs.
            zpage_id: DOMAIN.identifier.indexOf(identifier) + 1,
            language,
            source_digest,
            price,
          };
}

test("the client identity is equal exactly when the server fingerprint is", () => {
  const all = [...purchases()];
  assert.equal(all.length, 16, "precondition: the whole domain");
  let checked = 0;
  for (const a of all) {
    for (const b of all) {
      const serverSame = serverFingerprint(a) === serverFingerprint(b);
      const clientSame = clientIdentity(a) === clientIdentity(b);
      assert.equal(
        clientSame,
        serverSame,
        `${JSON.stringify(a)} vs ${JSON.stringify(b)}: server ${
          serverSame ? "same" : "different"
        }, client ${clientSame ? "same" : "different"}`,
      );
      checked += 1;
    }
  }
  assert.equal(checked, 256);
});

test("editing the article — a new source_digest — is a new purchase on the client too", () => {
  // The exact  sequence: same article, same language, same price, body
  // edited between the two attempts.
  const before = {
    actor: "owner",
    identifier: "hello-world",
    language: "es",
    source_digest: DOMAIN.source_digest[0],
    price: 3,
  };
  const after = { ...before, source_digest: DOMAIN.source_digest[1] };
  assert.notEqual(
    clientIdentity(after),
    clientIdentity(before),
    "same key after an edit → 409 idempotency_mismatch forever",
  );
});

test("every field the server fingerprints changes the client identity, and so does the payer", () => {
  const base = {
    actor: "owner",
    identifier: "hello-world",
    language: "es",
    source_digest: DOMAIN.source_digest[0],
    price: 3,
  };
  const other = {
    identifier: "hello-world-2",
    language: "fr",
    source_digest: DOMAIN.source_digest[1],
    price: 4,
  };
  for (const serverField of Object.keys(
    TRANSLATION_PURCHASE_FINGERPRINT_FIELDS,
  )) {
    const clientInput = serverField === "zpage" ? "identifier" : serverField;
    const changed = { ...base, [clientInput]: other[clientInput] };
    assert.notEqual(
      clientIdentity(changed),
      clientIdentity(base),
      `server field ${serverField} (client ${clientInput}) is not in the client identity`,
    );
  }
  // Not a server field — the server scopes keys per user already — but the
  // browser's storage is per browser, so the client must add it.
  assert.notEqual(
    clientIdentity({ ...base, actor: "someone-else" }),
    clientIdentity(base),
  );
});

test("a quote without a digest cannot mint a key", () => {
  for (const quote of [{ price: 3 }, { price: 3, source_digest: "" }]) {
    assert.throws(
      () =>
        translationPurchaseIdentity({
          actor: "owner",
          identifier: "hello-world",
          language: "es",
          quote,
        }),
      TypeError,
    );
  }
});

// --- the contract, read from the server -------------------------------------

test("the client's field list is the server's request_fingerprint, verbatim", () => {
  const charges = repoFile("py/free2z/dj/apps/g12f/translation/charges.py");
  const fn = charges.match(
    /def request_fingerprint\([^)]*\):[\s\S]*?return fingerprint\(\{([\s\S]*?)\}\)/,
  );
  assert.ok(fn, "charges.request_fingerprint not found");
  const serverFields = [...fn[1].matchAll(/"(\w+)":/g)].map((m) => m[1]);
  assert.deepEqual(
    [...serverFields].sort(),
    Object.keys(TRANSLATION_PURCHASE_FINGERPRINT_FIELDS).sort(),
    "the server fingerprints a field the client identity does not name (or vice versa): add it to translationPurchaseIdentity",
  );
});

test("the purchase view feeds the fingerprint the article's body digest", () => {
  // The request hash uses the QUOTED digest so a completed purchase can replay
  // after the article is edited. A fresh claim then compares that digest under
  // the page lock before debit.
  const view = repoFile("py/free2z/dj/apps/g12f/views/translate.py");
  const post = view.slice(view.indexOf("class ZPageTranslationView"));
  assert.match(
    post,
    /quoted_source_digest = serializer\.validated_data\.get\("source_digest"\)[\s\S]{0,1000}?source_digest = quoted_source_digest or content_digest\(page\.content\)[\s\S]{0,300}?source_digest=source_digest,\s*price=expected_price,\s*\)/,
  );
  assert.match(
    post,
    /current_source_digest = content_digest\(locked_page\.content\)[\s\S]{0,800}?"source_changed"/,
  );
});

test("the editor mints and retires the key with translationPurchaseIdentity, quote included", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const buy = editor.slice(
    editor.indexOf("async function confirmTranslateWithAi("),
  );
  const identity = buy.match(
    /intentIdentity = translationPurchaseIdentity\(\{([\s\S]*?)\}\);/,
  );
  assert.ok(
    identity,
    "the editor must build its identity through the shared function",
  );
  for (const field of [
    "actor: data.currentUser.username",
    "identifier",
    "language",
    "quote",
  ]) {
    assert.ok(
      identity[1].includes(field),
      `translationPurchaseIdentity call is missing ${field}`,
    );
  }
  assert.ok(
    buy.indexOf("translationPurchaseIdentity(") <
      buy.indexOf("intentIdempotencyKey(intentIdentity,"),
    "the identity is built before the key is minted from it",
  );
  // Minted and retired with the SAME object — on settle, on a refused 402 and
  // on the 409 that means the server bound this key to another request — so an
  // identity change can never strand a bucket.
  assert.equal(
    (buy.match(/retireTranslationIntent\(\s*intentIdentity,/g) ?? []).length,
    6,
  );
  // Exactly one of them — the 409 — is a release rather than a settlement.
  assert.equal(
    (buy.match(/unresolved: true\b/g) ?? []).length,
    2,
    "both current and stale 409 mismatch branches must release the adopted key",
  );
  // The rename must not abandon a purchase an older build minted: mint and
  // retire both name the identity that build used (codex adversarial review).
  assert.match(
    buy,
    /intentIdempotencyKey\(intentIdentity, \{\s*supersedes: supersededIdentity,\s*\}\)/,
    "the mint must carry the superseded identity",
  );
  assert.match(
    buy,
    /supersededIdentity = translationPurchaseLegacyIdentity\(\{/,
    "the superseded identity must be the pre-#1597 one",
  );
  // A 409 says the server has bound this key to a DIFFERENT request, so
  // re-sending it can only repeat the 409 — the wedge  is about.
  assert.match(
    buy,
    /translationErrorCode\(error\) === "idempotency_mismatch"\)[\s\S]{0,700}?retireTranslationIntent\(/,
    "a 409 idempotency_mismatch must retire the key instead of wedging",
  );
  //...and as a REFUSAL, not a resolution: a key adopted from an older build
  // belongs to whichever revision it was bought for, and a 409 says only that
  // this is not that revision.
  const mismatch = buy.slice(
    buy.indexOf('translationErrorCode(error) === "idempotency_mismatch"'),
  );
  assert.match(
    mismatch.slice(0, mismatch.indexOf("operationNotice.error(")),
    /unresolved: true,/,
    "a 409 must release the adopted key, not retire it",
  );
  assert.doesNotMatch(
    buy,
    /resource:\s*`\$\{identifier\}\|\$\{language\}`/,
    "the digest-less identity literal is back",
  );
  // A digest-less quote makes `translationPurchaseIdentity` throw. On a money
  // path an uncaught throw is an unhandled rejection: the dialog stays open,
  // the button stays enabled and NOTHING is said. It must be a spoken refusal.
  assert.match(
    buy.slice(0, buy.indexOf("const key = intentIdempotencyKey(")),
    /try\s*\{[\s\S]*?translationPurchaseIdentity\(\{[\s\S]*?\}\s*catch[\s\S]*?operationNotice\.error\([\s\S]*?return;/,
    "the mint-time throw must be caught and reported, not left to reject",
  );
});
