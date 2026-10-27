import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchPricing,
  anchorServerTime,
  serverTimeNow,
  serverClockUncertain,
  zecFundingCapacityPreview as rawCapacityPreview,
  validZecFundingCapacity,
  exhaustedZecFundingCapacity,
  estimatedTuziPerZec,
  isEstimate,
  BOOTSTRAP_TUZIS_PER_ZEC,
} from "../src/lib/pricing.ts";

const price = {
  zec_usd: "100",
  tuzi_per_usd: 100,
  spread: "0",
  tuzis_per_zec: "10000",
  estimate_buffer: "0.10",
  estimated_tuzis_per_zec: "9000",
  updated_at: "2026-10-11T18:55:00Z",
  stale: false,
};

const previewNow = Date.parse(price.updated_at) + 1000;
const zecFundingCapacityPreview = (amount, pricing, capacity) =>
  rawCapacityPreview(amount, pricing, capacity, previewNow);

test("the payment estimate uses the server estimate rate rather than its settlement rate", () => {
  assert.equal(estimatedTuziPerZec(price), 9000);
  assert.equal(
    estimatedTuziPerZec({ ...price, tuzis_per_zec: "12345", spread: "0.01" }),
    9000,
  );
  assert.equal(
    estimatedTuziPerZec({ ...price, estimated_tuzis_per_zec: "8500" }),
    8500,
  );
});

test("cached and cold-start display estimates never invent a settlement quote", () => {
  assert.equal(
    estimatedTuziPerZec({ ...price, estimated_tuzis_per_zec: undefined }),
    9000,
  );
  assert.equal(
    estimatedTuziPerZec({ zec_usd: "100", tuzi_per_usd: 100, spread: "0.10" }),
    9000,
  );
  assert.equal(estimatedTuziPerZec(null), BOOTSTRAP_TUZIS_PER_ZEC);
  assert.equal(
    estimatedTuziPerZec({
      ...price,
      estimated_tuzis_per_zec: "NaN",
      estimate_buffer: "2",
    }),
    BOOTSTRAP_TUZIS_PER_ZEC,
  );
});

test("an unchanged cached price becomes stale as the display clock advances", () => {
  const updated = Date.parse(price.updated_at);
  assert.equal(isEstimate(price, updated + 1000), false);
  assert.equal(isEstimate(price, updated - 1), true);
  assert.equal(isEstimate({ ...price, stale: true }, updated + 1000), true);
  assert.equal(isEstimate(price, updated + 121000), true);
  assert.equal(
    isEstimate({ ...price, updated_at: "invalid", stale: false }, updated),
    true,
  );
  assert.equal(
    isEstimate({ ...price, updated_at: undefined, stale: false }, updated),
    true,
  );
});

