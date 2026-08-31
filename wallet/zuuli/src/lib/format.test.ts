import { describe, expect, it } from "vitest";
import {
  configureFormattingLocale,
  formatDate,
  formatZec,
  MAX_COMMENT_TUZIS,
  MAX_MEMBER_PRICE_TUZIS,
  MAX_PPV_PRICE_TUZIS,
  MAX_TUZIS,
  MAX_ZEC_INPUT_LENGTH,
  parseTuzis,
  parseZecToZatoshis,
  timeAgo,
  tuziInputMaxLength,
  validateTuzis,
} from "./format";
import { afterEach, beforeEach, vi } from "vitest";

// `parseTuzis` is locale-dependent now (#324), so tests asserting on ASCII
// commas have to pin `locale: "en-US"` instead of relying on the runner's
// default.
describe("parseTuzis (en-US)", () => {
  it.each([
    ["0", 0],
    ["1", 1],
    ["999", 999],
    ["1,000", 1_000],
    ["1000000", 1_000_000],
    ["9,007,199,254,740,991", Number.MAX_SAFE_INTEGER],
  ])("parses exact whole 2Z input %s", (raw, expected) => {
    expect(parseTuzis(raw, "en-US")).toBe(expected);
  });

  it.each([
    "",
    " 1",
    "1 ",
    "-100",
    "+100",
    "1.9",
    "1e3",
    "1.2.3",
    "100 2Z",
    "1_000",
    "1 000",
    "1,00",
    "1,0000",
    "0,001",
    "01",
    "NaN",
    "Infinity",
    "9,007,199,254,740,992",
    "9".repeat(10_000),
  ])("rejects malformed or unsafe 2Z input %s", (raw) => {
    expect(parseTuzis(raw, "en-US")).toBeNull();
  });
});

// #324: any 2Z amount the app displays (`formatTuzis`, i.e. `toLocaleString()`
// in the runtime locale) must parse back verbatim, whatever locale that is —
// different grouping separators, non-3-digit grouping, and non-ASCII digits.
describe("parseTuzis round-trips formatTuzis's toLocaleString() display, per locale", () => {
  const AMOUNTS = [0, 1, 999, 1_000, 12_345, 1_000_000, 10_00_000];

  it.each([
    "en-US",
    "de-DE",
    "fr-FR",
    "hi-IN",
    "ar-SA-u-nu-arab", // Arabic-Indic digits
  ])("round-trips whole 2Z amounts displayed in %s", (locale) => {
    for (const amount of AMOUNTS) {
      const displayed = amount.toLocaleString(locale);
      expect(parseTuzis(displayed, locale)).toBe(amount);
    }
  });

  it("still rejects nonsense once locale glyphs are accounted for", () => {
    expect(parseTuzis("1.000,00", "de-DE")).toBeNull(); // has a decimal part
    expect(parseTuzis("abc", "hi-IN")).toBeNull();
    expect(parseTuzis("", "fr-FR")).toBeNull();
  });
});

describe("parseZecToZatoshis", () => {
  it.each([
    ["0.00000001", 1],
    ["0.1", 10_000_000],
    ["1", 100_000_000],
    ["1.00000000", 100_000_000],
    ["90071992.54740991", Number.MAX_SAFE_INTEGER],
  ])("parses exact ZEC input %s", (raw, expected) => {
    expect(parseZecToZatoshis(raw)).toBe(expected);
  });

  it.each([
    "",
    "0",
    "0.00000000",
    " 1",
    "1 ",
    "-1",
    "+1",
    ".1",
    "1.",
    "1.000000001",
    "1e3",
    "1.2.3",
    "1 ZEC",
    "1,000",
    "NaN",
    "Infinity",
    "90071992.54740992",
    `${"9".repeat(10_000)}.1`,
  ])("rejects malformed, non-positive, imprecise, or unsafe ZEC input %s", (raw) => {
    expect(parseZecToZatoshis(raw)).toBeNull();
  });
});

