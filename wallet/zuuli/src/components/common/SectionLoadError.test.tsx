import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SectionLoadError } from "./SectionLoadError";

describe("SectionLoadError", () => {
  it("renders an actionable initial failure instead of empty-state copy", () => {
    const markup = renderToStaticMarkup(
      <SectionLoadError
        title="Couldn't load transactions"
        description="Transaction history is temporarily unavailable."
        retry={vi.fn()}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Couldn&#x27;t load transactions");
    expect(markup).toContain("Retry");
    expect(markup).toContain("min-tap");
    expect(markup).toContain("break-words");
    expect(markup).not.toContain("No transactions");
  });

  it("announces retained data as stale and disables duplicate retries", () => {
    const markup = renderToStaticMarkup(
      <SectionLoadError
        title="Couldn't refresh transactions"
        description="Showing the last confirmed history."
        retry={vi.fn()}
        retrying
        stale
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Showing the last confirmed history.");
    expect(markup).toContain("Retrying");
    expect(markup).toContain("disabled");
  });
});
