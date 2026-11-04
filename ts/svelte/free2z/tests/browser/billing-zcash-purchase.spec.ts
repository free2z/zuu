import { expect, test } from "@playwright/test";

const billing =
  "/fixtureowner/dashboard/billing?tab=zcash&checkoutRef=checkout-ref";

const method = {
  version: "zec-funding-v3",
  digest: "synthetic-v3-digest",
  text: "Credits use actual received ZEC after three confirmations at the current processing price, with no settlement spread. Estimates do not reserve a rate or impose a payment deadline.",
};
const capabilities = {
  policy_version: 1,
  active: true,
  creator_compensation_available: true,
  zec_funding_method: method,
};

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-11T18:55:01Z") });
  await page.route("**/api/economy/funding-resolutions/**", (route) =>
    route.fulfill({
      json: {
        actor_id: 4301,
        results: [],
        zec_funding_capacity: {
          as_of: "2026-10-11T18:55:00Z",
          remaining_m2z: "200000000",
          remaining_sale_nusd: "10000000000000",
        },
      },
    }),
  );
  await page.route("**/api/pricing/", (route) =>
    route.fulfill({
      json: {
        zec_usd: "100.00",
        spread: "0.00",
        tuzis_per_zec: "10000.0000",
        estimate_buffer: "0.10",
        estimated_tuzis_per_zec: "9000.0000",
        tuzi_per_usd: 100,
        usd_per_tuzi: "0.01",
        num_sources: 2,
        sources: { synthetic: "100.00" },
        updated_at: "2026-10-11T18:55:00Z",
        stale: false,
        card: { percent_fee: "0.10", min_fee_cents: 50 },
      },
    }),
  );
  await page.route("**/api/economy/capabilities/", (route) =>
    route.fulfill({ json: capabilities }),
  );
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
});

test("mandatory memo is prominent before the exact wallet and clipboard handoff", async ({
  page,
}) => {
  await page.goto(billing);
  const notice = page.getByRole("note");
  await expect(notice).toContainText(
    "Memo required — no memo, no automatic 2Z credit.",
  );
  await expect(notice).toContainText("shared Free2Z address");
  await expect(notice).toContainText("must send this exact memo");
  await expect(notice).toContainText("check that your wallet’s memo field");
  await expect(notice).toContainText("shielded payment");
  await expect(notice).toContainText("Do not send from an exchange");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  const open = page.getByRole("link", { name: "Open in Wallet" });
  await expect(open).toHaveAttribute("aria-describedby", "zcash-memo-required");
  expect(
    await open.evaluate((element) =>
      Boolean(
        document
          .querySelector("#zcash-memo-required")!
          .compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
  ).toBe(true);
  const uri = await open.getAttribute("href");
  const params = new URLSearchParams(uri!.split("?")[1]);
  const exactMemo = '{"act":"buy_2z","id":"fixtureowner"}';
  expect(Buffer.from(params.get("memo")!, "base64url").toString("utf8")).toBe(
    exactMemo,
  );
  await expect(notice).toContainText(exactMemo);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as any).copiedPurchaseUri = value;
        },
      },
    });
  });
  await page.getByRole("button", { name: "Copy URI" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).copiedPurchaseUri))
    .toBe(uri);
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
});

test("clearing or invalidating the amount disables sends and removes the previous QR", async ({
  page,
}) => {
  await page.goto(billing);
  const qr = page.getByRole("img", { name: "Zcash payment QR code" });
  await expect(qr).toBeVisible();
  const amount = page.locator("#zcash-amount");
  for (const invalid of ["", "0", "-1"]) {
    await amount.fill(invalid);
    await expect(
      page.getByRole("button", { name: "Open in Wallet" }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
    await expect(qr).toHaveCount(0);
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "required memo can be included" }),
    ).toBeVisible();
  }
  await amount.fill("100");
  await expect(qr).toBeVisible();
  // Exercise invalidation while another asynchronous QR is being generated.
  await amount.fill("101");
  await amount.fill("0");
  await expect(qr).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
});

