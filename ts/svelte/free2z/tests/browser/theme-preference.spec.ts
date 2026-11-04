import { expect, test } from "@playwright/test";

for (const saved of [null, "system", "light", "dark"] as const) {
  for (const device of ["none", "light", "dark"] as const) {
    test(`theme respects saved ${saved ?? "unset"} and device ${device} before and after hydration`, async ({
      page,
    }) => {
      await page.addInitScript(
        ({ saved, device }) => {
          if (saved) localStorage.setItem("mode-watcher-mode", saved);
          else localStorage.removeItem("mode-watcher-mode");
          const native = window.matchMedia.bind(window);
          window.matchMedia = (query) => {
            const result = native(query);
            if (query.includes("prefers-color-scheme")) {
              Object.defineProperty(result, "matches", {
                value: device !== "none" && query.includes(device),
              });
            }
            return result;
          };
          (window as any).themeAtContentLoaded = undefined;
          document.addEventListener("DOMContentLoaded", () => {
            (window as any).themeAtContentLoaded =
              document.documentElement.classList.contains("dark");
          });
        },
        { saved, device },
      );
      await page.goto("/search");
      const dark =
        saved === "dark" ||
        ((saved === null || saved === "system") && device !== "light");
      await expect
        .poll(() => page.evaluate(() => (window as any).themeAtContentLoaded))
        .toBe(dark);
      await page.waitForFunction(() =>
        performance
          .getEntriesByType("resource")
          .some((entry) => entry.name.includes("mode-watcher")),
      );
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.documentElement.classList.contains("dark"),
          ),
        )
        .toBe(dark);
      await expect
        .poll(() =>
          page.evaluate(() => document.documentElement.style.colorScheme),
        )
        .toBe(dark ? "dark" : "light");
    });
  }
}
