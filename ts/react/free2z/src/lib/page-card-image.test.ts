import { extractFirstArticleImage, getPageCardImage } from "./page-card-image";

describe("extractFirstArticleImage", () => {
  it("returns the first rendered Markdown image", () => {
    const content = [
      "`![not an image](https://example.com/code.jpg)`",
      '![First](https://images.example.com/first_(large).jpg "A title")',
      "![Second](/uploads/second.jpg)",
    ].join("\n\n");

    expect(extractFirstArticleImage(content)).toBe(
      "https://images.example.com/first_(large).jpg"
    );
  });

  it("ignores images in comments and fenced code", () => {
    const content = [
      "<!-- ![Comment](/uploads/comment.jpg) -->",
      "~~~markdown",
      "![Code](/uploads/code.jpg)",
      "~~~",
      "![Visible](/uploads/visible.jpg)",
    ].join("\n");

    expect(extractFirstArticleImage(content)).toBe("/uploads/visible.jpg");
  });

  it("resolves reference-style body images", () => {
    const content = [
      "![Article photograph][hero]",
      "",
      "[hero]: /uploads/article-hero.webp",
    ].join("\n");

    expect(extractFirstArticleImage(content)).toBe(
      "/uploads/article-hero.webp"
    );
  });

  it("skips unsafe image URLs and can use a later safe image", () => {
    const content = [
      "![Unsafe](javascript:alert(1))",
      "![Safe](../uploads/safe.png)",
    ].join("\n\n");

    expect(extractFirstArticleImage(content)).toBe("../uploads/safe.png");
  });

  it("fails safely for empty or malformed input", () => {
    expect(extractFirstArticleImage(undefined)).toBeNull();
    expect(
      extractFirstArticleImage("![unfinished](<https://example.com")
    ).toBeNull();
    expect(
      extractFirstArticleImage("![unfinished](https://example.com no-close")
    ).toBeNull();
  });
});

describe("getPageCardImage", () => {
  it("prefers a featured image over an article-body image", () => {
    expect(
      getPageCardImage("/uploads/featured.jpg", "![Body](/uploads/body.jpg)")
    ).toEqual({ url: "/uploads/featured.jpg", source: "featured" });
  });

  it("uses an article-body image before the Tuzi fallback", () => {
    expect(getPageCardImage(null, "![Body](/uploads/body.jpg)")).toEqual({
      url: "/uploads/body.jpg",
      source: "body",
    });
  });

  it("preserves the Tuzi fallback when there is no usable image", () => {
    expect(getPageCardImage(null, "Text only")).toEqual({
      url: "/docs/img/tuzi.svg",
      source: "fallback",
    });
  });
});