test("a memo encoder failure cannot become a memo-less payment or QR", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.btoa = () => {
      throw new Error("encoding unavailable");
    };
  });
  await page.goto(billing);
  await expect(
    page.getByRole("button", { name: "Open in Wallet" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
});

test("active policy uses a two-field memo, estimates, and complete terms without creating an intent", async ({
  page,
}) => {
  let posts = 0;
  await page.route("**/api/sdk/v1/purchases**", (route) => {
    posts++;
    return route.abort();
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(billing);
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Credits & Earnings", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("zcash-funding-capacity")).toHaveCount(0);
  await expect(
    page.getByText("Buy 2Z with Zcash", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Low-fee Zcash payments", { exact: true }),
  ).toHaveCount(0);
  for (const [locale, heading, label] of [
    ["en", "Credits & Earnings", "Credits"],
    ["es", "Créditos y ganancias", "Créditos"],
    ["fr", "Crédits et revenus", "Crédits"],
    ["pt-BR", "Créditos e ganhos", "Créditos"],
  ]) {
    await page.evaluate(async (locale) => {
      const modulePath = "/src/lib/i18n.ts";
      const { setLocale } = await import(modulePath);
      setLocale(locale);
    }, locale);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await page.getByTestId("navbar-profile-trigger").click();
    await expect(
      page.getByRole("menuitem", { name: label, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await page.evaluate(async () => {
    const modulePath = "/src/lib/i18n.ts";
    const { setLocale } = await import(modulePath);
    setLocale("en");
  });
  await expect(page.getByTestId("zcash-estimate-disclosure")).toContainText(
    "three confirmations",
  );
  await expect(page.getByTestId("zcash-estimate-disclosure")).toContainText(
    "not a guaranteed minimum",
  );
  await expect(page.getByTestId("zcash-estimate-disclosure")).toContainText(
    "Wallet and network fees are separate",
  );
  await expect(page.getByTestId("zcash-estimate-disclosure")).toContainText(
    "You’ll likely receive more 2Z",
  );
  await page.getByTestId("zcash-funding-terms").locator("summary").click();
  await expect(page.getByTestId("zcash-funding-terms")).toContainText(
    method.text,
  );
  await expect(
    page.getByRole("link", { name: "Full usage-credit purchase terms" }),
  ).toHaveAttribute("href", "/docs/legal/token-sale-and-usage-terms");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByText("Reserve Zcash quote")).toHaveCount(0);
  await expect(page.getByLabel("Estimated credits (2Z)")).toHaveValue("2500");
  const price = page.getByTestId("zcash-price-estimate");
  await expect(price).toContainText("Estimate buffer: 10%");
  await expect(price).toContainText(
    "Free2Z currently charges no Zcash purchase fee or spread",
  );
  await expect(price).toContainText("ZEC ≈ $100");
  await expect(price.locator("time")).toHaveAttribute(
    "datetime",
    "2026-10-11T18:55:00Z",
  );
  const uri = await page
    .getByRole("link", { name: "Open in Wallet" })
    .getAttribute("href");
  expect(new URL(uri!).searchParams.get("amount")).toBe("0.27777778");
  expect(posts).toBe(0);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) => key.includes(":funding")),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

for (const policy of [
  { ...capabilities, policy_version: 2 },
  { ...capabilities, active: false },
  {
    ...capabilities,
    zec_funding_method: { ...method, version: "zec-funding-v2" },
  },
]) {
  test(`unsupported funding ${JSON.stringify(policy)} never exposes a payment request`, async ({
    page,
  }) => {
    await page.route("**/api/economy/capabilities/", (route) =>
      route.fulfill({ json: policy }),
    );
    await page.goto(billing);
    await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Open in Wallet" }),
    ).toHaveCount(0);
  });
}

test("an open billing tab removes payment instructions when funding is disabled", async ({
  page,
}) => {
  let active = true;
  await page.route("**/api/economy/capabilities/", (route) =>
    route.fulfill({ json: { ...capabilities, active } }),
  );
  await page.goto(billing);
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  active = false;
  await page.clock.runFor(15001);
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
});

test("clipboard fresh authentication refuses a switched account and removes its stale QR", async ({
  page,
}) => {
  await page.goto(billing);
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as any).copiedPurchaseUri = value;
        },
      },
    }),
  );
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      json: { id: 4302, username: "other-synthetic-account", tuzis: "0.000" },
    }),
  );
  await page.getByRole("button", { name: "Copy URI" }).click();
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).copiedPurchaseUri),
  ).toBeUndefined();
});

test("changing the amount during fresh authentication cannot copy the prior URI", async ({
  page,
}) => {
  await page.goto(billing);
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as any).copiedPurchaseUri = value;
        },
      },
    }),
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  await page.route("**/api/auth/user/", async (route) => {
    entered = true;
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "Copy URI" }).click();
  await expect.poll(() => entered).toBe(true);
  await page.locator("#zcash-amount").fill("1234");
  release();
  await expect(
    page.getByRole("alert").filter({ hasText: "Failed to copy" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).copiedPurchaseUri),
  ).toBeUndefined();
});

for (const authorize of [true, false]) {
  test(`promised clipboard starts in the gesture and ${authorize ? "copies only the verified" : "refuses an unverified"} payment instruction`, async ({
    page,
  }) => {
    await page.goto(billing);
    const uri = await page
      .getByRole("link", { name: "Open in Wallet" })
      .getAttribute("href");
    await page.evaluate(() => {
      (window as any).clipboardOriginal = "unchanged";
      (window as any).ClipboardItem = class {
        constructor(public representations: any) {}
      };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          write: async (items: any[]) => {
            (window as any).clipboardGesture =
              navigator.userActivation.isActive;
            const content = await items[0].representations["text/plain"];
            (window as any).clipboardOriginal = await content.text();
          },
        },
      });
    });
    await page.route("**/api/auth/user/", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return authorize
        ? route.continue()
        : route.fulfill({ status: 503, json: { detail: "Unavailable" } });
    });
    await page.getByRole("button", { name: "Copy URI" }).click();
    if (authorize)
      await expect
        .poll(() => page.evaluate(() => (window as any).clipboardOriginal))
        .toBe(uri);
    else {
      await expect(
        page.getByRole("alert").filter({ hasText: "Failed to copy" }),
      ).toBeVisible();
      expect(await page.evaluate(() => (window as any).clipboardOriginal)).toBe(
        "unchanged",
      );
    }
    expect(await page.evaluate(() => (window as any).clipboardGesture)).toBe(
      true,
    );
  });
}

for (const switchedAccount of [false, true]) {
  test(`a fresh policy response cannot authorize handoff after ${switchedAccount ? "an account switch" : "funding is disabled"}`, async ({
    page,
  }) => {
    await page.goto(billing);
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            (window as any).copiedPurchaseUri = value;
          },
        },
      }),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/api/economy/capabilities/", async (route) => {
      requested = true;
      await held;
      await route.fulfill({
        json: { ...capabilities, active: switchedAccount },
      });
    });
    await page.getByRole("button", { name: "Copy URI" }).click();
    await expect.poll(() => requested).toBe(true);
    if (switchedAccount) {
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        (await import(module)).authStore.hydrateFromSession({
          id: 4302,
          username: "other-synthetic-account",
          tuzis: "0.000",
        });
      });
    }
    release();
    await expect(
      page.getByRole("alert").filter({ hasText: "Failed to copy" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => (window as any).copiedPurchaseUri),
    ).toBeUndefined();
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toHaveCount(0);
  });
}

