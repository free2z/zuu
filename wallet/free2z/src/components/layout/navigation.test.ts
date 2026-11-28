import { expect, it } from "vitest";
import { APP_ROUTES } from "../../lib/routes";
import { NAVIGATION, desktopNavigation } from "./navigation";

it("pins navigation to mounted routes and exposes diagnostics without sign-in", () => {
  const routes = new Set(Object.values(APP_ROUTES).map((r) => r.replace(/\/\*$/, "")));
  for (const item of NAVIGATION) expect(routes.has(item.to)).toBe(true);
  for (const signedIn of [false, true]) {
    expect(desktopNavigation(signedIn).some((r) => r.to === APP_ROUTES.diagnostics)).toBe(true);
  }
});
