import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let i18n;

before(async () => {
  vite = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  i18n = await vite.ssrLoadModule("/src/lib/i18n.ts");
  await Promise.all(["en", "es", "fr", "pt-BR"].map(i18n.prepareLocale));
});

after(async () => {
  await vite?.close();
});

test("translate interpolates issue #530 messages in every shipped locale", () => {
  const expectedTitles = {
    en: "alice's Zcash Address",
    es: "Dirección Zcash de alice",
    fr: "Adresse Zcash de alice",
    "pt-BR": "Endereço Zcash de alice",
  };

  for (const [locale, expected] of Object.entries(expectedTitles)) {
    assert.equal(
      i18n.translate(
        locale,
        "pageActions.donate.modalTitle",
        "{username}'s Zcash Address",
        { username: "alice" },
      ),
      expected,
    );
  }

  assert.equal(
    i18n.translate(
      "en",
      "pageActions.share.textX",
      "Check out {title} by {username} on Free2Z",
      { title: "Privacy", username: "alice" },
    ),
    "Check out Privacy by alice on Free2Z",
  );
  assert.equal(
    i18n.translate(
      "en",
      "comments.serverError",
      "Server error: {status} {statusText}",
      { status: 503, statusText: "Service Unavailable" },
    ),
    "Server error: 503 Service Unavailable",
  );
});

test("direct and store translation APIs both forward interpolation params", () => {
  i18n.locale.set("en");

  assert.equal(
    i18n.t("pageActions.donate.title", "Donate to {username}", {
      username: "alice",
    }),
    "Donate to alice",
  );

  let storeTranslation;
  const unsubscribe = i18n.tStore.subscribe((value) => {
    storeTranslation = value;
  });

  assert.equal(
    storeTranslation(
      "pageActions.donate.modalTitle",
      "{username}'s Zcash Address",
      { username: "alice" },
    ),
    "alice's Zcash Address",
  );
  unsubscribe();
});

test("fallbacks interpolate known params and preserve unknown placeholders", () => {
  assert.equal(
    i18n.translate("en", "missing.translation", "{known} {unknown}", {
      known: "resolved",
    }),
    "resolved {unknown}",
  );
});

test("ICU migrated keys retain shipped output and source fallback is distinct from missing", () => {
  assert.equal(
    i18n.translate("fr", "trending.pageOf", "unused", { page: 2, total: 4 }),
    "Page 2 sur 4",
  );
  assert.equal(
    i18n.translate("es", "missing.translation", "fallback {value}", {
      value: 7,
    }),
    "fallback 7",
  );
  assert.equal(
    i18n.translate("en", "missing.translation"),
    "missing.translation",
  );
});

test("catalog resolution falls back to English and handles malformed ICU safely", () => {
  const catalogs = { en: { sample: "Hello {name}" }, fr: {} };
  assert.equal(
    i18n.translateWithCatalogs(catalogs, ["sample"], "fr", "sample", "unused", {
      name: "Ada",
    }),
    "Hello Ada",
  );
  catalogs.fr.sample = "{count, plural, one {broken}}";
  const original = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    assert.equal(
      i18n.translateWithCatalogs(
        catalogs,
        ["sample"],
        "fr",
        "sample",
        "unused",
        { name: "Ada" },
      ),
      "Hello Ada",
    );
    assert.equal(
      i18n.translateWithCatalogs(
        { en: { sample: "{n, plural, one {bad}}" } },
        ["sample"],
        "en",
        "sample",
        "It's {name} {unknown}",
        { name: "Ada" },
      ),
      "It's Ada {unknown}",
    );
    assert.equal(
      i18n.translateWithCatalogs(
        { en: { sample: "{name}" } },
        ["sample"],
        "en",
        "sample",
        "Missing {name}",
        {},
      ),
      "Missing {name}",
    );
    assert.ok(errors.length >= 3);
  } finally {
    console.error = original;
  }
});

test("production adapter observes concurrent request locales", async () => {
  const { withRequestLocale } = await vite.ssrLoadModule(
    "/src/lib/server/request-locale.js",
  );
  const catalogs = {
    en: { sample: "{n, plural, one {one} other {# items}}" },
    fr: { sample: "{n, plural, one {un} other {# articles}}" },
  };
  const run = (locale) =>
    withRequestLocale(locale, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return i18n.translateWithCatalogs(
        catalogs,
        ["sample"],
        i18n.getCurrentLocale(),
        "sample",
        "",
        { n: 2 },
      );
    });
  assert.deepEqual(await Promise.all([run("en"), run("fr")]), [
    "2 items",
    "2 articles",
  ]);
});