test("a delayed QR generation cannot restore a payment request for another signed-in account", async ({
  page,
}) => {
  let qrModuleUrl = "";
  page.on("response", (response) => {
    if (response.url().includes("/qrcode.js")) qrModuleUrl = response.url();
  });
  await page.goto(billing);
  const qr = page.getByRole("img", { name: "Zcash payment QR code" });
  await expect(qr).toBeVisible();
  await expect.poll(() => qrModuleUrl).not.toBe("");
  await page.evaluate(async (moduleUrl) => {
    const { default: QRCode } = await import(moduleUrl);
    const original = QRCode.toDataURL;
    QRCode.toDataURL = (...args: any[]) =>
      new Promise((resolve, reject) => {
        (window as any).qrGenerationWaiting = true;
        (window as any).releaseQrGeneration = () =>
          original(...args).then(resolve, reject);
      });
  }, qrModuleUrl);
  await page.locator("#zcash-amount").fill("1234");
  await expect
    .poll(() => page.evaluate(() => (window as any).qrGenerationWaiting))
    .toBe(true);
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    (await import(module)).authStore.hydrateFromSession({
      id: 4302,
      username: "other-synthetic-account",
      tuzis: "0.000",
    });
    (window as any).releaseQrGeneration();
  });
  await expect(qr).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
});

test("unavailable payment instructions recover after retrying a transient authentication failure", async ({
  page,
}) => {
  let available = false;
  await page.route("**/api/auth/user/", (route) =>
    available
      ? route.continue()
      : route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  await page.goto(billing);
  const retry = page.getByRole("button", {
    name: "Retry payment instructions",
  });
  await expect(retry).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
  available = true;
  await retry.click();
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeEnabled();
});

test("a price refresh updates the conservative amount and its visible timestamp", async ({
  page,
}) => {
  let updated = false;
  await page.route("**/api/pricing/", (route) =>
    route.fulfill({
      json: {
        zec_usd: updated ? "200.00" : "100.00",
        spread: "0.00",
        tuzis_per_zec: updated ? "20000.0000" : "10000.0000",
        estimate_buffer: "0.10",
        estimated_tuzis_per_zec: updated ? "18000.0000" : "9000.0000",
        tuzi_per_usd: 100,
        usd_per_tuzi: "0.01",
        num_sources: 2,
        sources: { synthetic: updated ? "200.00" : "100.00" },
        updated_at: updated ? "2026-10-11T18:55:45Z" : "2026-10-11T18:55:00Z",
        stale: false,
        card: { percent_fee: "0.10", min_fee_cents: 50 },
      },
    }),
  );
  await page.goto(billing);
  const wallet = page.getByRole("link", { name: "Open in Wallet" });
  await expect(wallet).toHaveAttribute("href", /amount=0\.27777778/);
  updated = true;
  await page.clock.runFor(45001);
  await expect(wallet).toHaveAttribute("href", /amount=0\.13888889/);
  await expect(page.getByTestId("zcash-price-estimate")).toContainText(
    "Current market price: ZEC ≈ $200",
  );
  await expect(
    page.getByTestId("zcash-price-estimate").locator("time"),
  ).toHaveAttribute("datetime", "2026-10-11T18:55:45Z");
  const memo = new URL((await wallet.getAttribute("href"))!).searchParams.get(
    "memo",
  )!;
  expect(Buffer.from(memo, "base64url").toString("utf8")).toBe(
    '{"act":"buy_2z","id":"fixtureowner"}',
  );
});

function promoPrice(
  options: {
    code?: string;
    multiplier?: string;
    title?: string;
    endsAt?: string;
    status?: "none" | "active" | "unavailable";
  } = {},
) {
  const multiplier = options.multiplier || "1";
  return {
    zec_usd: "100.00",
    spread: "0.00",
    tuzis_per_zec: String(10000 * Number(multiplier)),
    estimate_buffer: "0.10",
    estimated_tuzis_per_zec: String(9000 * Number(multiplier)),
    tuzi_per_usd: 100,
    usd_per_tuzi: "0.01",
    num_sources: 2,
    sources: { synthetic: "100.00" },
    updated_at: "2026-10-11T18:55:00Z",
    stale: false,
    card: { percent_fee: "0.10", min_fee_cents: 50 },
    zec_promotion: {
      code_status: options.status || (options.code ? "active" : "none"),
      requested_code: options.code || null,
      multiplier,
      title: options.title || null,
      ends_at: options.endsAt || null,
      code: options.code || null,
    },
  };
}

function decodedMemo(uri: string): string {
  return Buffer.from(
    new URL(uri).searchParams.get("memo")!,
    "base64url",
  ).toString("utf8");
}

test("a global offer is previewed with server rates and keeps the exact two-field memo", async ({
  page,
}) => {
  await page.route("**/api/pricing/", (route) =>
    route.fulfill({
      json: promoPrice({
        multiplier: "2",
        title: "Launch offer",
        endsAt: "2026-10-12T00:00:00Z",
      }),
    }),
  );
  await page.goto(billing);
  const wallet = page.getByRole("link", { name: "Open in Wallet" });
  await expect(wallet).toHaveAttribute("href", /amount=0\.13888889/);
  const offer = page.getByTestId("zcash-promotion");
  await expect(offer).toContainText("Launch offer · 2×");
  await expect(offer).toContainText(
    "active when your confirmed payment is processed",
  );
  await expect(offer).toContainText("never locks a bonus or rate");
  expect(decodedMemo((await wallet.getAttribute("href"))!)).toBe(
    '{"act":"buy_2z","id":"fixtureowner"}',
  );
});

test("an optional code uses the server's highest offer without client-side stacking", async ({
  page,
}) => {
  await page.route("**/api/pricing/**", (route) => {
    const code =
      new URL(route.request().url()).searchParams.get("promo") || undefined;
    return route.fulfill({
      json: promoPrice(
        code
          ? { code, multiplier: "3", title: "Code offer" }
          : { multiplier: "2", title: "Global offer" },
      ),
    });
  });
  await page.goto(billing);
  await expect(
    page.getByRole("link", { name: "Open in Wallet" }),
  ).toBeVisible();
  await page.getByLabel("Promo code (optional)").fill(" zodl ");
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
  await page.getByTestId("zcash-promo-apply").click();
  const wallet = page.getByRole("link", { name: "Open in Wallet" });
  await expect(wallet).toHaveAttribute("href", /amount=0\.09259260/);
  await expect(page.getByTestId("zcash-promotion")).toContainText(
    "Code offer · 3×",
  );
  await expect(page.getByTestId("zcash-promotion")).toContainText(
    "offers do not stack",
  );
  expect(decodedMemo((await wallet.getAttribute("href"))!)).toBe(
    '{"act":"buy_2z","id":"fixtureowner","promo":"ZODL"}',
  );
});

for (const globalMultiplier of ["1", "2"]) {
  test(`an unavailable code preserves ${globalMultiplier === "1" ? "standard" : "global-offer"} credit preview and payment handoff`, async ({
    page,
  }) => {
    await page.route("**/api/pricing/**", (route) => {
      const code =
        new URL(route.request().url()).searchParams.get("promo") || undefined;
      return route.fulfill({
        json: promoPrice({
          code,
          status: code ? "unavailable" : "none",
          multiplier: globalMultiplier,
          title: globalMultiplier === "2" ? "Global offer" : undefined,
        }),
      });
    });
    await page.goto(billing);
    await expect(
      page.getByRole("link", { name: "Open in Wallet" }),
    ).toBeVisible();
    await page.getByLabel("Promo code (optional)").fill("EXPIRED");
    await page.getByTestId("zcash-promo-apply").click();
    await expect(
      page.getByRole("status").filter({ hasText: "This code is unavailable" }),
    ).toBeVisible();
    const wallet = page.getByRole("link", { name: "Open in Wallet" });
    await expect(wallet).toHaveAttribute(
      "href",
      globalMultiplier === "1" ? /amount=0\.27777778/ : /amount=0\.13888889/,
    );
    expect(decodedMemo((await wallet.getAttribute("href"))!)).toBe(
      '{"act":"buy_2z","id":"fixtureowner","promo":"EXPIRED"}',
    );
  });
}

test("clearing a code defeats its late price response and restores the original memo", async ({
  page,
}) => {
  await page.goto(billing);
  await expect(
    page.getByRole("link", { name: "Open in Wallet" }),
  ).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  await page.route("**/api/pricing/**", async (route) => {
    const code =
      new URL(route.request().url()).searchParams.get("promo") || undefined;
    if (code) {
      entered = true;
      await held;
    }
    await route.fulfill({
      json: promoPrice(
        code ? { code, multiplier: "3", title: "Late code offer" } : {},
      ),
    });
  });
  await page.getByLabel("Promo code (optional)").fill("ZODL");
  await page.getByTestId("zcash-promo-apply").click();
  await expect.poll(() => entered).toBe(true);
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
  await page.getByLabel("Promo code (optional)").fill("");
  await page.getByTestId("zcash-promo-apply").click();
  const wallet = page.getByRole("link", { name: "Open in Wallet" });
  await expect(wallet).toHaveAttribute("href", /amount=0\.27777778/);
  release();
  await expect(page.getByTestId("zcash-promotion")).toHaveCount(0);
  expect(decodedMemo((await wallet.getAttribute("href"))!)).toBe(
    '{"act":"buy_2z","id":"fixtureowner"}',
  );
});

test("a late code preview cannot restore a payment request after an account switch", async ({
  page,
}) => {
  await page.goto(billing);
  await expect(
    page.getByRole("link", { name: "Open in Wallet" }),
  ).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  await page.route("**/api/pricing/?promo=ZODL", async (route) => {
    entered = true;
    await held;
    await route.fulfill({
      json: promoPrice({
        code: "ZODL",
        multiplier: "2",
        title: "Private draft offer",
      }),
    });
  });
  await page.getByLabel("Promo code (optional)").fill("ZODL");
  await page.getByTestId("zcash-promo-apply").click();
  await expect.poll(() => entered).toBe(true);
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    (await import(module)).authStore.hydrateFromSession({
      id: 4302,
      username: "other-synthetic-account",
      tuzis: "0.000",
    });
  });
  release();
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Promo code (optional)")).toHaveValue("");
  await expect(page.getByTestId("zcash-promotion")).toHaveCount(0);
});

