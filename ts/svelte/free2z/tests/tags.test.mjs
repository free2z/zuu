import assert from "node:assert/strict";
import test from "node:test";

import {
  TAG_MAX_LENGTH,
  creatorTagHref,
  mergeTags,
  normalizeTag,
  parseTagInput,
  removeTag,
  tagHref,
  tagKey,
} from "../src/lib/tags.js";

test("whitespace is normalized, because nobody means two tags by it", () => {
  assert.equal(normalizeTag("  zebra   husbandry \n"), "zebra husbandry");
  assert.equal(normalizeTag("\t"), "");
});

test("case is preserved on the way in", () => {
  // The deterministic pass is whitespace only. Case-folding what a creator
  // typed is destructive and cannot be undone once it is in the database;
  // convergence happens through the corpus instead (see below).
  assert.equal(normalizeTag("ZCASh"), "ZCASh");
  assert.equal(tagKey("ZCASh"), "zcash");
});

test("commas and newlines separate; empties are dropped", () => {
  assert.deepEqual(parseTagInput("a, b,, c"), ["a", "b", "c"]);
  assert.deepEqual(parseTagInput("zcash\nprivacy"), ["zcash", "privacy"]);
  assert.deepEqual(parseTagInput("   ,  "), []);
});

test("a paste keeps multi-word tags whole", () => {
  // The separator is the comma, not the space. "zebra husbandry" is one tag.
  assert.deepEqual(parseTagInput("zebra husbandry, quantum knitting"), [
    "zebra husbandry",
    "quantum knitting",
  ]);
});

test("merging appends and refuses case-insensitive duplicates", () => {
  const { tags } = mergeTags(["zcash"], ["ZCASH", "privacy"]);
  assert.deepEqual(tags, ["zcash", "privacy"]);
});

test("a candidate matching the corpus adopts the corpus spelling", () => {
  // The free half of normalization: no AI, no vocabulary, and non-destructive
  // a spelling nothing in the corpus matches is still kept verbatim.
  const { tags } = mergeTags(
    [],
    ["ZCASh", "halo2 recursion"],
    ["zcash", "privacy"],
  );
  assert.deepEqual(tags, ["zcash", "halo2 recursion"]);
});

test("an over-long tag is rejected, not silently truncated", () => {
  // `taggit.models.Tag.name` is max_length=100. A truncated tag saves fine and
  // is wrong forever; a rejected one is visible and fixable.
  const long = "z".repeat(TAG_MAX_LENGTH + 1);
  const { tags, rejected } = mergeTags(["zcash"], [long]);
  assert.deepEqual(tags, ["zcash"]);
  assert.deepEqual(rejected, [long]);
  assert.deepEqual(mergeTags([], ["z".repeat(TAG_MAX_LENGTH)]).rejected, []);
});

test("nothing invents a cap on how many tags a page may carry", () => {
  // The API has none, so neither does this. A client-side limit would refuse
  // a page the API would have accepted.
  const many = Array.from({ length: 60 }, (_, index) => `tag-${index}`);
  assert.equal(mergeTags([], many).tags.length, 60);
});

test("existing tags survive a merge untouched — the whole point of #1181", () => {
  // The editor hands `mergeTags` whatever the API returned, including tags no
  // UI vocabulary knows. Adding one tag must never rewrite or drop the rest.
  const existing = ["zebra husbandry", "café-culture", "ART"];
  const { tags } = mergeTags(existing, ["new tag"], ["art"]);
  assert.deepEqual(tags, ["zebra husbandry", "café-culture", "ART", "new tag"]);
});

test("removal matches case-insensitively so the chip always goes", () => {
  assert.deepEqual(removeTag(["ZCASh", "privacy"], "zcash"), ["privacy"]);
  assert.deepEqual(removeTag(["privacy"], "absent"), ["privacy"]);
});

test("tag links point at the indexable hub, not at full-text search", () => {
  // Was `/search?tag=` until. `?q=` was never right — it would return
  // every article that merely says the word — but `/search?tag=` was a dead
  // end for anyone arriving from a search engine: no server-rendered results,
  // `noindex, follow`, and one canonical for every tag. `/tag/<slug>` is the
  // replacement, and `searchTagHref` (tests/tag.test.mjs) keeps the old form
  // available for the `?q=` + `?tag=` combination the hub cannot express.
  assert.equal(tagHref("zebra husbandry"), "/tag/zebra-husbandry");
  assert.equal(tagHref(" a&b "), "/tag/a-b");
  // Creator-scoped filtering is a different axis — "this creator's pages about
  // X" — and stays on the profile.
  assert.equal(creatorTagHref("skyl", "a b"), "/skyl?tag=a%20b");
});
