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

  it.each([
    ["indented code", "    ![Code](/uploads/code.jpg)"],
    ["a raw HTML block", "<div>\n![HTML](/uploads/html.jpg)\n</div>"],
  ])("ignores images in %s", (_label, hiddenImage) => {
    expect(
      extractFirstArticleImage(
        `${hiddenImage}\n\n![Visible](/uploads/visible.jpg)`
      )
    ).toBe("/uploads/visible.jpg");
  });

  it.each([
    ["backtick fence", "```markdown"],
    ["tilde fence", "~~~markdown"],
    ["HTML comment", "<!--"],
  ])("does not escape an unterminated %s", (_label, opener) => {
    expect(
      extractFirstArticleImage(
        `${opener}\n![Hidden](/uploads/hidden.jpg)\n\n![Still hidden](/uploads/later.jpg)`
      )
    ).toBeNull();
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

  it("uses the first CommonMark definition for duplicate references", () => {
    const content = [
      "![Article photograph][hero]",
      "",
      "[hero]: /uploads/first.webp",
      "[hero]: /uploads/second.webp",
    ].join("\n");

    expect(extractFirstArticleImage(content)).toBe("/uploads/first.webp");
  });

  it("decodes Markdown character references in destinations", () => {
    expect(
      extractFirstArticleImage(
        "![Signed image](https://images.example.com/signed.png?x=1&amp;y=2)"
      )
    ).toBe("https://images.example.com/signed.png?x=1&y=2");
  });

  it("skips unsafe image URLs and can use a later safe image", () => {
    const content = [
      "![Unsafe](javascript:alert(1))",
      "![Safe](../uploads/safe.png)",
    ].join("\n\n");

    expect(extractFirstArticleImage(content)).toBe("../uploads/safe.png");
  });

  it.each([
    "data:image/png;base64,AA",
    "ftp://example.com/image.png",
    `java${"script"}:alert(1)`,
    "https://example.com/control\u0000.png",
    "http://",
  ])("rejects a non-HTTP or malformed destination: %s", (destination) => {
    expect(
      extractFirstArticleImage(
        `![Rejected](${destination})\n\n![Safe](/uploads/safe.png)`
      )
    ).toBe("/uploads/safe.png");
  });

  it("does not promote a malformed angle-bracket destination", () => {
    expect(
      extractFirstArticleImage(
        "![Malformed](<https://images.example.com/a<bad.png>)\n\n![Safe](/uploads/safe.png)"
      )
    ).toBe("/uploads/safe.png");
  });

  it("handles many unmatched image openers without quadratic rescanning", () => {
    const content = "![".repeat(50_000);
    const startedAt = performance.now();

    expect(extractFirstArticleImage(content)).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(2_000);
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