test("an offer expiring in an open tab requires a current preview and can resume ordinary payments", async ({
  page,
}) => {
  let expired = false;
  await page.route("**/api/pricing/", (route) =>
    route.fulfill({
      json: expired
        ? promoPrice()
        : promoPrice({
            multiplier: "2",
            title: "Brief global offer",
            endsAt: "2026-10-11T18:56:00Z",
          }),
    }),
  );
  await page.goto(billing);
  const wallet = page.getByRole("link", { name: "Open in Wallet" });
  await expect(wallet).toHaveAttribute("href", /amount=0\.13888889/);
  await page.clock.runFor(61000);
  await expect(wallet).toHaveCount(0);
  await expect(page.getByTestId("zcash-promotion")).toContainText(
    "Expired offer preview",
  );
  expired = true;
  await page.getByRole("button", { name: "Refresh estimate" }).click();
  await expect(wallet).toHaveAttribute("href", /amount=0\.27777778/);
  expect(decodedMemo((await wallet.getAttribute("href"))!)).toBe(
    '{"act":"buy_2z","id":"fixtureowner"}',
  );
});

test("a mismatched polled code cannot replace the selected offer and memo", async ({
  page,
}) => {
  let codeRequests = 0;
  await page.route("**/api/pricing/**", (route) => {
    const code = new URL(route.request().url()).searchParams.get("promo");
    if (code) codeRequests++;
    return route.fulfill({
      json: code
        ? promoPrice({
            multiplier: codeRequests === 1 ? "2" : "3",
            code: codeRequests === 1 ? "ZODL" : "OTHER",
            title: codeRequests === 1 ? "Wallet offer" : "Wrong offer",
          })
        : promoPrice({}),
    });
  });
  await page.goto(billing);
  await page.getByLabel("Promo code (optional)").fill("zodl");
  await page.getByTestId("zcash-promo-apply").click();
  const wallet = page.getByRole("link", { name: "Open in Wallet" });
  await expect(wallet).toHaveAttribute("href", /amount=0\.13888889/);
  expect(decodedMemo((await wallet.getAttribute("href"))!)).toBe(
    '{"act":"buy_2z","id":"fixtureowner","promo":"ZODL"}',
  );
  await page.clock.fastForward(45000);
  await expect(page.getByTestId("zcash-promotion")).toContainText(
    "Unverified offer preview",
  );
  await expect(wallet).toHaveCount(0);
  await expect(page.getByTestId("zcash-promotion")).not.toContainText(
    "Wrong offer",
  );
});

