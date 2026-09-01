import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RouteScrollContextProvider } from "@/hooks/useRouteScroll";
import { TestI18nProvider } from "@/i18n/test-provider";

const controls = vi.hoisted(() => ({ signedIn: false }));
vi.mock("@/store/session", () => ({
  useSession: (selector: (state: { user: { username: string } | null }) => unknown) =>
    selector({
      user: controls.signedIn ? { username: "reviewed-user" } : null,
    }),
}));

import { Sidebar } from "./Sidebar";

function renderSpanishSidebar(signedIn: boolean) {
  controls.signedIn = signedIn;
  const markup = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <TestI18nProvider locale="es">
        <RouteScrollContextProvider
          value={{
            registerViewport() {},
            scrollToTop() {},
            viewport: null,
          }}
        >
          <Sidebar />
        </RouteScrollContextProvider>
      </TestI18nProvider>
    </MemoryRouter>,
  );
  return parseHTML(markup).document;
}

describe("Sidebar localization", () => {
  it.each([
    [
      false,
      [
        ["/", "Inicio"],
        ["/live", "Transmisiones en vivo"],
        ["/articles", "Artículos"],
        ["/ai", "IA"],
        ["/wallet", "Billetera"],
        ["/login", "Iniciar sesión"],
        ["/about", "Acerca de y comentarios"],
      ],
    ],
    [
      true,
      [
        ["/", "Inicio"],
        ["/live", "Transmisiones en vivo"],
        ["/articles", "Artículos"],
        ["/ai", "IA"],
        ["/messages", "Mensajes"],
        ["/wallet", "Billetera"],
        ["/profile", "Perfil"],
        ["/kyc", "Reparto de ingresos"],
        ["/about", "Acerca de y comentarios"],
      ],
    ],
  ] as const)(
    "renders the complete reviewed visible desktop label census when signedIn=%s",
    (signedIn, expected) => {
      const document = renderSpanishSidebar(signedIn);
      const actual = [...document.querySelectorAll("aside a")].map((link) => [
        link.getAttribute("href"),
        link.querySelector("span[aria-hidden]")?.textContent ?? null,
      ]);

      expect(actual).toEqual(expected);
    },
  );
});
