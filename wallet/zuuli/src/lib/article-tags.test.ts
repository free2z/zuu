import { describe, expect, it } from "vitest";
import {
  articleTagHref,
  MAX_ARTICLE_TAG_LENGTH,
  MAX_ARTICLE_TAGS,
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

  it("fails soft for malformed share URLs and emits canonical links", () => {
    expect(
      parseArticleTagsParam(" Privacy,bad\u0000tag,privacy,zero knowledge "),
    ).toEqual(["privacy", "zero knowledge"]);
    expect(sanitizeArticleTags(["Privacy", null, 42, "bad\u0000tag"])).toEqual([
      "privacy",
    ]);
    expect(articleTagHref("Zero Knowledge")).toBe(
      "/articles?tags=zero%20knowledge",
    );
  });
});
