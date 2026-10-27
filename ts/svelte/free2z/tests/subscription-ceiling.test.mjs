import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SUBSCRIPTION_HEADROOM_WARN_RATIO,
  ceilingBlocksRenewal,
  headroomWarnThreshold,
  parsePrice,
  priceCeiling,
  subscriptionCardState,
  subscriptionState,
} from "../src/lib/subscription-ceiling.js";

// Issue: the classifier encodes backend invariants that nothing else in
// CI links to the Python. Each row names the invariant it pins so a backend
// change that breaks one is traceable from a failing assertion.
const CEILING_TABLE = [
  // --- unparseable ceiling: say nothing rather than something wrong --------
  { name: "null max_price", price: "10", max: null, want: "unknown" },
  { name: "undefined max_price", price: "10", max: undefined, want: "unknown" },
  { name: "empty max_price", price: "10", max: "", want: "unknown" },
  { name: "garbage max_price", price: "10", max: "abc", want: "unknown" },

  // --- invariant 1/2: a redacted (null) or negative price cannot renew ----
  // member_price is NOT NULL since, so null is a deactivated creator.
  { name: "null member_price", price: null, max: "50", want: "unpriced" },
  {
    name: "undefined member_price",
    price: undefined,
    max: "50",
    want: "unpriced",
  },
  { name: "empty member_price", price: "", max: "50", want: "unpriced" },
  { name: "garbage member_price", price: "n/a", max: "50", want: "unpriced" },
  { name: "negative member_price", price: "-5", max: "50", want: "unpriced" },

  // ---: 0 IS a free membership --------------------------------------
  { name: "free with a ceiling renews", price: "0", max: "50", want: "ok" },
  {
    name: "free, decimal string, with a ceiling",
    price: "0.00",
    max: "50",
    want: "ok",
  },
  {
    name: "free with a 1 2Z ceiling is near",
    price: "0",
    max: "1",
    want: "near",
  },
  {
    name: "free follow (no ceiling) is free",
    price: "0",
    max: "0",
    want: "free",
  },

  // --- ORDERING (invariant 4): unpriced MUST win over cancelled -----------
  // The cancelled notice tells the fan to raise their maximum; with no usable
  // price that PATCH is refused. If these rows ever flip, the UI starts
  // handing out advice the backend cannot honour.
  {
    name: "null price AND cancelled -> unpriced, not cancelled",
    price: null,
    max: "0",
    want: "unpriced",
  },
  {
    name: "negative price AND cancelled -> unpriced, not cancelled",
    price: "-1",
    max: "0",
    want: "unpriced",
  },
  {
    name: "empty price AND cancelled -> unpriced",
    price: "",
    max: "0",
    want: "unpriced",
  },

  // --- invariant 3: cancellation is max_price = 0 -------------------------
  { name: "cancelled (max 0)", price: "10", max: "0", want: "cancelled" },
  { name: "cancelled (max 0.00)", price: "10", max: "0.00", want: "cancelled" },
  {
    name: "negative max is also cancelled",
    price: "10",
    max: "-1",
    want: "cancelled",
  },

  // --- price vs ceiling ---------------------------------------------------
  { name: "price above ceiling", price: "60", max: "50", want: "over" },
  { name: "price above ceiling by one", price: "51", max: "50", want: "over" },
  { name: "price exactly at ceiling", price: "50", max: "50", want: "at" },
  {
    name: "decimal strings compare numerically",
    price: "50.00",
    max: "50",
    want: "at",
  },
  { name: "10% headroom is near", price: "45", max: "50", want: "near" },
  { name: "just inside 10% headroom", price: "46", max: "50", want: "near" },
  { name: "comfortable headroom", price: "44", max: "50", want: "ok" },
  { name: "large comfortable headroom", price: "10", max: "1000", want: "ok" },

  // --- issue  part 2: small-numbers blind spot -------------------------
  // member_price is decimal_places=0, so the smallest rise is 1 2Z. A pure
  // percentage rule called both of these "ok" while they were one increment
  // from not renewing.
  {
    name: "max=5 price=4 is one raise away",
    price: "4",
    max: "5",
    want: "near",
  },
  {
    name: "max=2 price=1 is one raise away",
    price: "1",
    max: "2",
    want: "near",
  },
  { name: "max=1 price=1", price: "1", max: "1", want: "at" },
  {
    name: "max=3 price=2 is one raise away",
    price: "2",
    max: "3",
    want: "near",
  },
  {
    name: "max=10 price=9 is one raise away",
    price: "9",
    max: "10",
    want: "near",
  },
  {
    name: "max=3 price=1 has room for one raise",
    price: "1",
    max: "3",
    want: "ok",
  },
  { name: "max=5 price=1 is comfortable", price: "1", max: "5", want: "ok" },
];

