import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ZPAGE_CREATE_IDEMPOTENCY_HEADER,
  ZPAGE_CREATE_KEY_HONORED_HEADER,
  backendHonorsCreateKey,
  noteCreateResponse,
  resolvesCreateAttempt,
  newZpageCreateKey,
} from "../src/lib/zpage-create-idempotency.js";

test("a key is a fresh UUIDv4 per call", () => {
  const first = newZpageCreateKey();
  const second = newZpageCreateKey();
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(first, second);
});

test("no randomUUID (an insecure context) means no key, not a weak one", () => {
  assert.equal(newZpageCreateKey({}), null);
  assert.equal(newZpageCreateKey(null), null);
  assert.equal(
    newZpageCreateKey({
      randomUUID() {
        throw new Error("not allowed here");
      },
    }),
    null,
  );
});

test("only proof of the outcome resolves a create attempt", () => {
  const page = { free2zaddr: "abc" };
  assert.equal(resolvesCreateAttempt(201, page), "created");
  assert.equal(
    resolvesCreateAttempt(400, { title: ["This field is required."] }),
    "not-created",
  );
  // A proxy 400 (HTML, parsed to {}) never reached the key.
  assert.equal(resolvesCreateAttempt(400, {}), "unresolved");
  assert.equal(resolvesCreateAttempt(400, null), "unresolved");
  assert.equal(resolvesCreateAttempt(409, {}), "refused");
  // The second-page refusal: the server consulted the key first and
  // rolled the claim back with the refusal, so the key is unspent. Kept as
  // "unresolved", a keyed create would re-send the refused body forever.
  assert.equal(
    resolvesCreateAttempt(402, {
      code: "insufficient_funds",
      cost: "1.000",
      balance: "0.000",
      shortfall: "1.000",
      action: "page_create",
    }),
    "not-created",
  );
  // A 402 that is not the view's own refusal proves nothing.
  assert.equal(resolvesCreateAttempt(402, {}), "unresolved");
  assert.equal(resolvesCreateAttempt(402, "Payment Required"), "unresolved");
  // No answer, a turned-away retry, a 5xx, or a 201 we could not read: the
  // original may have committed, so the attempt must be kept.
  for (const [status, body] of [
    [undefined, undefined],
    [0, {}],
    [201, {}],
    [201, null],
    [401, {}],
    [403, {}],
    [404, {}],
    [429, {}],
    [500, {}],
    [502, {}],
    [504, {}],
  ]) {
    assert.equal(
      resolvesCreateAttempt(status, body),
      "unresolved",
      `${status} ${JSON.stringify(body)}`,
    );
  }
});

test("the header name is the one f2z.yaml declares on POST /api/zpage/", () => {
  const spec = readFileSync(
    new URL(
      "../../../../py/free2z/dj/free2z/openapi/f2z.yaml",
      import.meta.url,
    ),
    {
      encoding: "utf8",
    },
  );
  const create = spec.slice(
    spec.indexOf("operationId: zpage_create"),
    spec.indexOf("operationId:", spec.indexOf("operationId: zpage_create") + 1),
  );
  assert.match(
    create,
    new RegExp(`in: header\\s+name: ${ZPAGE_CREATE_IDEMPOTENCY_HEADER}\\b`),
  );
});

test("the capability is learned from create answers, and withdrawn by a key-ignoring create", () => {
  const answer = (status, headers = {}) => ({
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
  });
  const signal = { [ZPAGE_CREATE_KEY_HONORED_HEADER]: "true" };

  // Nothing seen yet: no automatic retry.
  assert.equal(backendHonorsCreateKey(), false);
  // A proxy error without the header proves nothing either way.
  assert.equal(noteCreateResponse(answer(502)), false);
  assert.equal(backendHonorsCreateKey(), false);
  // Any create answer from this backend, even a refusal, proves it.
  assert.equal(noteCreateResponse(answer(400, signal)), true);
  assert.equal(backendHonorsCreateKey(), true);
  assert.equal(noteCreateResponse(answer(429)), false);
  assert.equal(backendHonorsCreateKey(), true, "a throttle is not a rollback");
  // A page made WITHOUT the signal is a backend that ignored the key.
  assert.equal(noteCreateResponse(answer(201)), false);
  assert.equal(backendHonorsCreateKey(), false);
});

test("the capability header is the one f2z.yaml declares on the create's responses", () => {
  const spec = readFileSync(
    new URL(
      "../../../../py/free2z/dj/free2z/openapi/f2z.yaml",
      import.meta.url,
    ),
    {
      encoding: "utf8",
    },
  );
  const start = spec.indexOf("operationId: zpage_create");
  const create = spec.slice(start, spec.indexOf("operationId:", start + 1));
  assert.match(
    create,
    new RegExp(`headers:\\s+${ZPAGE_CREATE_KEY_HONORED_HEADER}:`),
  );
});
