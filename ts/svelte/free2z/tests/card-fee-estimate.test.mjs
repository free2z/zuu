// The pre-checkout card-fee estimate (card-v3).
//
// The buyer sees this number BEFORE the server returns the authoritative
// quote, so a drift between it and dj.apps.pricing.constants is a disclosure
// defect — exactly the  shape ("ZUULI shows $20.00, Stripe bills $22.00").
// Nothing in CI compares the two implementations, so this file pins the
// backend's own tier table and asserts the client reproduces it in exact cents.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cardFeeCents,
  estimatedCardCents,
  FALLBACK_CARD_MIN_FEE_CENTS,
  FALLBACK_CARD_PERCENT_FEE,
} from "../src/lib/pricing.ts";

// Copied verbatim from py/free2z/dj/apps/pricing/tests/test_math.py CARD_V3_TIERS.
// [quantity, fee cents, total cents]
const TIERS = [
  [1, 50, 51],
  [2, 50, 52],
  [50, 50, 100],
  [100, 50, 150],
  [499, 50, 549],
  [500, 50, 550], // the floor and the 10% are equal here
  [501, 51, 552], // first quantity the percentage exceeds the floor
  [1_000, 100, 1_100], // the owner's example: 1000 2Z bills at $11
  [2_000, 200, 2_200],
  [100_000, 10_000, 110_000],
  [1_000_000, 100_000, 1_100_000],
];

const livePricing = {
  card: { percent_fee: "0.10", min_fee_cents: 50 },
};

for (const [quantity, fee, total] of TIERS) {
  test(`${quantity} 2Z estimates ${total}c from the live payload`, () => {
    assert.equal(cardFeeCents(quantity, livePricing), fee);
    assert.equal(estimatedCardCents(quantity, livePricing), total);
  });

  test(`${quantity} 2Z estimates ${total}c with no payload yet`, () => {
    // First paint, /api/pricing/ not back yet: the compiled-in fallback must
    // be the same shape, or the estimate is wrong precisely when it is the
    // only number on screen.
    assert.equal(cardFeeCents(quantity, null), fee);
    assert.equal(estimatedCardCents(quantity, undefined), total);
  });
}

test("the estimate follows the server, not a hardcoded shape", () => {
  // If the backend ever moves the fee, the payload moves the client with it.
  const other = { card: { percent_fee: "0.05", min_fee_cents: 100 } };
  assert.equal(cardFeeCents(1_000, other), 100);
  assert.equal(estimatedCardCents(1_000, other), 1_100);
  assert.equal(cardFeeCents(4_000, other), 200);
  assert.equal(estimatedCardCents(4_000, other), 4_200);
});

test("the percentage rounds UP, so we never disclose less than we bill", () => {
  // 10% of 5,001c is 500.1c. Rounding down would show a cent less than Stripe
  // is told to charge.
  assert.equal(cardFeeCents(5_001, livePricing), 501);
  assert.equal(estimatedCardCents(5_001, livePricing), 5_502);
});

test("0.1 is not exact in binary; the estimate is integer arithmetic anyway", () => {
  // A float `Math.ceil(q * 0.1)` is one cent high wherever the product lands
  // just above an integer. Sweep the whole crossover neighbourhood against the
  // exact rule rather than trusting a spot check.
  for (let q = 1; q <= 20_000; q += 1) {
    const exact = Math.max(50, Math.ceil((q * 1_000) / 10_000));
    assert.equal(cardFeeCents(q, livePricing), exact, `quantity ${q}`);
  }
});

test("a card-v2 payload cached under the SAME key falls back whole", () => {
  // `f2z_pricing_v1` is unchanged across the card-v3 cutover, so a returning
  // buyer's localStorage can still hold the card-v2 `card` block. Its
  // `percent_fee` parses fine; its `min_fee_cents` does not exist. Accepting
  // one and defaulting the other builds 5% + the new 50c floor -- a shape no
  // server ever served -- and discloses $10.50 for 1,000 2Z against a real
  // $11.00 charge. Both fields or neither.
  const cachedV2 = { card: { percent_fee: "0.05", flat_fee_cents: 100 } };
  assert.equal(cardFeeCents(1_000, cachedV2), 100);
  assert.equal(estimatedCardCents(1_000, cachedV2), 1_100);
  assert.notEqual(cardFeeCents(1_000, cachedV2), 50); // the hybrid
  // And at a quantity where 5%+50c and 10%+50c differ visibly.
  assert.equal(estimatedCardCents(4_000, cachedV2), 4_400);
});

test("a malformed or missing payload degrades to the fallback, never to NaN", () => {
  for (const bad of [
    {},
    { card: null },
    { card: {} },
    { card: { percent_fee: "abc", min_fee_cents: "x" } },
    { card: { percent_fee: "-1", min_fee_cents: -5 } },
    { card: { percent_fee: "0.05" } },
    { card: { min_fee_cents: 100 } },
  ]) {
    assert.equal(cardFeeCents(1_000, bad), 100);
    assert.equal(estimatedCardCents(1_000, bad), 1_100);
  }
  assert.equal(FALLBACK_CARD_PERCENT_FEE, 0.1);
  assert.equal(FALLBACK_CARD_MIN_FEE_CENTS, 50);
});

test("a nonsense quantity estimates nothing rather than NaN", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(Number.isFinite(estimatedCardCents(bad, livePricing)), true);
  }
  assert.equal(cardFeeCents(0, livePricing), 50);
});
