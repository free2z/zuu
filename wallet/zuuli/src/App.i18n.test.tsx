import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TestI18nProvider } from "@/i18n/test-provider";
import { RouteFallback } from "@/components/common/RouteFallback";

describe("route loading fallback localization", () => {
  it("renders the selected catalog's loading label", () => {
    const markup = renderToStaticMarkup(
      <TestI18nProvider locale="es">
        <RouteFallback />
      </TestI18nProvider>,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Cargando"');
    expect(markup).not.toContain('aria-label="Loading"');
  });
});
