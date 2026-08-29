import { expect, test, type Page } from "@playwright/test";

const RECIPIENT =
  "u1l8xunezsvpntq2snz67h6md2eq09u09vv3xh6z8kqvxg7pdvz4qc9x2u84kqmpc0mz0kmvexz";

async function openSend(page: Page, delayMs = 0) {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(({ delay }) => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
    localStorage.setItem("zuuli.mock.send-proposal-delay-ms", String(delay));
  }, { delay: delayMs });
  await page.goto("/wallet/send");
}

async function fillPayment(page: Page, memo = "immutable private memo") {
  await page.getByLabel("Recipient address").fill(RECIPIENT);
  await expect(page.getByText(/Valid unified address/)).toBeVisible();
  await page.getByLabel("Amount").fill("0.0001");
  await page.getByLabel(/^Memo/).fill(memo);
  await expect(page.getByRole("button", { name: "Review payment" })).toBeEnabled();
}

test("a proposal resolving after unmount is discarded and cannot reopen review", async ({ page }) => {
  await openSend(page, 600);
  await fillPayment(page);
  await page.getByRole("button", { name: "Review payment" }).click();

  await expect(page.getByLabel("Recipient address")).toBeDisabled();
  await expect(page.getByLabel("Amount")).toBeDisabled();
  await expect(page.getByLabel(/^Memo/)).toBeDisabled();

  await page.getByRole("link", { name: "Zcash wallet", exact: true }).click();
  await expect(page).toHaveURL(/\/wallet$/);
  await page.waitForTimeout(750);
  await expect(page.getByRole("dialog", { name: "Confirm payment" })).toHaveCount(0);

  const persistedSecrets = await page.evaluate(() =>
    [...Object.entries(localStorage), ...Object.entries(sessionStorage)].filter(
      ([key, value]) => /send|proposal|digest|confirmation/i.test(`${key}:${value}`),
    ).filter(([key]) => key !== "zuuli.mock.send-proposal-delay-ms"),
  );
  expect(persistedSecrets).toEqual([]);
});

test("an input race invalidates a proposal even when UI disabling is bypassed", async ({ page }) => {
  await openSend(page, 600);
  await fillPayment(page);
  await page.getByRole("button", { name: "Review payment" }).click();
  const amount = page.getByLabel("Amount");
  await expect(amount).toBeDisabled();

  // Simulate a stale renderer/event race below the visual disabled control.
  // The generation lease, not HTML disabling, is the integrity boundary.
  await amount.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }, "0.0002");

  await expect(amount).toHaveValue("0.0002");
  await page.waitForTimeout(750);
  await expect(page.getByRole("dialog", { name: "Confirm payment" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review payment" })).toBeEnabled();
});

test("a multi-payment URI never selects its first payment or preserves stale intent", async ({
  page,
}) => {
  await openSend(page);
  await fillPayment(page, "stale memo");

  await page
    .getByLabel("Recipient address")
    .fill("zcash:?address=u1first&amount=1&address.1=u1second&amount.1=2");

  await expect(page.getByText("Couldn't read that payment link")).toBeVisible();
  await expect(page.getByLabel("Recipient address")).toHaveValue("");
  await expect(page.getByLabel("Amount")).toHaveValue("");
  await expect(page.getByLabel(/^Memo/)).toHaveValue("");
  await expect(page.getByRole("button", { name: "Review payment" })).toBeDisabled();
});

test("a snackbar clears native insets, mobile navigation, and viewport resizes", async ({
  page,
}) => {
  await openSend(page);
  await page.addStyleTag({
    content: `:root {
      --safe-area-top: 23px !important;
      --safe-area-right: 9px !important;
      --safe-area-bottom: 31px !important;
      --safe-area-left: 13px !important;
    }
    /* Freeze Sonner's mount-in transform transition so the geometry
       assertions below measure the toast's settled position instead of an
       arbitrary animation frame. */
    [data-sonner-toast] {
      transition: none !important;
    }`,
  });

  await page
    .getByLabel("Recipient address")
    .fill("zcash:?address=u1first&amount=1&address.1=u1second&amount.1=2");
  const toast = page.locator("[data-sonner-toast]").filter({
    hasText: "Couldn't read that payment link",
  });
  const toaster = page.locator("[data-sonner-toaster]");
  const bottomNav = page.locator("[data-app-bottom-nav]");
  await expect(toast).toBeVisible();

  async function geometry() {
    const [toastRect, navRect, toasterStyle, viewport] = await Promise.all([
      toast.boundingBox(),
      bottomNav.boundingBox(),
      toaster.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          bottom: Number.parseFloat(style.bottom),
          left: Number.parseFloat(style.left),
          right: Number.parseFloat(style.right),
        };
      }),
      page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        height:
          window.visualViewport?.height ?? document.documentElement.clientHeight,
      })),
    ]);
    if (!toastRect || !navRect) {
      throw new Error("toast geometry fixtures are not mounted");
    }
    return {
      toast: {
        top: toastRect.y,
        right: toastRect.x + toastRect.width,
        bottom: toastRect.y + toastRect.height,
        left: toastRect.x,
      },
      navTop: navRect.y,
      viewportWidth: viewport.width,
      visualViewportHeight: viewport.height,
      toasterBottom: toasterStyle.bottom,
      toasterLeft: toasterStyle.left,
      toasterRight: toasterStyle.right,
    };
  }

  async function expectInsetGeometry() {
    // The toaster host itself is intentionally zero-height: every
    // `[data-sonner-toast]` child is absolutely positioned within it (see
    // sonner's own stylesheet), so an in-flow visibility/bounding-box check
    // on the host never succeeds. Assert it is mounted and read its computed
    // offsets instead; the toast's own visibility and position below are the
    // real inset assertions.
    await expect(toaster).toBeAttached();
    await expect(bottomNav).toBeVisible();
    const measured = await geometry();
    expect(measured.toasterBottom).toBe(103);
    expect(measured.toasterLeft).toBe(29);
    expect(measured.toasterRight).toBe(29);
    expect(measured.toast.left).toBeGreaterThanOrEqual(29);
    expect(measured.toast.right).toBeLessThanOrEqual(measured.viewportWidth - 29);
    expect(measured.toast.bottom).toBeLessThanOrEqual(measured.navTop - 16);
    expect(measured.toast.top).toBeGreaterThanOrEqual(23);
    expect(measured.toast.bottom).toBeLessThanOrEqual(
      measured.visualViewportHeight,
    );
  }

  await expectInsetGeometry();
  await page.setViewportSize({ width: 320, height: 420 });
  await expectInsetGeometry();
});