test("code previews never contaminate the default cached pricing", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const writes = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { setItem: (key, value) => writes.set(key, value) },
  });
  try {
    const coded = { ...price, zec_promotion: { requested_code: "ZODL" } };
    const result = await fetchPricing(
      async (url) => {
        assert.equal(url, "/api/pricing/?promo=ZODL");
        return { ok: true, json: async () => coded };
      },
      "",
      "ZODL",
    );
    assert.equal(result, coded);
    assert.equal(writes.size, 0);
    await fetchPricing(async (url) => {
      assert.equal(url, "/api/pricing/");
      return { ok: true, json: async () => price };
    });
    assert.deepEqual(JSON.parse(writes.get("f2z_pricing_v1")), price);
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("capacity uses actual server credit rates and exact upward-rounded monetary projections", () => {
  const capacity = {
    as_of: price.updated_at,
    remaining_m2z: "200000000",
    remaining_sale_nusd: "10000000000000",
  };
  const preview = zecFundingCapacityPreview(22.22222223, price, capacity);
  assert.equal(preview.projected_m2z, "222222223");
  assert.equal(preview.projected_sale_nusd, "2222222223000");
  assert.equal(preview.exceeds_credit_limit, true);
  assert.equal(preview.exceeds_sale_limit, false);
  assert.equal(
    zecFundingCapacityPreview(0.11111112, price, capacity).exceeds_credit_limit,
    false,
  );
  assert.equal(
    zecFundingCapacityPreview(0.11111112, price, {
      ...capacity,
      remaining_sale_nusd: "10000000000",
    }).exceeds_sale_limit,
    true,
  );
  assert.equal(
    zecFundingCapacityPreview(
      0.00000001,
      { ...price, tuzis_per_zec: "1.0000" },
      { ...capacity, remaining_m2z: "0" },
    ).projected_m2z,
    "1",
  );
  assert.equal(
    validZecFundingCapacity({ ...capacity, remaining_m2z: "-1" }),
    false,
  );
  assert.equal(zecFundingCapacityPreview(1, price, null), null);
});

test("zero headroom is known unavailable even without a price projection", () => {
  const capacity = {
    as_of: price.updated_at,
    remaining_m2z: "0",
    remaining_sale_nusd: "100",
  };
  assert.equal(zecFundingCapacityPreview(1, null, capacity), null);
  assert.equal(exhaustedZecFundingCapacity(capacity), true);
  assert.equal(
    exhaustedZecFundingCapacity({
      ...capacity,
      remaining_m2z: "1",
      remaining_sale_nusd: "0",
    }),
    true,
  );
  assert.equal(exhaustedZecFundingCapacity(null), false);
});

test("policy-one projections require separate estimate metadata and nonbootstrap server rates", () => {
  const capacity = {
    as_of: price.updated_at,
    remaining_m2z: "100",
    remaining_sale_nusd: "100",
  };
  assert.equal(
    zecFundingCapacityPreview(
      1,
      { ...price, estimate_buffer: undefined },
      capacity,
    ),
    null,
  );
  assert.equal(
    zecFundingCapacityPreview(1, { ...price, bootstrap: true }, capacity),
    null,
  );
  assert.equal(
    zecFundingCapacityPreview(
      1,
      { ...price, estimated_tuzis_per_zec: "unknown" },
      capacity,
    ),
    null,
  );
});

test("policy-one projections require a fresh nonfuture processing-price snapshot", () => {
  const capacity = {
    as_of: price.updated_at,
    remaining_m2z: "100000000",
    remaining_sale_nusd: "10000000000000",
  };
  const updated = Date.parse(price.updated_at);
  assert.notEqual(
    rawCapacityPreview(1, price, capacity, updated + 120000),
    null,
  );
  assert.equal(rawCapacityPreview(1, price, capacity, updated + 120001), null);
  assert.equal(rawCapacityPreview(1, price, capacity, updated - 1), null);
  assert.equal(
    rawCapacityPreview(1, { ...price, stale: true }, capacity, updated),
    null,
  );
  assert.equal(
    rawCapacityPreview(
      1,
      { ...price, updated_at: "invalid" },
      capacity,
      updated,
    ),
    null,
  );
  assert.equal(estimatedTuziPerZec({ ...price, stale: true }), 9000);
});

test("server time advances monotonically and repeated reads cannot revive an old price", () => {
  const origin = Date.parse(price.updated_at);
  const first = anchorServerTime(price.updated_at, 100, 8100);
  assert.equal(serverTimeNow(first, 8100), origin + 8000);
  assert.equal(serverTimeNow(first, 16100), origin + 16000);
  const repeated = anchorServerTime(price.updated_at, 20100, 22100, first);
  assert.equal(serverTimeNow(repeated, 22100), origin + 22000);
  const older = anchorServerTime(
    "2026-10-11T18:50:00Z",
    25100,
    26100,
    repeated,
  );
  assert.equal(serverTimeNow(older, 26100), origin + 26000);
  assert.equal(
    rawCapacityPreview(
      1,
      price,
      {
        as_of: price.updated_at,
        remaining_m2z: "100000000",
        remaining_sale_nusd: "10000000000000",
      },
      serverTimeNow(older, 120101),
    ),
    null,
  );
  assert.equal(anchorServerTime("invalid", 0, 1), null);
  assert.equal(anchorServerTime(price.updated_at, 1, 0), null);
  assert.equal(isEstimate(price, serverTimeNow(null, 100)), true);
});

test("sleep or wall-clock jumps invalidate elapsed time without rejecting fixed UTC skew", () => {
  const anchor = { server_ms: 1000000, monotonic_ms: 100 };
  for (const skew of [-180000, 180000]) {
    const wall = anchor.server_ms + skew;
    assert.equal(serverClockUncertain(anchor, wall, wall + 1000, 1100), false);
    assert.equal(
      serverClockUncertain(anchor, wall, wall + 3600000, 1100),
      true,
    );
    assert.equal(serverClockUncertain(anchor, wall, wall - 180000, 1100), true);
  }
  assert.equal(serverClockUncertain(anchor, 1000000, 1001100, 1100), false);
  assert.equal(serverClockUncertain(null, null, 1000, 1000), false);
});
