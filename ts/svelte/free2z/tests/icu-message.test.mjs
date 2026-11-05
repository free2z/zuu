import assert from "node:assert/strict";
import test from "node:test";
import { formatIcuMessage } from "../src/lib/icu-message.js";
import { withRequestLocale } from "../src/lib/server/request-locale.js";
import { getRequestLocale } from "../src/lib/request-locale.js";

const format = (pattern, locale, values) =>
  formatIcuMessage(pattern, locale, values);

test("CLDR cardinal categories for Arabic and Polish", () => {
  const p =
    "{n, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}";
  assert.deepEqual(
    [0, 1, 2, 3, 11, 100].map((n) => format(p, "ar", { n })),
    ["zero", "one", "two", "few", "many", "other"],
  );
  assert.deepEqual(
    [1, 2, 5, 1.5].map((n) => format(p, "pl", { n })),
    ["one", "few", "many", "other"],
  );
});

test("ordinal, select, nested arguments and ICU escaping", () => {
  assert.equal(
    format(
      "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
      "en",
      { n: 23 },
    ),
    "23rd",
  );
  assert.equal(
    format(
      "{gender, select, female {{name} has {n, plural, one {one item} other {# items}}} other {unknown}}",
      "en",
      { gender: "female", name: "Ada", n: 2 },
    ),
    "Ada has 2 items",
  );
  assert.equal(
    format("It''s '{literal}' for {name}", "en", { name: "Ada" }),
    "It's {literal} for Ada",
  );
  assert.equal(format("<b>{name}</b>", "en", { name: "Ada" }), "<b>Ada</b>");
});

test("invalid ICU and missing arguments are explicit failures", () => {
  assert.throws(() => format("{n, plural, one {one}}", "en", { n: 1 }));
  assert.throws(() => format("Hello {name}", "en", {}));
});

test("concurrent request scopes select independent ICU rules", async () => {
  const p = "{n, plural, one {one} few {few} other {other}}";
  const run = (locale) =>
    withRequestLocale(locale, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return format(p, getRequestLocale(), { n: 2 });
    });
  assert.deepEqual(await Promise.all([run("en"), run("pl")]), ["other", "few"]);
});

test("every opted-in catalog pattern parses and has matching arguments", async () => {
  const { ICU_MESSAGE_KEYS } = await import("../src/lib/icu-message.js");
  const { IntlMessageFormat } = await import("intl-messageformat");
  const { readFile } = await import("node:fs/promises");
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(
      await readFile(
        new URL(`../src/lib/locales/${locale}.json`, import.meta.url),
      ),
    );
    for (const key of ICU_MESSAGE_KEYS) {
      const pattern = key
        .split(".")
        .reduce((value, part) => value?.[part], catalog);
      assert.equal(typeof pattern, "string", `${locale}: ${key}`);
      assert.doesNotThrow(
        () =>
          new IntlMessageFormat(pattern, locale, undefined, {
            ignoreTag: true,
          }),
      );
      assert.equal(
        format(pattern, locale, { page: 2, total: 4 }).includes("2"),
        true,
      );
    }
  }
});