test("an unavailable pricing snapshot cannot appear as a current NaN market price", async ({
  page,
}) => {
  await page.route("**/api/pricing/", (route) =>
    route.fulfill({
      json: { stale: false, updated_at: "invalid", zec_usd: "unknown" },
    }),
  );
  await page.goto(billing);
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
  await expect(
    page.getByText(
      "Waiting for current pricing to check your funding limits.",
      { exact: false },
    ),
  ).toBeVisible();
  const priceDisplay = page.getByTestId("zcash-price-estimate");
  await expect(priceDisplay).not.toContainText("NaN");
  await expect(priceDisplay).not.toContainText("Current market price");
  await expect(priceDisplay).not.toContainText("Last updated");
  await expect(
    page.getByText("Live price unavailable — this ZEC amount is an estimate.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("a conservative 200,000-credit estimate cannot exceed the current daily credit capacity", async ({
  page,
}) => {
  await page.goto(billing);
  const amount = page.getByLabel("Estimated credits (2Z)");
  await expect(
    page.getByRole("link", { name: "Open in Wallet" }),
  ).toHaveAttribute("href", /^zcash:/);
  await amount.fill("200000");
  await expect(page.getByTestId("zcash-funding-capacity")).toContainText(
    "222,222.223 2Z",
  );
  await expect(page.getByTestId("zcash-funding-capacity")).toContainText(
    "This account’s purchase limits",
  );
  await expect(page.getByTestId("zcash-funding-capacity")).toContainText(
    "Your opening balance, incoming credits and pending funding count toward the credit limit",
  );
  await expect(page.getByTestId("zcash-funding-capacity")).toContainText(
    "This payment exceeds",
  );
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
  await amount.fill("1000");
  const wallet = page.getByRole("link", { name: "Open in Wallet" });
  await expect(wallet).toHaveAttribute("href", /^zcash:/);
  expect(decodedMemo((await wallet.getAttribute("href"))!)).toBe(
    '{"act":"buy_2z","id":"fixtureowner"}',
  );
});

test("the purchaser USD limit suppresses a known over-capacity payment", async ({
  page,
}) => {
  await page.route("**/api/economy/funding-resolutions/**", (route) =>
    route.fulfill({
      json: {
        actor_id: 4301,
        results: [],
        zec_funding_capacity: {
          as_of: "2026-10-11T18:55:00Z",
          remaining_m2z: "200000000",
          remaining_sale_nusd: "10000000000",
        },
      },
    }),
  );
  await page.goto(billing);
  await page.getByLabel("Estimated credits (2Z)").fill("1000");
  await expect(page.getByTestId("zcash-funding-capacity")).toContainText(
    "Current-rate purchase value: $11.111112 USD",
  );
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
});

test("policy zero preserves ordinary memo purchases without finite policy-one limits", async ({
  page,
}) => {
  await page.route("**/api/economy/capabilities/", (route) =>
    route.fulfill({ json: { policy_version: 0, active: false } }),
  );
  await page.route("**/api/economy/funding-resolutions/**", (route) => {
    return route.fulfill({
      json: { actor_id: 4301, results: [], zec_funding_capacity: null },
    });
  });
  await page.goto(billing);
  await page.getByLabel("Estimated credits (2Z)").fill("200000");
  const wallet = page.getByRole("link", { name: "Open in Wallet" });
  await expect(wallet).toHaveAttribute("href", /^zcash:/);
  expect(decodedMemo((await wallet.getAttribute("href"))!)).toBe(
    '{"act":"buy_2z","id":"fixtureowner"}',
  );
  await expect(page.getByTestId("zcash-funding-capacity")).toHaveCount(0);
});

test("capacity shrinking during fresh clipboard authorization blocks the old instruction", async ({
  page,
}) => {
  let remaining = "200000000";
  let expectedOwner = false;
  await page.route("**/api/economy/funding-resolutions/**", (route) => {
    expectedOwner ||=
      new URL(route.request().url()).searchParams.get("expected_actor_id") ===
      "4301";
    return route.fulfill({
      json: {
        actor_id: 4301,
        results: [],
        zec_funding_capacity: {
          as_of: "2026-10-11T18:55:00Z",
          remaining_m2z: remaining,
          remaining_sale_nusd: "10000000000000",
        },
      },
    });
  });
  await page.goto(billing);
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeEnabled();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          (window as any).capacityCopies =
            ((window as any).capacityCopies || 0) + 1;
        },
      },
    }),
  );
  remaining = "1000";
  await page.getByRole("button", { name: "Copy URI" }).click();
  await expect(page.getByTestId("zcash-funding-capacity")).toContainText(
    "This payment exceeds",
  );
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).capacityCopies || 0)).toBe(
    0,
  );
  expect(expectedOwner).toBe(true);
});

test("wrong-owner or missing policy-one capacity cannot create a payment instruction", async ({
  page,
}) => {
  let actor = 4302;
  await page.route("**/api/economy/funding-resolutions/**", (route) =>
    route.fulfill({
      json: {
        actor_id: actor,
        results: [],
        zec_funding_capacity: null,
      },
    }),
  );
  await page.goto(billing);
  const retry = page.getByRole("button", {
    name: "Retry payment instructions",
  });
  await expect(retry).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
  actor = 4301;
  await retry.click();
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
});

