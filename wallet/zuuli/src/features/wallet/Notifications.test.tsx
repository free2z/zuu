import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TestI18nProvider } from "@/i18n/test-provider";
import { Notifications } from "./Notifications";
describe("notification privacy consent", () => {
  it.each(["en", "es", "fr"] as const)("renders the owning %s privacy catalog", locale => {
    const html = renderToStaticMarkup(<TestI18nProvider locale={locale}><Notifications /></TestI18nProvider>);
    expect(html).not.toContain("notifications.");
    expect(html).toContain("Apple"); expect(html).toContain("Google"); expect(html).toContain("IP");
    expect(html).toContain("24"); expect(html).toContain("disabled");
    expect(html).not.toContain("<input");
  });
});
