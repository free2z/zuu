import assert from "node:assert/strict";
import test from "node:test";
import {
  createCollator,
  createDisplayNames,
  formatDisplayDate,
  formatDisplayNumber,
} from "../src/lib/intl-display.js";

test("display helpers preserve Intl locale lists, precision and options", () => {
  for (const locale of ["en", "fr", "pt-PT"]) {
    for (const value of [0, -0, -12.345, 9007199254740993n]) {
      const options = { maximumFractionDigits: 2 };
      assert.equal(
        formatDisplayNumber(value, locale, options),
        new Intl.NumberFormat(locale, options).format(value),
      );
    }
    const date = new Date("2026-10-11T18:55:00Z");
    const opts = { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" };
    assert.equal(
      formatDisplayDate(date, locale, opts),
      new Intl.DateTimeFormat(locale, opts).format(date),
    );
    assert.equal(
      createCollator(locale, { sensitivity: "base" }).compare("é", "z"),
      new Intl.Collator(locale, { sensitivity: "base" }).compare("é", "z"),
    );
    assert.equal(
      createDisplayNames([locale, "en"], {
        type: "language",
        fallback: "none",
      }).of("zh-Hant"),
      new Intl.DisplayNames([locale, "en"], {
        type: "language",
        fallback: "none",
      }).of("zh-Hant"),
    );
  }
});
