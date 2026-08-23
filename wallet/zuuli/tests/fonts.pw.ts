import { expect, test } from "@playwright/test";

test("bundled IBM Plex faces load and are applied", async ({ page }) => {
  await page.goto("/");

  const numeral = page.locator(".numeral").first();
  await expect(numeral).toBeVisible();

  const typography = await numeral.evaluate(async (element) => {
    async function loaded(font: string, sample: string) {
      try {
        const faces = await document.fonts.load(font, sample);
        return (
          faces.length > 0 &&
          faces.every((face) => face.status === "loaded") &&
          document.fonts.check(font, sample)
        );
      } catch {
        return false;
      }
    }

    function primaryFamily(element: Element) {
      return getComputedStyle(element).fontFamily
        .split(",", 1)[0]
        .trim()
        .replace(/^['"]|['"]$/g, "");
    }

    const [sansLoaded, ...monoWeightsLoaded] = await Promise.all([
      loaded('400 16px "IBM Plex Sans Variable"', "ZUULI"),
      ...[400, 500, 600].map((weight) =>
        loaded(`${weight} 16px "IBM Plex Mono"`, "0123456789"),
      ),
    ]);

    return {
      bodyPrimaryFamily: primaryFamily(document.body),
      monoPrimaryFamily: primaryFamily(element),
      sansLoaded,
      monoLoaded: monoWeightsLoaded.every(Boolean),
    };
  });

  expect(typography.sansLoaded, "the bundled Plex Sans face must load").toBe(true);
  expect(typography.bodyPrimaryFamily, "Plex Sans must be applied to body text").toBe(
    "IBM Plex Sans Variable",
  );
  expect(typography.monoLoaded, "the bundled Plex Mono face must load").toBe(true);
  expect(typography.monoPrimaryFamily, "Plex Mono must be applied to numerals").toBe(
    "IBM Plex Mono",
  );
});