describe("whole-2Z form limits (en-US)", () => {
  it.each([
    ["purchase/tip", MAX_TUZIS],
    ["member price", MAX_MEMBER_PRICE_TUZIS],
    ["comment", MAX_COMMENT_TUZIS],
    ["whole PPV price", MAX_PPV_PRICE_TUZIS],
  ])("enforces the %s maximum", (_label, maximum) => {
    expect(
      validateTuzis(String(maximum), { minimum: 1, maximum, locale: "en-US" }),
    ).toEqual({ value: maximum, error: null });
    expect(
      validateTuzis(String(maximum + 1), {
        minimum: 1,
        maximum,
        locale: "en-US",
      }),
    ).toEqual({ value: maximum + 1, error: "tooLarge" });
  });

  it("distinguishes malformed and below-minimum input", () => {
    expect(
      validateTuzis("1e3", { minimum: 1, maximum: MAX_TUZIS, locale: "en-US" })
        .error,
    ).toBe("invalid");
    expect(
      validateTuzis("0", { minimum: 1, maximum: MAX_TUZIS, locale: "en-US" })
        .error,
    ).toBe("tooSmall");
  });

  it("provides raw input lengths for canonical comma grouping", () => {
    expect(tuziInputMaxLength(MAX_MEMBER_PRICE_TUZIS, "en-US")).toBe(
      "999,999".length,
    );
    expect(tuziInputMaxLength(MAX_TUZIS, "en-US")).toBe("1,000,000".length);
    expect(tuziInputMaxLength(MAX_COMMENT_TUZIS, "en-US")).toBe(
      "2,147,483,647".length,
    );
    expect(tuziInputMaxLength(MAX_PPV_PRICE_TUZIS, "en-US")).toBe(
      "9,999".length,
    );
    expect(MAX_ZEC_INPUT_LENGTH).toBe("90071992.54740991".length);
  });

  it("gives the correct raw length for hi-IN's lakh (non-3-digit) grouping", () => {
    expect(MAX_TUZIS.toLocaleString("hi-IN")).toBe("10,00,000");
    expect(tuziInputMaxLength(MAX_TUZIS, "hi-IN")).toBe("10,00,000".length);
  });
});

describe("formatZec", () => {
  it("preserves exact minimum, negative, and maximum-safe zatoshi values", () => {
    expect(formatZec(1)).toBe("0.00000001");
    expect(formatZec(-1)).toBe("-0.00000001");
    expect(formatZec(Number.MAX_SAFE_INTEGER)).toBe("90071992.54740991");
  });

  it("rejects values that cannot represent an exact zatoshi amount", () => {
    expect(() => formatZec(1.5)).toThrow(RangeError);
    expect(() => formatZec(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("localized date and relative-time formatting", () => {
  beforeEach(() => {
    configureFormattingLocale("en-US", "Pending");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-02-11T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the bootstrapped pending label and explicit date-time fields", () => {
    expect(formatDate(null)).toBe("Pending");
    const timestamp = Date.parse("2025-01-02T15:04:00Z") / 1000;
    const expected = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp * 1000);
    expect(formatDate(timestamp)).toBe(expected);
  });

  it("uses Intl.RelativeTimeFormat instead of English suffix concatenation", () => {
    const threeMinutesAgo = Date.parse("2025-02-11T11:57:00Z") / 1000;
    expect(timeAgo(threeMinutesAgo, "en")).toBe("3 minutes ago");
    expect(timeAgo(threeMinutesAgo, "es")).toBe("hace 3 minutos");
    expect(timeAgo("2025-02-11T12:00:00Z", "fr")).toBe("maintenant");
    expect(timeAgo("2025-02-11T12:03:00Z", "en")).toBe("in 3 minutes");
  });

  it("uses an explicit calendar-date context beyond the relative window", () => {
    const old = Date.parse("2025-01-01T01:02:03Z") / 1000;
    expect(timeAgo(old, "en-US")).toBe("Jan 1, 2025");
  });
});
