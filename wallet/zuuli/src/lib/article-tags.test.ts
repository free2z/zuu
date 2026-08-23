import { describe, expect, it } from "vitest";
import {
  articleTagHref,
  MAX_ARTICLE_TAG_LENGTH,
  MAX_ARTICLE_TAGS,
  MAX_STORED_ARTICLE_TAG_LENGTH,
  normalizeArticleTags,
  parseArticleTagsParam,
  sanitizeArticleTags,
  validateArticleTag,
} from "./article-tags";

describe("article tag contract", () => {
  it("normalizes tag syntax and deduplicates case variants", () => {
    expect(
      normalizeArticleTags([" #Zero   Knowledge ", "PRIVACY", "privacy"]),
    ).toEqual(["zero knowledge", "privacy"]);
  });

  it("supports an open vocabulary while reserving the query delimiter", () => {
    expect(
      normalizeArticleTags([
        "C++",
        "privacy & policy",
        "零知识",
        "🛡️ shielded",
      ]),
    ).toEqual(["c++", "privacy & policy", "零知识", "🛡️ shielded"]);
    expect(validateArticleTag("privacy,security").error).toMatch(/commas/);
    expect(validateArticleTag("privacy\u0000").error).toMatch(/control/);
  });

  it("rejects overlong tags and an oversized publish set", () => {
    expect(
      validateArticleTag("x".repeat(MAX_ARTICLE_TAG_LENGTH + 1)).error,
    ).toMatch(/characters/);
    expect(() =>
      normalizeArticleTags(
        Array.from(
          { length: MAX_ARTICLE_TAGS + 1 },
          (_, index) => `tag-${index}`,
        ),
      ),
    ).toThrow(/at most/);
  });

  it("preserves legal stored tags without reapplying authoring rules", () => {
    const rtl = "مرحبا\u200f";
    const long = "L".repeat(MAX_STORED_ARTICLE_TAG_LENGTH);
    expect(
      sanitizeArticleTags([
        "ART",
        "🏳️‍🌈 pride",
        rtl,
        "machine learning, deep learning",
        long,
        null,
        42,
        "bad\u0000tag",
        "\ud800",
        "x".repeat(MAX_STORED_ARTICLE_TAG_LENGTH + 1),
      ]),
    ).toEqual([
      "ART",
      "🏳️‍🌈 pride",
      rtl,
      "machine learning, deep learning",
      long,
    ]);
  });

  it("fails soft and bounds malformed share URLs", () => {
    expect(
      parseArticleTagsParam(" Privacy,bad\u0000tag,privacy,zero knowledge "),
    ).toEqual(["Privacy", "zero knowledge"]);
    expect(
      parseArticleTagsParam(
        Array.from(
          { length: MAX_ARTICLE_TAGS + 20 },
          (_, index) => `tag-${index}`,
        ).join(","),
      ),
    ).toEqual(
      Array.from({ length: MAX_ARTICLE_TAGS }, (_, index) => `tag-${index}`),
    );
  });

  it("links filterable stored tags without rewriting them", () => {
    expect(articleTagHref("Zero Knowledge")).toBe(
      "/articles?tags=Zero%20Knowledge",
    );
    expect(articleTagHref("🏳️‍🌈 pride")).toBe(
      `/articles?tags=${encodeURIComponent("🏳️‍🌈 pride")}`,
    );
    expect(articleTagHref("machine learning, deep learning")).toBeNull();
    expect(articleTagHref("\ud800")).toBeNull();
  });
});
