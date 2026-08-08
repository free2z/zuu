import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Markdown, type MarkdownVariant } from "./Markdown";

/**
 * `MarkdownLink` calls `useNavigate()`, so every render needs a router in
 * context (the comment variant routes images through it).
 */
function render(source: string, variant: MarkdownVariant): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Markdown variant={variant}>{source}</Markdown>
    </MemoryRouter>,
  );
}

const IMAGE = "![alt text](https://example.com/y.png)";

/**
 * The ErrorBoundary fallback is the raw source in a `whitespace-pre-wrap` div.
 * (Under `renderToStaticMarkup` an error boundary does not catch at all — the
 * throw propagates and fails the test outright — so this asserts the fallback
 * is absent in the client-render case too, without weakening the check.)
 */
function expectNoErrorFallback(markup: string) {
  expect(markup).not.toContain("whitespace-pre-wrap");
  expect(markup).not.toContain("![alt text]");
}

describe("Markdown images", () => {
  it("renders a real <img> for the trusted article variant", () => {
    // Regression: the `components` map used to carry `img: undefined` for the
    // article variant. react-markdown resolves overrides by KEY PRESENCE, so
    // the element type became `undefined`, React threw "Element type is
    // invalid", the ErrorBoundary caught it, and every article containing an
    // image rendered as raw markdown source. See issue #319.
    const markup = render(IMAGE, "article");

    expect(markup).toContain("<img");
    expect(markup).toContain('src="https://example.com/y.png"');
    expect(markup).toContain('alt="alt text"');
    expectNoErrorFallback(markup);
  });

  it("degrades an image to a plain link for the untrusted comment variant", () => {
    // Privacy: an untrusted comment must never auto-load a remote image, which
    // would beacon the reader's IP to an attacker-chosen host on render.
    const markup = render(IMAGE, "comment");

    expect(markup).not.toContain("<img");
    expect(markup).toContain('href="https://example.com/y.png"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("alt text");
    expectNoErrorFallback(markup);
  });
});
