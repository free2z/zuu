// The Settings page's membership-price check, against the SAME table of cases
// the backend runs through the real serializer.
//
// `tests/fixtures/member-price-contract.json` is read by this file AND by
// `py/free2z/dj/apps/g12f/test_member_price_contract.py`. Here: the client accepts
// exactly the accepted cases, sending exactly `sends`, and refuses the refused
// ones for the stated reason. There: the server takes every `sends` of an
// accepted case and refuses every `sends` of a refused one. Together they are
// the "client validation matches the server" claim, run rather than asserted.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  MEMBER_PRICE_MAX,
  MEMBER_PRICE_MIN,
  memberPriceProblemMessage,
  parseMemberPrice,
} from "../src/lib/utils/member-price.ts";

const contract = JSON.parse(
  await readFile(
    new URL("./fixtures/member-price-contract.json", import.meta.url),
    "utf8",
  ),
);

test("the shared contract table loaded and covers both halves", () => {
  // An empty table would make every loop below vacuously green.
  assert.ok(contract.accepted.length >= 5);
  assert.ok(contract.refused.length >= 5);
});

for (const { typed, sends } of contract.accepted) {
  test(`accepts ${JSON.stringify(typed)} and sends ${JSON.stringify(sends)}`, () => {
    assert.deepEqual(parseMemberPrice(typed), { ok: true, value: sends });
  });
}

for (const { typed, problem } of contract.refused) {
  test(`refuses ${JSON.stringify(typed)} as ${problem}`, () => {
    assert.deepEqual(parseMemberPrice(typed), { ok: false, problem });
  });
}

const render = (code) =>
  memberPriceProblemMessage(code, (_k, f, p) =>
    f.replace(/\{(\w+)\}/g, (_m, name) => String(p?.[name] ?? "")),
  );

test('0 is a FREE membership and is sent as "0" (#2510)', () => {
  assert.deepEqual(parseMemberPrice("0"), { ok: true, value: "0" });
  assert.deepEqual(parseMemberPrice(0), { ok: true, value: "0" });
});

test("a negative price is refused and points at 0 = free", () => {
  const result = parseMemberPrice("-1");
  assert.deepEqual(result, { ok: false, problem: "too-small" });
  const message = render(result.problem);
  assert.match(message, /negative/);
  assert.match(message, /0 for a free membership/);
  assert.doesNotMatch(message, /ZEC/);
});

test("an empty price is refused: there is no 'no membership' any more", () => {
  assert.deepEqual(parseMemberPrice(null), { ok: false, problem: "empty" });
  assert.deepEqual(parseMemberPrice(undefined), {
    ok: false,
    problem: "empty",
  });
  assert.match(render("empty"), /0 for a free membership/);
});

test("the bounds are the model's, not round numbers someone liked", () => {
  // MinValueValidator(0); max_digits=6 with decimal_places=0.
  assert.equal(MEMBER_PRICE_MIN, 0);
  assert.equal(MEMBER_PRICE_MAX, 10 ** 6 - 1);
});
