import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArticleScore } from "./ArticleScore";

describe("ArticleScore", () => {
  it("renders the authoritative score as non-interactive status", () => {
    const markup = renderToStaticMarkup(<ArticleScore score={128} />);

    expect(markup).toContain('aria-label="Article score: 128"');
    expect(markup).toContain("Score");
    expect(markup).toContain("128");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("aria-pressed");
  });
});
