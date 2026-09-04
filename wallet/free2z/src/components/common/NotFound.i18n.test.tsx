import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TestI18nProvider } from "@/i18n/test-provider";
import es from "@/i18n/locales/es.json";
import { NotFound } from "./NotFound";

function renderSpanishNotFound(
  catalog: Readonly<Record<string, unknown>> = es,
) {
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <TestI18nProvider catalog={catalog} locale="es">
        <NotFound />
      </TestI18nProvider>
    </MemoryRouter>,
  );
  return parseHTML(`<html><body>${markup}</body></html>`).document;
}

describe("NotFound localization", () => {
  it("renders its complete visible Spanish output from the active catalog", () => {
    const document = renderSpanishNotFound();
    const link = document.querySelector("a[href='/']");

    expect(document.querySelector(".font-semibold")?.textContent).toBe(
      "Página no encontrada",
    );
    expect(document.querySelector("p.max-w-sm")?.textContent).toBe(
      "Esta página no existe o se ha movido. Vamos a orientarte de nuevo.",
    );
    expect(link?.textContent).toBe("Volver a Artículos");
    expect(link?.getAttribute("aria-label")).toBe("Volver a Artículos");
    expect(document.body.textContent).not.toContain("Page not found");
  });

  it.each([
    ["title", ".font-semibold", "MUTATED SPANISH TITLE"],
    ["description", "p.max-w-sm", "MUTATED SPANISH DESCRIPTION"],
    ["back", "a[href='/']", "MUTATED SPANISH BACK LINK"],
  ] as const)(
    "proves the mounted %s comes from the active Spanish catalog",
    (field, selector, sentinel) => {
      const catalog = {
        ...es,
        error: {
          ...es.error,
          notFound: { ...es.error.notFound, [field]: sentinel },
        },
      };
      const document = renderSpanishNotFound(catalog);

      expect(document.querySelector(selector)?.textContent).toBe(sentinel);
      if (field === "back") {
        expect(document.querySelector(selector)?.getAttribute("aria-label")).toBe(
          sentinel,
        );
      }
    },
  );
});
