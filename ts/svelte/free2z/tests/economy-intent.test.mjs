import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readEconomyIntent,
  prepareEconomyIntent,
  clearEconomyIntent,
} from "../src/lib/economy-intent.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function locks() {
  const tails = new Map();
  return {
    request(key, operation) {
      const pending = (tails.get(key) || Promise.resolve()).then(operation);
      tails.set(
        key,
        pending.catch(() => {}),
      );
      return pending;
    },
  };
}

test("unknown purchase outcome and concurrent tabs retain the exact original quote payload", async () => {
  const local = storage();
  const mutex = locks();
  const firstPayload = {
    amount: "10.000000000",
    quote_token: "original-expiring-token",
    acknowledged: true,
  };
  const [first, second] = await Promise.all([
    prepareEconomyIntent(local, mutex, 7, "usage", firstPayload, {
      usage_debt_repaid_m2z: "100",
    }),
    prepareEconomyIntent(local, mutex, 7, "usage", {
      ...firstPayload,
      quote_token: "replacement",
    }),
  ]);
  assert.deepEqual(second.payload, first.payload);
  assert.equal(second.reused, true);
  assert.equal(
    readEconomyIntent(local, 7, "usage").payload.quote_token,
    "original-expiring-token",
  );
  assert.equal(readEconomyIntent(local, 8, "usage"), null);
  await clearEconomyIntent(local, mutex, 7, "usage", "stale-other-key");
  assert.deepEqual(readEconomyIntent(local, 7, "usage").payload, first.payload);
  await clearEconomyIntent(
    local,
    mutex,
    7,
    "usage",
    first.payload.idempotency_key,
  );
  assert.equal(readEconomyIntent(local, 7, "usage"), null);
});

test("storage and lock failures fail before submitting a replacement request", async () => {
  await assert.rejects(
    prepareEconomyIntent(storage(), null, 7, "payment", {
      amount: "1.000000000",
    }),
  );
  const broken = {
    ...storage(),
    setItem() {
      throw new Error("quota");
    },
  };
  await assert.rejects(
    prepareEconomyIntent(broken, locks(), 7, "payment", {
      amount: "1.000000000",
    }),
    /quota/,
  );
  const corrupt = storage();
  corrupt.setItem("f2z:economy-intent:v1:7:usage", "{}");
  assert.throws(() => readEconomyIntent(corrupt, 7, "usage"), /support review/);
  assert.throws(() => readEconomyIntent(storage(), 0, "usage"));
});

test("old durable request binds its original actor without rotating authorization", async () => {
  const local = storage();
  const original = {
    version: 1,
    actor: 7,
    action: "payment",
    payload: {
      amount: "1.000000000",
      address: "u1synthetic",
      idempotency_key: "12345678-1234-1234-1234-123456789abc",
    },
    details: null,
  };
  local.setItem("f2z:economy-intent:v1:7:payment", JSON.stringify(original));
  const migrated = await prepareEconomyIntent(local, locks(), 7, "payment", {
    amount: "2.000000000",
    address: "u1replacement",
  });
  assert.equal(migrated.payload.expected_actor_id, 7);
  assert.equal(
    migrated.payload.idempotency_key,
    original.payload.idempotency_key,
  );
  assert.equal(migrated.payload.address, original.payload.address);
  assert.equal(migrated.payload.amount, original.payload.amount);
  local.setItem(
    "f2z:economy-intent:v1:7:payment",
    JSON.stringify({
      ...migrated,
      payload: { ...migrated.payload, expected_actor_id: 8 },
    }),
  );
  assert.throws(() => readEconomyIntent(local, 7, "payment"), /support review/);
});

test("retired funding writers cannot create an intent or remove historical browser records", async () => {
  const local = storage();
  const historical = '{"historical":"funding record retained"}';
  local.setItem("f2z:economy-intent:v1:7:funding", historical);
  local.setItem("f2z:economy-intent:v1:7:funding:archive", historical);
  await assert.rejects(
    prepareEconomyIntent(local, locks(), 7, "funding", {
      rail: "zcash",
      platform: "web",
      quantity_2z: 2500,
    }),
  );
  assert.equal(local.getItem("f2z:economy-intent:v1:7:funding"), historical);
  assert.equal(
    local.getItem("f2z:economy-intent:v1:7:funding:archive"),
    historical,
  );
});
