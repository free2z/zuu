import { expect, test } from "@playwright/test";
import { browserAppOrigin } from "./ports";

test("currency, units and exact assets follow browser locale switching", async ({
  page,
}) => {
  await page.goto("about:blank");
  for (const path of [
    "/tests/browser/formatting-fixture.svelte",
    "/tests/browser/svelte-mount.ts",
  ])
    expect(
      (
        await page.request.get(new URL(path, browserAppOrigin()).toString())
      ).ok(),
    ).toBeTruthy();
  await page.goto("/search");
  await page.evaluate(async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const fixturePath = "/tests/browser/formatting-fixture.svelte",
      mountPath = "/tests/browser/svelte-mount.ts";
    const fixture = await import(/* @vite-ignore */ fixturePath);
    const { mount } = await import(/* @vite-ignore */ mountPath);
    mount(fixture.default, { target: root });
  });
  for (const [button, locale] of [
    ["English", "en"],
    ["Français", "fr"],
  ]) {
    await page
      .getByRole("button", { name: button, exact: true })
      .last()
      .click();
    await expect(page.getByTestId("currency")).toHaveText(
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
      }).format(1234.56),
    );
    await expect(page.getByTestId("unit")).toHaveText(
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "megabyte",
        unitDisplay: "short",
        maximumFractionDigits: 1,
      }).format(1.5),
    );
    await expect(page.getByTestId("activity-date")).toHaveText(
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date("2026-10-11T18:55:00Z")),
    );
    await expect(page.getByTestId("notification-count")).toHaveText(
      new Intl.NumberFormat(locale).format(1234),
    );
    await expect(page.getByTestId("language-name")).toHaveText(
      new Intl.DisplayNames([locale, "en"], {
        type: "language",
        fallback: "none",
      }).of("ja")!,
    );
    await expect(page.getByTestId("media-size")).toHaveText(
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "megabyte",
        unitDisplay: "short",
        maximumFractionDigits: 1,
      }).format(1.5),
    );
    await expect(page.getByTestId("asset")).toHaveText(
      `${new Intl.NumberFormat(locale, { maximumFractionDigits: 8 }).format(0.00000001)} ZEC`,
    );
  }
});

test("old decimal-string engines retain exact fixed-point values", async ({
  page,
}) => {
  await page.goto("/search");
  const result = await page.evaluate(async () => {
    const path = "/src/lib/i18n.ts";
    const i18n = await import(/* @vite-ignore */ path);
    const original = Intl.NumberFormat;
    const replacement = function (
      locale: string,
      options: Intl.NumberFormatOptions,
    ) {
      const formatter = new original(locale, options);
      const format = formatter.format;
      Object.defineProperty(formatter, "format", {
        value: (value: string | number | bigint) =>
          format(typeof value === "string" ? Number(value) : value),
      });
      return formatter;
    };
    Object.defineProperty(Intl, "NumberFormat", {
      value: replacement,
      configurable: true,
      writable: true,
    });
    try {
      return [
        i18n.formatCurrencyMinor(90071992547409931n, 2, "USD", "en"),
        i18n.formatCurrencyMajor(12.5, "USD", "en"),
        i18n.formatScaledAsset(123456789n, 8, "ZEC", "en"),
      ];
    } finally {
      Object.defineProperty(Intl, "NumberFormat", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
  expect(result).toEqual([
    "$900,719,925,474,099.31",
    "$12.50",
    "1.23456789 ZEC",
  ]);
});
