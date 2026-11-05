import assert from "node:assert/strict";
import test from "node:test";
import { formatExactDecimalFallback as format } from "../src/lib/exact-decimal-fallback.js";

test("fixed point fallback retains exact large values, signs and rounding", () => {
  const opts = {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  };
  assert.equal(
    format("900719925474099.31", "en", opts),
    "$900,719,925,474,099.31",
  );
  assert.equal(
    format("900719925474099.31", "fr", opts),
    "900 719 925 474 099,31 $US",
  );
  assert.equal(format("-0.005", "en", opts), "-$0.01");
  assert.equal(
    format("-0.001", "en", { ...opts, currencySign: "accounting" }),
    "($0.00)",
  );
  assert.equal(
    format("1.23456789", "en", {
      minimumFractionDigits: 8,
      maximumFractionDigits: 8,
    }),
    "1.23456789",
  );
  assert.equal(format("1234.50", "fr", opts), "1 234,50 $US");
  assert.equal(format("1.234", "en", { maximumSignificantDigits: 2 }), null);
});
