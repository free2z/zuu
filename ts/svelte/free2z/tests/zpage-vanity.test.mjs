import assert from "node:assert/strict";
import { test } from "node:test";

import { VANITY_MAX_LENGTH, vanityFromTitle } from "../src/lib/zpage-vanity.js";

//  /: the editor derived the vanity from the title keeping
// non-Latin letters, the API only accepts ASCII, and every autosave of an
// Arabic or Korean article was refused until the creator hand-typed a slug.
// Whatever this returns is sent on every autosave of a new draft, so it must
// be empty or something `validate_vanity` accepts: ASCII a-z, 0-9, hyphens.
const ACCEPTED_BY_THE_API = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

const CASES = [
  // The prod titles, and their scripts' neighbours.
  ["مرحبا بالعالم", "", "all Arabic: nothing ASCII left, so no vanity"],
  [
    "ملخص نظام Zcash البيئي",
    "zcash",
    "Arabic with a Latin word keeps the word",
  ],
  ["Zcash 생태계 요약 9월 13일", "zcash-9-13", "Korean with Latin and digits"],
  ["한국어 요약", "", "all Korean"],
  ["日本語のタイトル", "", "Japanese"],
  ["Привет мир", "", "Cyrillic"],
  ["שלום עולם", "", "Hebrew"],
  ["١٢٣ مقالة", "", "Arabic-Indic digits are not ASCII digits either"],
  // Latin titles behave as they always did.
  ["Hello World", "hello-world", "plain Latin"],
  ["Zebra 6.4.1", "zebra-641", "dots are dropped, not refused"],
  ["Café Déjà Vu", "cafe-deja-vu", "accents fold, as Django's slugify does"],
  ["  --Leading & trailing!--  ", "leading-trailing", "edges trimmed"],
  ["snake_case title", "snake-case-title", "underscores become hyphens"],
  ["Ｆｕｌｌｗｉｄｔｈ", "fullwidth", "NFKD folds fullwidth Latin"],
  ["", "", "empty title"],
];

for (const [title, expected, why] of CASES) {
  test(`vanityFromTitle: ${why}`, () => {
    const vanity = vanityFromTitle(title);
    assert.equal(vanity, expected, JSON.stringify(title));
    assert.match(vanity, ACCEPTED_BY_THE_API, JSON.stringify(title));
  });
}

test("vanityFromTitle tolerates a missing title", () => {
  assert.equal(vanityFromTitle(undefined), "");
  assert.equal(vanityFromTitle(null), "");
});

test("a long title fits the column and never ends on a hyphen", () => {
  const vanity = vanityFromTitle(`${"a".repeat(127)} bcd`);
  assert.ok(vanity.length <= VANITY_MAX_LENGTH, `${vanity.length}`);
  assert.match(vanity, ACCEPTED_BY_THE_API);
  assert.equal(vanity, "a".repeat(127));
});

test("the editor derives the vanity with this function, not the Unicode slugify", async () => {
  // The editor-side half of: the page must call vanityFromTitle where it
  // auto-fills the vanity. Reintroducing `slugify(title)` there would bring
  // the non-Latin vanity (and the 400 on every autosave) straight back.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../src/routes/edit/+page.svelte", import.meta.url),
    "utf8",
  );
  assert.match(source, /vanityFromTitle\(\s*title\s*\)/);
  assert.doesNotMatch(source, /\bslugify\(\s*title\s*\)/);
});
