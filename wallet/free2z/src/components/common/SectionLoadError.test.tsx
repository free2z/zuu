import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { SectionLoadError } from "./SectionLoadError";
import { TestI18nProvider } from "@/i18n/test-provider";

function renderSection(error: React.ReactNode, locale: "en" | "es" = "en") {
  return renderToStaticMarkup(
    <TestI18nProvider locale={locale}>{error}</TestI18nProvider>,
  );
}

function retryButtonText(markup: string): string | null {
  const { document } = parseHTML(markup);
  return document.querySelector("button")?.textContent.trim() ?? null;
}

describe("SectionLoadError", () => {
  it("renders an actionable initial failure instead of empty-state copy", () => {
    const markup = renderSection(
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
    const markup = renderSection(
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

  it.each([
    [false, "Retry", "Reintentar"],
    [true, "Retrying", "Reintentando"],
  ] as const)(
    "renders the retry action from the active catalog when retrying is %s",
    (retrying, english, spanish) => {
      const error = (
        <SectionLoadError
          title="Failure"
          description="Try again."
          retry={vi.fn()}
          retrying={retrying}
        />
      );

      expect(retryButtonText(renderSection(error, "en"))).toBe(english);
      expect(retryButtonText(renderSection(error, "es"))).toBe(spanish);
    },
  );
});
