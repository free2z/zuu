import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  TAG_SLUG_MAX_LENGTH,
  isCanonicalTagSlug,
  slugifyTag,
} from "../src/lib/tag-slug.js";

/**
 * The JavaScript half of the cross-runtime tag-slug contract.
 *
 * The golden table is authored beside the Python implementation, and
 * `py/free2z/dj/apps/tagging/test_tag_slugs.py` asserts the same file. A slug is
 * computed in the browser (every tag chip's href) and resolved in Django (the
 * URL that href points at), so a disagreement is a dead link on a page we are
 * asking Google to index — which no single-runtime test can catch.
 */
const goldenPath = fileURLToPath(
  new URL(
    "../../../../py/free2z/dj/apps/tagging/testdata/tag_slug_parity.json",
    import.meta.url,
  ),
);
const golden = JSON.parse(readFileSync(goldenPath, "utf8"));

test("every golden case round-trips identically in this runtime", () => {
  assert.ok(golden.cases.length >= 25, "golden table shrank unexpectedly");
  for (const { name, slug, why } of golden.cases) {
    assert.equal(
      slugifyTag(name),
      slug,
      `${why}: slugifyTag(${JSON.stringify(name)})`,
    );
  }
});

test("the bound in the golden table is the bound this module enforces", () => {
  assert.equal(golden.max_length, TAG_SLUG_MAX_LENGTH);
  // And the bound must stay ABOVE the longest slug a storable tag can make —
  // `Tag.name` is 100 characters and lowercasing lengthens by at most 2x.
  // Below that, an over-long tag slugs to something its own name can never
  // match and every chip for it points at a 404 (`slugs.py` has the writeup).
  assert.ok(TAG_SLUG_MAX_LENGTH >= 200, "the truncation bug is back");
  assert.equal(slugifyTag("z".repeat(100)).length, 100, "not truncated");
});

test("slugifying is idempotent, which is what makes it a canonical form", () => {
  for (const { name } of golden.cases) {
    const once = slugifyTag(name);
    assert.equal(slugifyTag(once), once, JSON.stringify(name));
  }
});

test("path traversal has no slug rather than an escaped one", () => {
  // Not a blocklist: `.` is not a letter, number or mark, so `..` reduces to
  // nothing and there is simply no such URL to serve.
  assert.equal(slugifyTag(".."), "");
  assert.equal(slugifyTag("../.."), "");
  assert.equal(slugifyTag("%2e%2e%2f"), "2e-2e-2f");
  assert.equal(slugifyTag("/etc/passwd"), "etc-passwd");
});

test("distinct tags CAN collide on one slug, and that is documented", () => {
  // The mapping is lossy on purpose — see `slugs.py`. The hub owns the
  // collision by browsing the union, so this must stay true rather than being
  // "fixed" into a reversible encoding like `t%2Dshirts`.
  const collide = ["t-shirts", "t shirts", "T/Shirts", "T   SHIRTS"];
  for (const name of collide) {
    assert.equal(slugifyTag(name), "t-shirts", name);
  }
});

test("isCanonicalTagSlug accepts only what slugifyTag emits", () => {
  assert.ok(isCanonicalTagSlug("zcash"));
  assert.ok(isCanonicalTagSlug("t-shirts"));
  assert.ok(isCanonicalTagSlug("日本語"));
  assert.ok(isCanonicalTagSlug("café"));

  assert.equal(isCanonicalTagSlug(""), false);
  assert.equal(isCanonicalTagSlug("Zcash"), false, "upper case");
  assert.equal(isCanonicalTagSlug("a--b"), false, "doubled separator");
  assert.equal(isCanonicalTagSlug("-zcash"), false, "leading separator");
  assert.equal(isCanonicalTagSlug("zcash-"), false, "trailing separator");
  assert.equal(isCanonicalTagSlug(".."), false, "traversal");
  assert.equal(isCanonicalTagSlug("t shirts"), false, "raw space");
  // Derived from the constant on purpose: this assertion is ABOUT the bound
  // being enforced, so a literal would just be a second place to update.
  assert.equal(
    isCanonicalTagSlug("a".repeat(TAG_SLUG_MAX_LENGTH + 1)),
    false,
    "over the bound",
  );
  assert.ok(
    isCanonicalTagSlug("a".repeat(TAG_SLUG_MAX_LENGTH)),
    "exactly the bound",
  );
});

test("the bound is counted in code points, not UTF-16 units", () => {
  // An astral character is two UTF-16 units and one code point. `"".length`
  // would cut this at a different place than Python does, and half of a
  // surrogate pair in a URL is not a URL.
  const astral = "𝟙".repeat(TAG_SLUG_MAX_LENGTH);
  assert.equal(Array.from(slugifyTag(astral)).length, TAG_SLUG_MAX_LENGTH);
  const over = "𝟙".repeat(TAG_SLUG_MAX_LENGTH + 5);
  assert.equal(Array.from(slugifyTag(over)).length, TAG_SLUG_MAX_LENGTH);
});