test("number formatter respects request locale and preserves integer precision", async () => {
  const { withRequestLocale } = await vite.ssrLoadModule(
    "/src/lib/server/request-locale.js",
  );
  const value = 12345678901234567890n;
  const format = (locale) =>
    withRequestLocale(locale, async () => {
      await Promise.resolve();
      return i18n.formatLocalizedNumber(value);
    });
  assert.deepEqual(await Promise.all([format("en"), format("fr")]), [
    new Intl.NumberFormat("en").format(value),
    new Intl.NumberFormat("fr").format(value),
  ]);
  assert.equal(
    i18n.formatLocalizedNumber(12345, "fr", {
      notation: "compact",
      maximumFractionDigits: 1,
    }),
    new Intl.NumberFormat("fr", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(12345),
  );
});

test("list and collation helpers follow concurrent request locales", async () => {
  const { withRequestLocale } = await vite.ssrLoadModule(
    "/src/lib/server/request-locale.js",
  );
  const run = (locale) =>
    withRequestLocale(locale, async () => {
      await Promise.resolve();
      return [
        i18n.formatLocalizedList(["Ada", "Bob", "Cam"]),
        i18n.compareLocalized("é", "z"),
      ];
    });
  for (const [index, locale] of ["en", "fr"].entries()) {
    const actual = (await Promise.all([run("en"), run("fr")]))[index];
    assert.deepEqual(actual, [
      new Intl.ListFormat(locale).format(["Ada", "Bob", "Cam"]),
      new Intl.Collator(locale).compare("é", "z"),
    ]);
  }
});

test("currency, scaled assets and units preserve exact values and Intl semantics", async () => {
  const {
    formatCurrencyMajor: major,
    formatCurrencyMinor: minor,
    formatScaledAsset: asset,
    formatLocalizedUnit: unit,
  } = i18n;
  for (const locale of ["en", "fr"]) {
    const currency = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
    });
    for (const cents of [0, 1, -1, 100, 12345])
      assert.equal(
        major(cents / 100, "USD", locale),
        currency.format(cents / 100),
      );
    assert.equal(
      minor(900719925474099301n, 2, "USD", locale),
      currency.format("9007199254740993.01"),
    );
    assert.equal(
      major("-0.00", "USD", locale, { currencySign: "accounting" }),
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        currencySign: "accounting",
      }).format(-0),
    );
    assert.equal(
      minor(1n, 3, "USD", locale),
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      }).format(0.001),
    );
    assert.equal(
      asset(1n, 8, "ZEC", locale),
      `${new Intl.NumberFormat(locale, { maximumFractionDigits: 8 }).format(0.00000001)} ZEC`,
    );
    assert.equal(
      asset(-1n, 3, "2Z", locale, { minimumFractionDigits: 3 }),
      `${new Intl.NumberFormat(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(-0.001)} 2Z`,
    );
    assert.equal(minor(-1n, 2, "USD", locale), currency.format(-0.01));
    assert.equal(
      minor(12345n, 3, "USD", locale, { maximumFractionDigits: 2 }),
      currency.format(12.345),
    );
    assert.equal(
      asset(1n, 3, "2Z", locale),
      `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(0.001)} 2Z`,
    );
    assert.equal(
      unit(9007199254740993n, "byte", locale, { unitDisplay: "short" }),
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "byte",
        unitDisplay: "short",
      }).format(9007199254740993n),
    );
    assert.equal(
      unit(1.5, "megabyte", locale, {
        unitDisplay: "short",
        maximumFractionDigits: 1,
      }),
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "megabyte",
        unitDisplay: "short",
        maximumFractionDigits: 1,
      }).format(1.5),
    );
  }
  assert.throws(() => major("NaN", "USD", "en"));
  assert.throws(() => major({}, "USD", "en"));
  assert.throws(() => minor(1, 2, "USD", "en"));
  assert.throws(() => major(Infinity, "USD", "en"));
  assert.throws(() => major(1, "ZEC", "en"));
  assert.throws(() => major(1, "ZZZ", "en"));
  assert.throws(() => unit(1, "invalid-unit", "en"));
  assert.throws(() => unit(1, "byte", "pt-PT"));
  assert.throws(() => minor(1n, -1, "USD", "en"));
  const { withRequestLocale } = await vite.ssrLoadModule(
    "/src/lib/server/request-locale.js",
  );
  const run = (locale) =>
    withRequestLocale(locale, async () => {
      await Promise.resolve();
      return [major(1234.5, "USD"), unit(5, "byte")];
    });
  assert.deepEqual(
    await Promise.all([run("en"), run("fr")]),
    ["en", "fr"].map((locale) => [
      major(1234.5, "USD", locale),
      unit(5, "byte", locale),
    ]),
  );
});