test("a server-selected promo rate changes USD capacity without changing credit capacity", async ({
  page,
}) => {
  await page.route("**/api/economy/funding-resolutions/**", (route) =>
    route.fulfill({
      json: {
        actor_id: 4301,
        results: [],
        zec_funding_capacity: {
          as_of: "2026-10-11T18:55:00Z",
          remaining_m2z: "1200000",
          remaining_sale_nusd: "10000000000",
        },
      },
    }),
  );
  await page.route("**/api/pricing/**", (route) => {
    const code =
      new URL(route.request().url()).searchParams.get("promo") || undefined;
    return route.fulfill({
      json: promoPrice(
        code ? { code, multiplier: "2", title: "Code offer" } : {},
      ),
    });
  });
  await page.goto(billing);
  await page.getByLabel("Estimated credits (2Z)").fill("1000");
  await expect(page.getByTestId("zcash-funding-capacity")).toContainText(
    "Current-rate purchase value: $11.111112 USD",
  );
  await page.getByLabel("Promo code (optional)").fill("ZODL");
  await page.getByTestId("zcash-promo-apply").click();
  const wallet = page.getByRole("link", { name: "Open in Wallet" });
  await expect(wallet).toHaveAttribute("href", /amount=0\.05555556/);
  await expect(page.getByTestId("zcash-funding-capacity")).toHaveCount(0);
  expect(decodedMemo((await wallet.getAttribute("href"))!)).toBe(
    '{"act":"buy_2z","id":"fixtureowner","promo":"ZODL"}',
  );
  await page.getByLabel("Estimated credits (2Z)").fill("1100");
  await expect(page.getByTestId("zcash-funding-capacity")).toContainText(
    "1,222.223 2Z",
  );
  await expect(wallet).toHaveCount(0);
});

test("zero policy-one capacity blocks a payment even when live pricing is unavailable", async ({
  page,
}) => {
  await page.route("**/api/pricing/**", (route) =>
    route.fulfill({ status: 503, json: { detail: "unavailable" } }),
  );
  await page.route("**/api/economy/funding-resolutions/**", (route) =>
    route.fulfill({
      json: {
        actor_id: 4301,
        results: [],
        zec_funding_capacity: {
          as_of: "2026-10-11T18:55:00Z",
          remaining_m2z: "0",
          remaining_sale_nusd: "10000000000000",
        },
      },
    }),
  );
  await page.goto(billing);
  await expect(page.getByTestId("zcash-funding-capacity")).toContainText(
    "Zcash purchases are unavailable for this account",
  );
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
});

test("an older capacity response cannot reopen instructions after a newer zero-capacity handoff", async ({
  page,
}) => {
  let remaining = "200000000";
  let holdNext = false;
  let releaseOld: (() => void) | undefined;
  await page.route("**/api/economy/funding-resolutions/**", async (route) => {
    const capturedRemaining = remaining;
    if (
      holdNext &&
      new URL(route.request().url()).searchParams.has("expected_actor_id")
    ) {
      holdNext = false;
      await new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
    }
    return route.fulfill({
      json: {
        actor_id: 4301,
        results: [],
        zec_funding_capacity: {
          as_of: "2026-10-11T18:55:00Z",
          remaining_m2z: capturedRemaining,
          remaining_sale_nusd: "10000000000000",
        },
      },
    });
  });
  await page.goto(billing);
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeEnabled();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          (window as any).capacityCopies =
            ((window as any).capacityCopies || 0) + 1;
        },
      },
    }),
  );
  holdNext = true;
  await page.clock.runFor(15001);
  await expect.poll(() => !!releaseOld).toBe(true);
  remaining = "0";
  await page.getByRole("button", { name: "Copy URI" }).click();
  await expect(page.getByTestId("zcash-funding-capacity")).toContainText(
    "Zcash purchases are unavailable for this account",
  );
  releaseOld!();
  await page.waitForResponse(
    (response) =>
      response.url().includes("/api/economy/funding-resolutions/") &&
      response.ok(),
  );
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).capacityCopies || 0)).toBe(
    0,
  );
});

