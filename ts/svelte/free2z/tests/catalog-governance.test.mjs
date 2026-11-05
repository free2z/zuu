import test from "node:test";
import assert from "node:assert/strict";
import {
  examine,
  availabilityErrors,
  importWork,
  exportPilot,
  importPilot,
  hash,
  load,
  exportWork,
} from "../scripts/catalog-governance.mjs";
import {
  disabledLocales,
  localeAvailability,
  resolveRequestLocale,
} from "../src/lib/locale.js";

const valid = () => ({
  source: { hello: "Hello {name}", "trending.pageOf": "Page {page}" },
  catalogs: {
    fr: { hello: "Bonjour {name}", "trending.pageOf": "Page {page}" },
  },
  metadata: {},
  baseline: [
    {
      locale: "fr",
      key: "trending.pageOf",
      sourceHash: hash("Page {page}"),
      translationHash: hash("Page {page}"),
      owner: "owner",
      reason: "legacy",
    },
  ],
});
const check = (x) => examine(x.source, x.catalogs, x.metadata, x.baseline);
test("live census and deterministic work queue", () => {
  const data = load(),
    result = check(data);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(availabilityErrors(result, data.baseline), []);
  assert.ok(result.counts.fr.reviewed <= result.counts.fr.present);
  assert.ok(result.counts.fr.total > 0);
  assert.deepEqual(exportWork(data), exportWork(data));
});
test("catalog mutations identify the intended defect", () => {
  let x = valid();
  delete x.catalogs.fr.hello;
  assert.match(check(x).errors.join(), /missing translation/);
  x = valid();
  x.catalogs.fr.unknown = "x";
  assert.match(check(x).errors.join(), /unknown key/);
  x = valid();
  x.catalogs.fr.hello = "Bonjour {other}";
  assert.match(check(x).errors.join(), /placeholder mismatch/);
  x = valid();
  x.catalogs.fr["trending.pageOf"] = "{page, plural,";
  assert.match(check(x).errors.join(), /invalid ICU/);
  x = valid();
  x.catalogs.fr.hello = x.source.hello;
  assert.match(check(x).errors.join(), /unowned English-identical/);
  x = valid();
  x.metadata.fr = {
    hello: {
      status: "reviewed",
      sourceHash: hash(x.source.hello),
      translationHash: hash(x.catalogs.fr.hello),
      provenance: "machine",
    },
  };
  assert.match(check(x).errors.join(), /invalid review metadata/);
});
test("source changes invalidate prior review and generate a work item", () => {
  const x = valid();
  x.metadata.fr = {
    hello: {
      status: "reviewed",
      sourceHash: hash(x.source.hello),
      translationHash: hash(x.catalogs.fr.hello),
      provenance: "translator",
      reviewType: "human",
      reviewer: "reviewer",
      reviewedAt: "2026-01-01T00:00:00Z",
    },
  };
  assert.equal(check(x).counts.fr.reviewed, 1);
  x.source.hello = "Hello again {name}";
  assert.equal(check(x).counts.fr.reviewed, 0);
  assert.equal(check(x).queue.find((q) => q.key === "hello").reason, "stale");
});
test("deployment disables URL, cookie and weighted browser preferences", () => {
  const disabled = disabledLocales("fr, es, en, unknown");
  assert.deepEqual(disabled, ["fr", "es", "en"]);
  assert.equal(localeAvailability("fr", disabled), "disabled");
  assert.equal(localeAvailability("es"), "beta");
  assert.equal(localeAvailability("en"), "stable");
  assert.equal(localeAvailability("en", disabled), "disabled");
  assert.deepEqual(
    resolveRequestLocale({
      queryLocale: "fr",
      cookieLocale: "es",
      acceptLanguage: "fr;q=1,pt-BR;q=0.9",
      disabled,
    }),
    { locale: "pt-BR", persisted: false },
  );
  assert.equal(
    resolveRequestLocale({ queryLocale: "fr", disabled }).locale,
    "pt-BR",
  );
});

test("promotion requires current human review and no unresolved identical entries", () => {
  const x = valid();
  assert.match(
    availabilityErrors(check(x), x.baseline, [
      { code: "fr", availability: "stable" },
    ]).join(),
    /lacks complete human review/,
  );
});
test("import rejects stale source and accepts explicit unreviewed provenance", () => {
  const x = valid();
  const row = {
    locale: "fr",
    key: "hello",
    sourceHash: hash(x.source.hello),
    translation: "Salut {name}",
    metadata: { status: "draft", provenance: "translator draft" },
  };
  assert.equal(importWork(x, [row]).catalogs.fr.hello, "Salut {name}");
  assert.throws(
    () => importWork(x, [{ ...row, sourceHash: hash("old") }]),
    /stale source/,
  );
  assert.throws(
    () =>
      importWork(x, [
        { ...row, metadata: { status: "reviewed", provenance: "machine" } },
      ]),
    /invalid review metadata/,
  );
});

test("pilot export is a source worklist and does not pretend a translation exists", () => {
  const x = valid();
  const work = exportPilot(x, "ar");
  assert.equal(work.length, 2);
  assert.ok(
    work.every((row) => row.translation === null && row.reason === "missing"),
  );
  assert.throws(() => exportPilot(x, "xx"), /Unsupported pilot/);
});

test("pilot import checks source and placeholders without enabling the locale", () => {
  const data = valid();
  const row = {
    locale: "ar",
    key: "hello",
    sourceHash: hash(data.source.hello),
    translation: "مرحبا {name}",
    metadata: { status: "draft", provenance: "translator draft" },
  };
  assert.equal(importPilot(data, "ar", [row]).messages.hello, row.translation);
  assert.throws(
    () => importPilot(data, "ar", [{ ...row, translation: "مرحبا {other}" }]),
    /placeholder mismatch/,
  );
  assert.throws(
    () => importPilot(data, "ar", [{ ...row, sourceHash: hash("old") }]),
    /stale source/,
  );
});

test("unreviewed English-identical text cannot count as reviewed", () => {
  const x = valid();
  x.metadata.fr = {
    "trending.pageOf": {
      status: "reviewed",
      sourceHash: hash(x.source["trending.pageOf"]),
      translationHash: hash(x.catalogs.fr["trending.pageOf"]),
      provenance: "translator",
      reviewType: "human",
      reviewer: "reviewer",
      reviewedAt: "2026-01-01T00:00:00Z",
    },
  };
  assert.equal(check(x).counts.fr.reviewed, 0);
});
test("the unresolved identical baseline cannot grow", () => {
  const x = valid();
  x.baseline = Array.from({ length: 161 }, (_, i) => ({
    locale: "fr",
    key: `legacy${i}`,
    owner: "owner",
    reason: "legacy",
  }));
  assert.match(check(x).errors.join("\n"), /baseline grew beyond 160/);
});
