// Unit guards for the shared 2Z balance formatter.
//
// The browser suite proves the pages call it; this proves what it computes,
// at magnitudes no fixture page would ever plausibly carry. The invariant is
// one line: a displayed balance is NEVER more than the creator holds.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatTuzis,
  formatTuzisDeficit,
  toFiniteNumber,
} from "../src/lib/utils/format-tuzis.ts";

// `en-US` explicitly: the separators are the assertion, so they must not
// depend on the runner's default locale.
const fmt = (value) => formatTuzis(value, "en-US");

test("the cent that a Number() round-trip inflates (#1123)", () => {
  // Number("99999999999999.01") === 99999999999999.02 — a value near 1e14 with
  // two decimals needs ~16 significant digits, and a double carries ~15.95.
  // The old helper truncated the TEXT correctly and then threw the result
  // through `Number()`, which put the cent straight back.
  assert.equal(fmt("99999999999999.010"), "99,999,999,999,999.01");
  assert.notEqual(fmt("99999999999999.010"), "99,999,999,999,999.02");

  // Proof the round-trip really does this, so a future refactor that
  // reintroduces it fails here with an explanation rather than a diff.
  assert.equal(Number("99999999999999.01"), 99999999999999.02);
});

test("the widest value the column can hold is truncated, not rounded", () => {
  // max_digits=17, decimal_places=3.
  assert.equal(fmt("99999999999999.999"), "99,999,999,999,999.99");
  // Both wrong answers, named: rounding, and `Math.trunc(n * 100) / 100`,
  // which overflows 2^53 into a whole extra hundred trillion.
  assert.notEqual(fmt("99999999999999.999"), "100,000,000,000,000");
});

test("a balance is never rounded up at any magnitude", () => {
  assert.equal(fmt("4.996"), "4.99");
  assert.equal(fmt("0.999"), "0.99");
  assert.equal(fmt("9.999"), "9.99");
  assert.equal(fmt("64672.234"), "64,672.23");
  assert.equal(fmt("64672.239"), "64,672.23");
});

test("trailing zeros are noise, not precision", () => {
  assert.equal(fmt("3454.000"), "3,454");
  assert.equal(fmt("4.100"), "4.1");
  assert.equal(fmt("4.010"), "4.01");
  assert.equal(fmt("0.000"), "0");
  assert.equal(fmt("0"), "0");
});

test("DRF strings and plain numbers agree", () => {
  assert.equal(fmt(64672.234), "64,672.23");
  assert.equal(fmt(3454), "3,454");
  // `String(1e21)` is "1e+21"; the decimal parser must never see that.
  assert.equal(fmt(1e21), "1,000,000,000,000,000,000,000");
});

test("the number path's precision limit is known, not discovered", () => {
  // Raised by the codex adversarial review of this change. A `number` is
  // accepted so a literal fallback and an `any`-typed payload cannot crash a
  // stat tile — but the loss happens at `Number(...)`, before this function is
  // reached, and nothing here can undo it. Pinned so the boundary is a
  // documented limit with a failing test attached to any attempt to widen the
  // numeric path, rather than a surprise found in production a second time.
  assert.equal(Number("99999999999999.010"), 99999999999999.02);
  assert.equal(fmt(Number("99999999999999.010")), "99,999,999,999,999.02");
  //...whereas the string the API actually sends is exact.
  assert.equal(fmt("99999999999999.010"), "99,999,999,999,999.01");
});

test("nothing readable renders as an em dash, not as 0 or NaN", () => {
  for (const value of [null, undefined, "", "   ", "abc", "1.2.3", ".", "-"]) {
    assert.equal(fmt(value), "—", `input: ${JSON.stringify(value)}`);
  }
  assert.equal(fmt(Number.NaN), "—");
  assert.equal(fmt(Number.POSITIVE_INFINITY), "—");
});

test("a negative balance keeps its sign, including below one unit", () => {
  // The ledger should never produce one, but a formatter that silently drops
  // a minus sign turns a debt into credit — the same class of lie as rounding
  // up, in the other direction.
  assert.equal(fmt("-12.345"), "-12.34");
  assert.equal(fmt("-0.507"), "-0.5");
  //...and a signed zero is still zero, not "-0".
  assert.equal(fmt("-0.000"), "0");
});

test("locale separators come from the locale, not from a hardcoded comma", () => {
  // de-DE swaps both separators; a formatter that concatenates "." by hand
  // would print "1.234.567.89" here.
  assert.equal(formatTuzis("1234567.891", "de-DE"), "1.234.567,89");
});

test("toFiniteNumber rejects what is not a number", () => {
  assert.equal(toFiniteNumber("4.996"), 4.996);
  assert.equal(toFiniteNumber(7), 7);
  assert.equal(toFiniteNumber("  12  "), 12);
  assert.equal(toFiniteNumber(""), null);
  assert.equal(toFiniteNumber("abc"), null);
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(Number.NaN), null);
});

// A shortfall is the one 2Z quantity that must round the OTHER way: it is what
// the fan has to add, and understating it by a fraction reads as "do nothing"
// beside a warning that the renewal will fail. (codex review of.)
const deficit = (value) => formatTuzisDeficit(value, "en-US");

test("a fractional deficit rounds UP to a whole credit, never down to zero", () => {
  // The exact case: renewals total 64, balance 63.999, API shortfall 0.001.
  // `formatTuzis` truncates that to "0" and tells the fan they are fine.
  assert.equal(formatTuzis("0.001", "en-US"), "0");
  assert.equal(deficit("0.001"), "1");
  assert.equal(deficit("0.999"), "1");
  assert.equal(deficit("43.001"), "44");
});

test("a whole deficit is not inflated by a phantom credit", () => {
  assert.equal(deficit("44.000"), "44");
  assert.equal(deficit("44"), "44");
  assert.equal(deficit("0.000"), "0");
  assert.equal(deficit("0"), "0");
});

test("the deficit carry survives past 2^53", () => {
  // `Math.ceil(99999999999999.001)` is 99999999999999 — the double never saw
  // the fraction. The text path carries properly.
  assert.equal(deficit("99999999999999.001"), "100,000,000,000,000");
  assert.equal(deficit("99999999999999.000"), "99,999,999,999,999");
});

test("a deficit that is not a number renders the em dash, not a wrong figure", () => {
  assert.equal(deficit(null), "—");
  assert.equal(deficit("abc"), "—");
  assert.equal(deficit(""), "—");
});