for (const snapshot of [
  { updated_at: "2026-10-11T18:51:00Z", stale: false },
  { updated_at: "2026-10-11T19:00:00Z", stale: false },
  { updated_at: "invalid", stale: false },
  { updated_at: "2026-10-11T18:55:00Z", stale: true },
]) {
  test(`policy-one payment instructions reject an unusable cached price ${JSON.stringify(snapshot)}`, async ({
    page,
  }) => {
    await page.route("**/api/pricing/**", (route) =>
      route.fulfill({ json: { ...promoPrice(), ...snapshot } }),
    );
    await page.goto(billing);
    await expect(
      page.getByText(
        "Waiting for current pricing to check your funding limits.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open in Wallet" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("zcash-estimate-disclosure")).toContainText(
      "conservative estimate",
    );
  });
}

test("an open-tab price ages out of policy-one payment instructions", async ({
  page,
}) => {
  await page.goto(billing);
  await expect(
    page.getByRole("link", { name: "Open in Wallet" }),
  ).toBeVisible();
  await page.clock.runFor(120001);
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
  await expect(
    page.getByText(
      "Waiting for current pricing to check your funding limits.",
      { exact: false },
    ),
  ).toBeVisible();
});

test("a sixteen-second capability and capacity refresh converges despite fifteen-second polling", async ({
  page,
}) => {
  const capabilityReplies: Array<() => void> = [];
  const capacityReplies: Array<() => void> = [];
  let capabilityReads = 0;
  await page.route("**/api/economy/capabilities/", async (route) => {
    capabilityReads++;
    await new Promise<void>((resolve) => capabilityReplies.push(resolve));
    return route.fulfill({ json: capabilities });
  });
  await page.route("**/api/economy/funding-resolutions/**", async (route) => {
    await new Promise<void>((resolve) => capacityReplies.push(resolve));
    return route.fulfill({
      json: {
        actor_id: 4301,
        results: [],
        zec_funding_capacity: {
          as_of: "2026-10-11T18:55:00Z",
          remaining_m2z: "200000000",
          remaining_sale_nusd: "10000000000000",
        },
      },
    });
  });
  await page.goto(billing);
  await expect.poll(() => capabilityReplies.length).toBeGreaterThan(0);
  await page.clock.runFor(8000);
  for (const reply of capabilityReplies.splice(0)) reply();
  await expect.poll(() => capacityReplies.length).toBeGreaterThan(0);
  const initialReads = capabilityReads;
  await page.clock.runFor(8000);
  expect(capabilityReads).toBe(initialReads);
  for (const reply of capacityReplies.splice(0)) reply();
  await expect(
    page.getByRole("link", { name: "Open in Wallet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
});

for (const skewSeconds of [-180, 180]) {
  test(`policy-one payment pricing and offers use server time with device skew ${skewSeconds}s`, async ({
    page,
  }) => {
    await page.clock.setSystemTime(
      new Date(Date.parse("2026-10-11T18:55:01Z") + skewSeconds * 1000),
    );
    await page.route("**/api/pricing/**", (route) =>
      route.fulfill({
        json: promoPrice({
          multiplier: "2",
          title: "Server-timed offer",
          endsAt: "2026-10-11T18:57:00Z",
        }),
      }),
    );
    await page.goto(billing);
    const wallet = page.getByRole("link", { name: "Open in Wallet" });
    await expect(wallet).toHaveAttribute("href", /amount=0\.13888889/);
    await expect(page.getByTestId("zcash-price-estimate")).toContainText(
      "Current market price",
    );
    await expect(page.getByTestId("zcash-promotion")).toContainText(
      "Server-timed offer · 2×",
    );
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (uri: string) => {
            (window as any).skewPurchaseUri = uri;
          },
        },
      }),
    );
    await page.getByRole("button", { name: "Copy URI" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).skewPurchaseUri))
      .toMatch(/^zcash:/);
    // Changing wall time does not change elapsed age on the accepted server clock.
    await page.clock.setSystemTime(new Date("2026-10-11T18:40:00Z"));
    await page.clock.runFor(1001);
    await expect(wallet).toHaveAttribute("href", /amount=0\.13888889/);
    // Repeated capacity responses carry the same timestamp; they must not keep
    // the original price or offer alive while monotonic time advances.
    await page.clock.runFor(120001);
    await expect(wallet).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
  });
}

test("a same-owner transient capacity failure cannot restart an aged server clock", async ({
  page,
}) => {
  let available = true;
  await page.route("**/api/economy/funding-resolutions/**", (route) =>
    available
      ? route.fulfill({
          json: {
            actor_id: 4301,
            results: [],
            zec_funding_capacity: {
              as_of: "2026-10-11T18:55:00Z",
              remaining_m2z: "200000000",
              remaining_sale_nusd: "10000000000000",
            },
          },
        })
      : route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  await page.goto(billing);
  await expect(
    page.getByRole("link", { name: "Open in Wallet" }),
  ).toBeVisible();
  available = false;
  await page.clock.runFor(120001);
  const retry = page.getByRole("button", {
    name: "Retry payment instructions",
  });
  await expect(retry).toBeVisible();
  available = true;
  await retry.click();
  await expect(page.getByTestId("zcash-funding-capacity")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open in Wallet" })).toHaveCount(
    0,
  );
  await expect(
    page.getByText(
      "Waiting for current pricing to check your funding limits.",
      { exact: false },
    ),
  ).toBeVisible();
});

for (const resume of [
  { trigger: "elapsed discrepancy", accepted: true },
  { trigger: "focus", accepted: false },
]) {
  test(`paused monotonic time hides expired payment instructions until ${resume.trigger} revalidation ${resume.accepted ? "succeeds" : "fails"}`, async ({
    page,
  }) => {
    let resumed = false;
    let releaseAuth: (() => void) | undefined;
    await page.route("**/api/pricing/**", (route) =>
      route.fulfill({
        json: {
          ...promoPrice(
            resumed
              ? {}
              : {
                  multiplier: "2",
                  title: "Before-sleep offer",
                  endsAt: "2026-10-11T18:57:00Z",
                },
          ),
          updated_at: resumed ? "2026-10-11T19:55:00Z" : "2026-10-11T18:55:00Z",
        },
      }),
    );
    await page.route("**/api/economy/funding-resolutions/**", (route) =>
      route.fulfill({
        json: {
          actor_id: 4301,
          results: [],
          zec_funding_capacity: {
            as_of: resumed ? "2026-10-11T19:55:00Z" : "2026-10-11T18:55:00Z",
            remaining_m2z: "200000000",
            remaining_sale_nusd: "10000000000000",
          },
        },
      }),
    );
    await page.goto(billing);
    const wallet = page.getByRole("link", { name: "Open in Wallet" });
    await expect(wallet).toHaveAttribute("href", /amount=0\.13888889/);
    await page.route("**/api/auth/user/", async (route) => {
      await new Promise<void>((resolve) => {
        releaseAuth = resolve;
      });
      return resume.accepted
        ? route.continue()
        : route.fulfill({ status: 503, json: { detail: "Unavailable" } });
    });
    await page.evaluate(() => {
      const frozen = performance.now();
      const original = performance.now.bind(performance);
      Object.defineProperty(performance, "now", {
        configurable: true,
        value: () => frozen,
      });
      (window as any).restoreMonotonicTime = () =>
        Object.defineProperty(performance, "now", {
          configurable: true,
          value: original,
        });
    });
    await page.clock.setSystemTime(new Date("2026-10-11T19:55:01Z"));
    if (resume.trigger === "focus")
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    else await page.clock.runFor(1001);
    await expect.poll(() => !!releaseAuth).toBe(true);
    await expect(wallet).toHaveCount(0);
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
    resumed = true;
    releaseAuth!();
    if (resume.accepted) {
      await expect(wallet).toHaveAttribute("href", /amount=0\.27777778/);
      await expect(page.getByTestId("zcash-promotion")).toHaveCount(0);
      expect(decodedMemo((await wallet.getAttribute("href"))!)).toBe(
        '{"act":"buy_2z","id":"fixtureowner"}',
      );
    } else {
      await expect(
        page.getByRole("button", { name: "Retry payment instructions" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Retry payment instructions" }),
      ).toBeEnabled();
      await expect(wallet).toHaveCount(0);
      await expect(
        page.getByRole("img", { name: "Zcash payment QR code" }),
      ).toHaveCount(0);
    }
    await page.evaluate(() => (window as any).restoreMonotonicTime());
  });
}

test("obsolete handoff authentication cannot clear a successful resume verification", async ({
  page,
}) => {
  await page.goto(billing);
  const wallet = page.getByRole("link", { name: "Open in Wallet" });
  const qr = page.getByRole("img", { name: "Zcash payment QR code" });
  await expect(qr).toBeVisible();
  const uri = await wallet.getAttribute("href");
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as any).obsoleteHandoffCopy = value;
        },
      },
    }),
  );
  let releaseOld: (() => void) | undefined;
  let releaseResume: (() => void) | undefined;
  let oldRequest: unknown;
  let authenticationReads = 0;
  await page.route("**/api/auth/user/", async (route) => {
    authenticationReads++;
    if (authenticationReads === 1) {
      oldRequest = route.request();
      await new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
    } else if (authenticationReads === 2) {
      await new Promise<void>((resolve) => {
        releaseResume = resolve;
      });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Copy URI" }).click();
  await expect.poll(() => !!releaseOld).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => !!releaseResume).toBe(true);
  await expect(qr).toHaveCount(0);
  releaseResume!();
  await expect(qr).toBeVisible();
  // Resume B has restored the instruction before obsolete A completes.
  const obsoleteResponse = page.waitForResponse(
    (response) => response.request() === oldRequest,
  );
  releaseOld!();
  await obsoleteResponse;
  await expect(
    page.getByText("Failed to copy the Zcash payment URI."),
  ).toBeVisible();
  await expect(qr).toBeVisible();
  await expect(wallet).toHaveAttribute("href", uri!);
  await expect(page.getByRole("button", { name: "Copy URI" })).toBeEnabled();
  expect(
    await page.evaluate(() => (window as any).obsoleteHandoffCopy),
  ).toBeUndefined();
  // A new handoff still verifies against the server and copies the exact memo.
  await page.getByRole("button", { name: "Copy URI" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).obsoleteHandoffCopy))
    .toBe(uri);
  expect(decodedMemo(uri!)).toBe('{"act":"buy_2z","id":"fixtureowner"}');
});

