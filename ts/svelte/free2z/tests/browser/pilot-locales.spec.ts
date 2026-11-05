import { expect, test } from "@playwright/test";
import drafts from "../pilot/drafts.json" with { type: "json" };
const enabled = process.env.FREE2Z_PILOT_TEST === "1";
test.skip(!enabled, "requires the test-only pilot build");
const pilots = [
  {
    code: "ar",
    dir: "rtl",
    username: "اسم المستخدم",
    balance: "رصيد الاستخدام",
  },
  {
    code: "pl",
    dir: "ltr",
    username: "Nazwa użytkownika",
    balance: "Środki na korzystanie",
  },
  { code: "ja", dir: "ltr", username: "ユーザー名", balance: "利用クレジット" },
  {
    code: "hi",
    dir: "ltr",
    username: "उपयोगकर्ता नाम",
    balance: "उपयोग क्रेडिट",
  },
  {
    code: "de",
    dir: "ltr",
    username: "Benutzername",
    balance: "Nutzungsguthaben",
  },
] as const;
for (const pilot of pilots)
  for (const width of [390, 1280]) {
    test(`${pilot.code} real draft journeys at ${width}px`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const response = await request.get(`/login?lang=${pilot.code}`);
      expect(await response.text()).toContain(
        `<html lang="${pilot.code}" dir="${pilot.dir}">`,
      );
      await page.goto(`/login?lang=${pilot.code}`);
      await expect(page.locator("html")).toHaveAttribute("dir", pilot.dir);
      await expect(
        page.getByText(pilot.username, { exact: true }).first(),
      ).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.locator(":focus")).toBeVisible();
      await page.context().addCookies([
        {
          name: "sessionid",
          value: "billing-fixture-session",
          domain: "127.0.0.1",
          path: "/",
        },
        {
          name: "free2z-locale",
          value: pilot.code,
          domain: "127.0.0.1",
          path: "/",
        },
      ]);
      await page.goto("/fixtureowner/dashboard/billing");
      await expect(page.getByTestId("billing-stats")).toBeVisible();
      await expect(
        page.getByText(pilot.balance, { exact: true }).first(),
      ).toBeVisible();
      await page.goto("/fixtureowner/dashboard/settings");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const editorPage = await page.context().newPage();
      await editorPage.goto("/edit");
      await expect(editorPage.getByTestId("editor-insert-trigger")).toBeVisible(
        { timeout: 15000 },
      );
      await expect(editorPage.locator("html")).toHaveAttribute(
        "lang",
        pilot.code,
      );
      await expect
        .poll(() =>
          editorPage.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        )
        .toBe(true);
      await editorPage.close();
    });
  }
test("pilot translator uses locale plural, ordinal and select rules on switch", async ({
  page,
}) => {
  await page.goto("/healthz");
  await page.evaluate(async () => {
    const target = document.createElement("main");
    document.body.append(target);
    const p = "/tests/browser/pilot-icu-fixture.svelte";
    const m = "/tests/browser/svelte-mount.ts";
    const fixture = await import(/* @vite-ignore */ p);
    const { mount } = await import(/* @vite-ignore */ m);
    mount(fixture.default, { target });
  });
  async function switchTo(code: string, text: string) {
    await expect(async () => {
      await page
        .getByRole("button", { name: code, exact: true })
        .last()
        .click();
      await expect(page.getByTestId("pilot-icu")).toContainText(text, {
        timeout: 2000,
      });
    }).toPass({ timeout: 15000 });
  }
  await switchTo("ar", "عنصران");
  await page.getByRole("button", { name: "zero", exact: true }).click();
  await expect(page.getByTestId("pilot-icu")).toContainText("لا عناصر");
  await page.getByRole("button", { name: "three", exact: true }).click();
  await expect(page.getByTestId("pilot-icu")).toContainText("عناصر");
  await page.getByRole("button", { name: "eleven", exact: true }).click();
  await expect(page.getByTestId("pilot-icu")).toContainText("عنصرًا");
  await switchTo("pl", "elementów");
  await page.getByRole("button", { name: "three", exact: true }).click();
  await expect(page.getByTestId("pilot-icu")).toContainText("elementy");
  for (const [locale, text] of [
    ["ja", "件"],
    ["hi", "वस्तुएँ"],
    ["de", "Elemente"],
  ] as const) {
    await switchTo(locale, text);
    const formatted = await page.evaluate(
      (code) => new Intl.NumberFormat(code).format(1234.5),
      locale,
    );
    await expect(page.getByTestId("pilot-number")).toHaveText(formatted);
  }
});

test("concurrent pilot account-deletion renders stay isolated", async ({
  request,
}) => {
  const titles = [
    "حذف حسابك في Free2Z",
    "Usuń swoje konto Free2Z",
    "Free2Zアカウントを削除",
    "अपना Free2Z खाता मिटाएँ",
    "Dein Free2Z-Konto löschen",
  ];
  const html = await Promise.all(
    pilots.map(async ({ code }) =>
      (await request.get(`/account/delete?lang=${code}`)).text(),
    ),
  );
  for (const [index, pilot] of pilots.entries()) {
    expect(html[index]).toContain(
      `<html lang="${pilot.code}" dir="${pilot.dir}">`,
    );
    expect(html[index]).toContain(titles[index]);
    expect(html[index]).toContain(drafts["account.delete.content"][index]);
  }
});

test("real external-content privacy warning uses each pilot draft", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  for (const [index, pilot] of pilots.entries()) {
    await context.addCookies([
      {
        name: "free2z-locale",
        value: pilot.code,
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    await page.goto("/audio-preload-user/audio-preload-fixture");
    await expect(
      page
        .getByText(drafts["privacy.embedWarningShort"][index], { exact: true })
        .first(),
    ).toBeVisible({ timeout: 15000 });
  }
});
