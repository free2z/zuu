import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usdFixed,
  formatUsd,
  formatUsageMilli,
  creditedAllocation,
} from "../src/lib/economy-values.js";

test("USD display preserves nano-USD and large exact balances", () => {
  assert.equal(formatUsd("0.000000001"), "$0.000000001 USD");
  assert.equal(formatUsd("0.000010000"), "$0.00001 USD");
  assert.equal(formatUsd("0.000000000"), "$0.00 USD");
  assert.equal(formatUsd("1.120000000"), "$1.12 USD");
  assert.equal(
    formatUsd("9007199254740993.000000001"),
    "$9,007,199,254,740,993.000000001 USD",
  );
  assert.equal(usdFixed("10.01"), "10.010000000");
  for (const invalid of ["-1", "1e3", "NaN", "1.0000000001", "01", 10]) {
    assert.throws(() => usdFixed(invalid));
  }
});

test("usage wire units do not become money or lose integer precision", () => {
  assert.equal(formatUsageMilli("1000000"), "1,000 2Z");
  assert.equal(
    formatUsageMilli("9007199254740993001"),
    "9,007,199,254,740,993.001 2Z",
  );
});

test("source-backed issuance allocation explains total fulfillment without inventing a spendable balance", () => {
  assert.deepEqual(
    creditedAllocation(
      { usage_credited_m2z: "750", usage_debt_repaid_m2z: "250" },
      "1000",
    ),
    { added: "750", debtRepaid: "250" },
  );
  assert.deepEqual(
    creditedAllocation(
      { usage_credited_m2z: "0", usage_debt_repaid_m2z: "1000" },
      "1000",
    ),
    { added: "0", debtRepaid: "1000" },
  );
  for (const row of [
    {},
    { usage_credited_m2z: null, usage_debt_repaid_m2z: null },
    { usage_credited_m2z: "1000", usage_debt_repaid_m2z: "1" },
  ])
    assert.equal(creditedAllocation(row, "1000"), null);
});
