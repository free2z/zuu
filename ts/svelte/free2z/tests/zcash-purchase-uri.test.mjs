import assert from "node:assert/strict";
import test from "node:test";
import {
  buildZcashPurchaseUri,
  zecAmountForPurchase,
} from "../src/lib/zcash-purchase-uri.ts";

const address = "u1accountpurchase";
const memo = JSON.stringify({
  act: "buy_2z",
  id: "fixtureowner",
});

test("the selected quantity rounds up to zatoshis instead of underpaying at the same rate", () => {
  const amount = zecAmountForPurchase(12, 123311.2496);
  assert.equal(amount, 0.00009732);
  assert.ok(amount * 123311.2496 >= 12);
  assert.match(
    buildZcashPurchaseUri(address, amount, memo),
    /amount=0\.00009732&memo=/,
  );
  for (const [quantity, rate] of [
    [NaN, 123311],
    [0, 123311],
    [12, 0],
    [12, Infinity],
    [1e30, 1],
  ]) {
    assert.ok(Number.isNaN(zecAmountForPurchase(quantity, rate)));
  }
});

test("purchase handoff preserves exact two-field account memo", () => {
  for (const id of ["fixtureowner", "jane-doe", "谢🎉"]) {
    const exact = JSON.stringify({ act: "buy_2z", id });
    const uri = buildZcashPurchaseUri(address, 0.12345678, exact);
    const [recipient, query] = uri.split("?");
    const params = new URLSearchParams(query);
    assert.equal(recipient, `zcash:${address}`);
    assert.equal(params.get("amount"), "0.12345678");
    assert.equal(
      Buffer.from(params.get("memo"), "base64url").toString("utf8"),
      exact,
    );
    assert.doesNotMatch(params.get("memo"), /[+/=]/);
    assert.deepEqual([...params.keys()], ["amount", "memo"]);
  }
});

test("invalid or unrepresentable amounts never produce a send request", () => {
  for (const amount of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    0,
    -1,
    1e-10,
    1e21,
  ]) {
    assert.equal(
      buildZcashPurchaseUri(address, amount, memo),
      "",
      String(amount),
    );
  }
  assert.match(
    buildZcashPurchaseUri(address, 1e-8, memo),
    /amount=0\.00000001&memo=/,
  );
});

test("a purchase cannot target a transparent address or lose attribution", () => {
  for (const recipient of [
    "",
    "t1address",
    "tex1address",
    "u1address?amount=1",
  ]) {
    assert.equal(buildZcashPurchaseUri(recipient, 1, memo), "");
  }
  for (const invalidMemo of [
    "",
    "not JSON",
    "null",
    "[]",
    "{}",
    '{"act":"buy_2z","id":""}',
    '{"act":"buy_2z","id":"  "}',
    '{"act":"page_fund","id":"fixtureowner"}',
  ]) {
    assert.equal(buildZcashPurchaseUri(address, 1, invalidMemo), "");
  }
  assert.match(buildZcashPurchaseUri("zs1saplingaddress", 1, memo), /&memo=/);
});

test("encoding failure or an oversize memo fails closed", () => {
  assert.equal(
    buildZcashPurchaseUri(
      address,
      1,
      JSON.stringify({
        act: "buy_2z",
        id: "fixtureowner",
        ref: "🎉".repeat(200),
      }),
    ),
    "",
  );
  const original = globalThis.btoa;
  try {
    globalThis.btoa = () => {
      throw new Error("encoding unavailable");
    };
    assert.equal(buildZcashPurchaseUri(address, 1, memo), "");
  } finally {
    globalThis.btoa = original;
  }
});