test("the 320px dialog renders only the immutable native review and locks editing", async ({
  page,
}) => {
  await openSend(page);
  await fillPayment(page);
  await page.getByRole("button", { name: "Review payment" }).click();

  const dialog = page.getByRole("dialog", { name: "Confirm payment" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Recipient address")).toBeDisabled();
  await expect(page.getByLabel("Amount")).toBeDisabled();
  await expect(page.getByLabel(/^Memo/)).toBeDisabled();
  await expect(page.getByTestId("send-review-recipient")).toHaveText(RECIPIENT);
  await expect(page.getByTestId("send-review-amount")).toHaveText("0.0001 ZEC");
  await expect(page.getByTestId("send-review-memo")).toHaveText("immutable private memo");
  await expect(dialog.getByText("mainnet", { exact: true })).toBeVisible();
  await expect(page.getByTestId("send-review-change-policy")).toHaveAttribute(
    "title",
    "zip317-shielded-auto",
  );

  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: document.documentElement.scrollWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(320);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(568);
  expect(geometry.width).toBeLessThanOrEqual(320);

  await page.getByRole("button", { name: "Confirm & send" }).click();
  await expect(page).toHaveURL(/\/wallet\/history$/);
  await expect(page.getByText("Transaction sent")).toBeVisible();

  const leaked = await page.evaluate(() =>
    [...Object.entries(localStorage), ...Object.entries(sessionStorage)].filter(
      ([key, value]) => /reviewDigest|confirmationToken|immutable private memo/i.test(`${key}:${value}`),
    ),
  );
  expect(leaked).toEqual([]);
});

test("renderer approval cannot send when native confirmation is cancelled", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.mock.send-confirmation-result", "cancel");
  });
  await openSend(page);
  await fillPayment(page);
  await page.getByRole("button", { name: "Review payment" }).click();
  await page.getByRole("button", { name: "Confirm & send" }).click();

  await expect(page).toHaveURL(/\/wallet\/send$/);
  await expect(page.getByText("Native payment confirmation was cancelled")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Confirm payment" })).toHaveCount(0);
  await expect(page.getByLabel("Amount")).toBeEnabled();
});

test("long canonical review fields remain fully inspectable on a short phone", async ({ page }) => {
  const longMemo = "private review words ".repeat(18).trim();
  await openSend(page);
  await fillPayment(page, longMemo);
  await page.getByRole("button", { name: "Review payment" }).click();

  const dialog = page.getByRole("dialog", { name: "Confirm payment" });
  await expect(page.getByTestId("send-review-recipient")).toHaveText(RECIPIENT);
  await expect(page.getByTestId("send-review-memo")).toHaveText(longMemo);
  await expect(page.getByRole("button", { name: "Confirm & send" })).toBeVisible();

  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(320);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(568);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  await page.getByRole("button", { name: "Confirm & send" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Confirm & send" })).toBeInViewport();
});

test("cancel discards the exact proposal and requires a fresh review", async ({ page }) => {
  await openSend(page);
  await fillPayment(page, "first review");
  await page.getByRole("button", { name: "Review payment" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm payment" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm payment" })).toHaveCount(0);
  await expect(page.getByLabel("Amount")).toBeEnabled();

  await page.getByLabel("Amount").fill("0.0002");
  await page.getByRole("button", { name: "Review payment" }).click();
  await expect(page.getByTestId("send-review-amount")).toHaveText("0.0002 ZEC");
});