test("priceCeiling classification table", () => {
  for (const row of CEILING_TABLE) {
    assert.equal(
      priceCeiling(row.price, row.max),
      row.want,
      `${row.name}: priceCeiling(${JSON.stringify(row.price)}, ${JSON.stringify(row.max)})`,
    );
  }
});

test("the unpriced check runs before the cancelled check", () => {
  // Stated twice on purpose: the table row above proves the behaviour, this
  // proves the *reason*. Cancelled advice ("raise your maximum") must never be
  // shown when member_price is null, because that PATCH raises TypeError on
  // `Decimal >= None` server-side.
  assert.equal(priceCeiling(null, "0"), "unpriced");
  assert.notEqual(priceCeiling(null, "0"), "cancelled");
  //...and a real cancellation with a real price is still cancelled.
  assert.equal(priceCeiling("10", "0"), "cancelled");
});

test("headroomWarnThreshold never drops below one whole 2Z", () => {
  assert.equal(headroomWarnThreshold(1), 1);
  assert.equal(headroomWarnThreshold(5), 1);
  assert.equal(headroomWarnThreshold(10), 1);
  assert.equal(headroomWarnThreshold(20), 2);
  assert.equal(headroomWarnThreshold(100), 10);
  assert.equal(SUBSCRIPTION_HEADROOM_WARN_RATIO, 0.1);
});

test("parsePrice", () => {
  assert.equal(parsePrice("50.00"), 50);
  assert.equal(parsePrice(50), 50);
  assert.equal(parsePrice("0"), 0);
  assert.equal(parsePrice("-5"), -5);
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(undefined), null);
  assert.equal(parsePrice(""), null);
  assert.equal(parsePrice("   "), null);
  assert.equal(parsePrice("\t\n"), null);
  assert.equal(parsePrice("abc"), null);
  assert.equal(parsePrice(false), null);
  assert.equal(parsePrice(true), null);
  assert.equal(parsePrice([]), null);
  assert.equal(parsePrice([0]), null);
  assert.equal(parsePrice({}), null);
  assert.equal(parsePrice(Number.NaN), null);
  assert.equal(parsePrice(Number.POSITIVE_INFINITY), null);
  assert.equal(parsePrice(Number.NEGATIVE_INFINITY), null);
});

test("ceilingBlocksRenewal covers exactly the impossible-renewal states", () => {
  // `at` and `near` renew fine this cycle — they warn about a future rise.
  for (const ceiling of ["unpriced", "free", "cancelled", "over"]) {
    assert.equal(ceilingBlocksRenewal(ceiling), true, ceiling);
  }
  for (const ceiling of ["ok", "near", "at", "unknown"]) {
    assert.equal(ceilingBlocksRenewal(ceiling), false, ceiling);
  }
});

test("subscriptionState", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  assert.equal(subscriptionState("2026-09-03T00:00:00Z", now), "active");
  assert.equal(subscriptionState("2026-07-03T00:00:00Z", now), "expired");
  assert.equal(subscriptionState("not a date", now), "unknown");
  assert.equal(subscriptionState(null, now), "unknown");
  assert.equal(subscriptionState(undefined, now), "unknown");
});

test("subscriptionCardState never claims a renewal it cannot make", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const future = "2026-09-03T00:00:00Z";
  const past = "2026-07-03T00:00:00Z";

  // Issue: a cancelled subscription keeps listing for up to 30 days
  // (MySubscriptionsListView filters only on expires__gt=now), and used to
  // render "Active · Renews Sep 3" directly above "…will not renew".
  assert.equal(subscriptionCardState(future, "cancelled", now), "ending");
  assert.equal(subscriptionCardState(future, "unpriced", now), "ending");
  assert.equal(subscriptionCardState(future, "over", now), "ending");

  // Still renewing this cycle.
  assert.equal(subscriptionCardState(future, "ok", now), "active");
  assert.equal(subscriptionCardState(future, "near", now), "active");
  assert.equal(subscriptionCardState(future, "at", now), "active");

  // Fails CLOSED on unreadable data: max_price is `default=0, null=False`, so
  // an unparseable one means the payload is not what we think it is. Do not
  // print a renewal date off a premise we could not verify.
  assert.equal(subscriptionCardState(future, "unknown", now), "unknown");

  // Expiry wins over everything: already lapsed is already lapsed.
  assert.equal(subscriptionCardState(past, "ok", now), "expired");
  assert.equal(subscriptionCardState(past, "cancelled", now), "expired");
  assert.equal(subscriptionCardState("garbage", "cancelled", now), "unknown");
});
