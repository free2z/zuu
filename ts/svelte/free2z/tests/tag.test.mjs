import assert from "node:assert/strict";
import test from "node:test";

import {
  TAG_MAX_PAGE,
  TAG_PAGE_SIZE,
  parseTagPage,
  tagHubHref,
  tagPageHref,
  totalTagPages,
} from "../src/lib/tag.js";
import { searchTagHref, tagHref } from "../src/lib/tags.js";

const params = (qs) => new URLSearchParams(qs);

test("page 1 is the bare path, never ?page=1", () => {
  // One URL per result set. A `?page=1` twin is the duplicate-URL shape that
  // put `/search?tag=` in Google's "Excluded by noindex tag" report.
  assert.equal(tagPageHref({ slug: "zcash" }), "/tag/zcash");
  assert.equal(tagPageHref({ slug: "zcash", page: 1 }), "/tag/zcash");
  assert.equal(tagPageHref({ slug: "zcash", page: 2 }), "/tag/zcash?page=2");
});

test("non-ASCII slugs are percent-encoded into the path", () => {
  assert.equal(
    tagPageHref({ slug: "日本語" }),
    "/tag/%E6%97%A5%E6%9C%AC%E8%AA%9E",
  );
  assert.equal(tagPageHref({ slug: "café" }), "/tag/caf%C3%A9");
});

test("page numbers are clamped, so ?page=1e9 cannot be a query plan", () => {
  assert.equal(parseTagPage(params("")), 1);
  assert.equal(parseTagPage(params("page=3")), 3);
  assert.equal(parseTagPage(params("page=0")), 1);
  assert.equal(parseTagPage(params("page=-4")), 1);
  assert.equal(parseTagPage(params("page=banana")), 1);
  assert.equal(parseTagPage(params("page=1e9")), 1, "parseInt stops at the e");
  assert.equal(parseTagPage(params("page=999999999")), TAG_MAX_PAGE);
  assert.equal(parseTagPage(null), 1);
});

test("totalTagPages never reports zero pages", () => {
  assert.equal(totalTagPages(0), 1);
  assert.equal(totalTagPages(1), 1);
  assert.equal(totalTagPages(TAG_PAGE_SIZE), 1);
  assert.equal(totalTagPages(TAG_PAGE_SIZE + 1), 2);
  assert.equal(totalTagPages("not a number"), 1);
});

test("a tag chip now points at the indexable hub", () => {
  // This is the change  exists for: every tag link used to feed a
  // `noindex` search screen that canonicalised onto bare `/search`.
  assert.equal(tagHref("zcash"), "/tag/zcash");
  assert.equal(tagHref("Zebra   Husbandry "), "/tag/zebra-husbandry");
  assert.equal(tagHref("t shirts"), "/tag/t-shirts");
});

test("a tag with no slug falls back to /search rather than linking to a 404", () => {
  assert.equal(tagHubHref("🔥"), null);
  assert.equal(tagHref("🔥"), "/search?tag=%F0%9F%94%A5");
  assert.equal(tagHref("!!!"), "/search?tag=!!!");
});

test("the /search tag filter is still a working, exported capability", () => {
  // `?q=` combined with `?tag=` is a two-axis filter the hub cannot express,
  // so the search route keeps it and the redirect must not swallow it.
  assert.equal(
    searchTagHref("zebra husbandry"),
    "/search?tag=zebra%20husbandry",
  );
  assert.equal(searchTagHref(" a&b "), "/search?tag=a%26b");
});