for (const held of ["capacity", "authentication"]) {
  test(`a held pre-sleep ${held} response cannot clear wake uncertainty before a fresh private read`, async ({
    page,
  }) => {
    let sleeping = false;
    let holdOld = false;
    let releaseOld: (() => void) | undefined;
    const freshReplies: Array<() => void> = [];
    await page.route("**/api/pricing/**", (route) =>
      route.fulfill({
        json: {
          ...promoPrice(
            sleeping
              ? {}
              : {
                  multiplier: "2",
                  title: "Before-sleep offer",
                  endsAt: "2026-10-11T18:57:00Z",
                },
          ),
          updated_at: sleeping
            ? "2026-10-11T19:55:15Z"
            : "2026-10-11T18:55:00Z",
        },
      }),
    );
    await page.route("**/api/auth/user/", async (route) => {
      if (held === "authentication" && holdOld && !sleeping)
        await new Promise<void>((resolve) => {
          releaseOld = resolve;
        });
      return route.continue();
    });
    await page.route("**/api/economy/funding-resolutions/**", async (route) => {
      const asOf = sleeping ? "2026-10-11T19:55:15Z" : "2026-10-11T18:55:00Z";
      if (held === "capacity" && holdOld && !sleeping)
        await new Promise<void>((resolve) => {
          releaseOld = resolve;
        });
      else if (sleeping)
        await new Promise<void>((resolve) => freshReplies.push(resolve));
      return route.fulfill({
        json: {
          actor_id: 4301,
          results: [],
          zec_funding_capacity: {
            as_of: asOf,
            remaining_m2z: "200000000",
            remaining_sale_nusd: "10000000000000",
          },
        },
      });
    });
    await page.goto(billing);
    const wallet = page.getByRole("link", { name: "Open in Wallet" });
    await expect(wallet).toHaveAttribute("href", /amount=0\.13888889/);
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            (window as any).wakeCopies = ((window as any).wakeCopies || 0) + 1;
          },
        },
      }),
    );
    holdOld = true;
    if (held === "capacity") await page.clock.runFor(15001);
    else await page.getByRole("button", { name: "Copy URI" }).click();
    await expect.poll(() => !!releaseOld).toBe(true);
    await page.evaluate(() => {
      const frozen = performance.now();
      const original = performance.now.bind(performance);
      Object.defineProperty(performance, "now", {
        configurable: true,
        value: () => frozen,
      });
      (window as any).restoreWakeClock = () =>
        Object.defineProperty(performance, "now", {
          configurable: true,
          value: original,
        });
    });
    sleeping = true;
    await page.clock.setSystemTime(new Date("2026-10-11T19:55:16Z"));
    // No focus event or timer tick: the response itself must notice suspension.
    releaseOld!();
    await expect.poll(() => freshReplies.length).toBeGreaterThan(0);
    await expect(wallet).toHaveCount(0);
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy URI" })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).wakeCopies || 0)).toBe(0);
    for (const reply of freshReplies.splice(0)) reply();
    await expect(wallet).toHaveAttribute("href", /amount=0\.27777778/);
    await page.evaluate(() => (window as any).restoreWakeClock());
  });
}
