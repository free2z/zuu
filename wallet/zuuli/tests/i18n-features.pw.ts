import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { MESSAGE_KEYS, type MessageKey } from "../src/i18n/messages";

type Locale = "en" | "es" | "fr";
function message(locale: Locale, key: MessageKey): string {
  let value: unknown = JSON.parse(
    readFileSync(
      new URL(`../src/i18n/locales/${locale}.json`, import.meta.url),
      "utf8",
    ),
  );
  for (const segment of key.split("."))
    value = (value as Record<string, unknown>)[segment];
  if (typeof value !== "string")
    throw new Error(`missing test catalog value: ${key}`);
  return value;
}
async function expectFrameToFit(page: Page) {
  const geometry = await page.locator("[data-app-frame]").evaluate((frame) =>
    [frame, ...frame.querySelectorAll("main, [data-route-scroll]")].map(
      (surface) => ({
        width: surface.clientWidth,
        scroll: surface.scrollWidth,
      }),
    ),
  );
  for (const surface of geometry)
    expect(surface.scroll).toBeLessThanOrEqual(surface.width + 1);
}

for (const locale of ["en", "es", "fr"] as const) {
  test(`${locale} covers the current Auth/Home/Wallet/About surfaces at 320px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      locale: locale === "fr" ? "es-ES" : locale,
      viewport: { width: 320, height: 568 },
    });
    if (locale === "fr")
      await context.addInitScript(() =>
        localStorage.setItem("free2z-locale", "fr-CA"),
      );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(
      page.getByText(message(locale, MESSAGE_KEYS.featuresHomeHeroYourVault), {
        exact: true,
      }),
    ).toBeVisible();
    await expectFrameToFit(page);
    await page.goto("/login");
    await page
      .getByRole("button", {
        name: message(locale, MESSAGE_KEYS.featuresAuthIndexPassword),
        exact: true,
      })
      .click();
    await expect(
      page.getByLabel(
        message(
          locale,
          MESSAGE_KEYS.featuresAuthClassicLoginFormEmailOrUsername,
        ),
      ),
    ).toBeVisible();
    await expectFrameToFit(page);
    await page.goto("/wallet/receive");
    await expect(
      page.getByText(
        message(locale, MESSAGE_KEYS.featuresWalletReceiveReceiveZEC),
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: message(
          locale,
          MESSAGE_KEYS.featuresWalletReceiveCopyUnifiedAddress,
        ),
      }),
    ).toBeVisible();
    await expectFrameToFit(page);
    await page.goto("/wallet/send");
    await expect(
      page.getByLabel(
        message(locale, MESSAGE_KEYS.featuresWalletSendRecipientAddress),
      ),
    ).toBeVisible();
    await expect(
      page.getByLabel(message(locale, MESSAGE_KEYS.featuresWalletSendAmount), {
        exact: true,
      }),
    ).toHaveAttribute("placeholder", "0.00");
    await expectFrameToFit(page);
    await page.goto("/wallet/fund");
    await expect(
      page.getByText(
        message(locale, MESSAGE_KEYS.featuresWalletFundingBuyTabChooseAnAmount),
        { exact: true },
      ),
    ).toBeVisible();
    await expectFrameToFit(page);
    await page.goto("/about");
    await expect(
      page.getByRole("heading", {
        name: message(locale, MESSAGE_KEYS.libAboutCopyAboutFeedback),
        exact: true,
      }),
    ).toBeVisible();
    await expectFrameToFit(page);
    expect(errors).toEqual([]);
    await context.close();
  });
  test(`${locale} recovery counts follow ICU and keep seed entry local`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      locale,
      viewport: { width: 320, height: 568 },
    });
    await context.addInitScript(() =>
      localStorage.setItem("zuuli.mock.wallet-scenario", "empty"),
    );
    const page = await context.newPage();
    await page.goto("/wallet");
    await page
      .getByRole("tab", {
        name: message(locale, MESSAGE_KEYS.featuresWalletOnboardingRestore),
        exact: true,
      })
      .click();
    const phrase = page.getByLabel(
      message(locale, MESSAGE_KEYS.featuresWalletOnboardingRecoveryPhrase),
      { exact: true },
    );
    await phrase.fill("word");
    const one =
      locale === "en" ? "1 word" : locale === "es" ? "1 palabra" : "1 mot";
    await expect(page.getByText(one, { exact: true })).toBeVisible();
    await phrase.fill("word word");
    const two =
      locale === "en" ? "2 words" : locale === "es" ? "2 palabras" : "2 mots";
    await expect(page.getByText(two, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: message(
          locale,
          MESSAGE_KEYS.featuresWalletOnboardingRestoreWallet,
        )
          .replace(/<[^>]*>/g, "")
          .trim(),
        exact: true,
      }),
    ).toBeDisabled();
    await context.close();
  });
}

// Test the active instance directly; this adds no shipping language selector.
async function changeMountedLanguage(page: Page, locale: Locale) {
  await page.evaluate(async (language) => {
    const dependency = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => /\/react-i18next\.js(?:\?|$)/.test(name));
    if (!dependency) throw new Error("react-i18next dependency was not loaded");
    const { getI18n } = await import(dependency);
    const runtimePath = "/src/i18n/index.ts";
    const { loadCatalog } = await import(runtimePath);
    const instance = getI18n();
    instance.addResourceBundle(
      language,
      "translation",
      await loadCatalog(language),
    );
    await instance.changeLanguage(language);
  }, locale);
}

test("mounted Home, Auth, Overview and Send react to language changes without reloading", async ({
  page,
}) => {
  for (const [route, key] of [
    ["/", MESSAGE_KEYS.featuresHomeHeroYourVault],
    ["/login", MESSAGE_KEYS.featuresAuthClassicLoginFormEmailOrUsername],
    ["/wallet", MESSAGE_KEYS.featuresWalletOverviewSpendableBalance],
    ["/wallet/send", MESSAGE_KEYS.featuresWalletSendRecipientAddress],
  ] as const) {
    await page.goto(route);
    if (route === "/login")
      await page.getByRole("button", { name: "Password", exact: true }).click();
    await expect(
      page.getByText(message("en", key), { exact: true }),
    ).toBeVisible();
    const frame = page.locator("[data-app-frame]");
    await frame.evaluate((element) =>
      element.setAttribute("data-live-locale-mount", "preserved"),
    );
    if (route === "/wallet/send")
      await page.getByLabel("Memo (optional)").fill("unchanged private draft");
    for (const language of ["es", "fr", "en"] as const) {
      await changeMountedLanguage(page, language);
      await expect(
        page.getByText(message(language, key), { exact: true }),
      ).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await expect(frame).toHaveAttribute(
        "data-live-locale-mount",
        "preserved",
      );
      if (route === "/wallet/send") {
        const memo = page.locator("label[for='memo']");
        await expect(memo).toHaveText(
          message(
            language,
            MESSAGE_KEYS.featuresWalletSendMemoOptional,
          ).replace(/<[^>]*>/g, ""),
        );
        await expect(memo.locator("span")).toBeVisible();
        await expect(page.locator("#memo")).toHaveValue(
          "unchanged private draft",
        );
        await expect(page.locator("#amount")).toHaveAttribute(
          "placeholder",
          "0.00",
        );
      }
    }
  }
});
