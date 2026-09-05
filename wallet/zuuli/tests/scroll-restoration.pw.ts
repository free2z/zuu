import { expect, test, type Locator, type Page } from "@playwright/test";

async function setSession(page: Page, signedIn: boolean) {
  await page.addInitScript((authenticated) => {
    const key = "zuuli.knox.token";
    if (authenticated) localStorage.setItem(key, "mock-knox-token");
    else localStorage.removeItem(key);
  }, signedIn);
}

function genericViewport(page: Page) {
  return page.locator("[data-scroll-area-viewport]");
}

async function setOffset(scroller: Locator, requested: number) {
  const offset = await scroller.evaluate(
    (element, target) =>
      new Promise<number>((resolve) => {
        element.scrollTop = Math.min(
          target,
          Math.max(0, element.scrollHeight - element.clientHeight),
        );
        requestAnimationFrame(() => resolve(element.scrollTop));
      }),
    requested,
  );
  expect(offset).toBeGreaterThan(100);
  return offset;
}

async function expectOffset(scroller: Locator, expected: number) {
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeCloseTo(expected, 0);
}

test("PUSH resets before paint and POP restores distinct history entries", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await setSession(page, false);
  await page.goto("/");
  await page.waitForTimeout(900);

  const scroller = genericViewport(page);
  const homeOffset = await setOffset(scroller, 720);
  await page.evaluate(() => {
    const originalPushState = history.pushState.bind(history);
    const offsets: number[] = [];
    history.pushState = function (...args) {
      originalPushState(...args);
      requestAnimationFrame(() => {
        offsets.push(
          document.querySelector<HTMLElement>("[data-scroll-area-viewport]")
            ?.scrollTop ?? -1,
        );
      });
    };
    (
      window as Window & { __zuuliFirstPaintOffsets?: number[] }
    ).__zuuliFirstPaintOffsets = offsets;
  });

  await page
    .getByRole("navigation", { name: "App navigation" })
    .getByRole("link", { name: "Zcash wallet" })
    .click();
  await expect(page).toHaveURL(/\/wallet$/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __zuuliFirstPaintOffsets?: number[] })
            .__zuuliFirstPaintOffsets?.[0],
      ),
    )
    .toBe(0);
  await expectOffset(scroller, 0);

  // Wallet Overview resolves its balance and recent activity asynchronously;
  // scrolling before that lands would measure the skeleton, not the route.
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible();
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight))
    .toBeGreaterThan(900);
  await setOffset(scroller, 980);
  // Asynchronously populated rows can trigger browser scroll anchoring after
  // the ledger arrives. Snapshot the entry's settled, actual offset
  // immediately before leaving; that is the value POP must restore.
  await page.waitForTimeout(150);
  const walletOffset = await scroller.evaluate(
    (element) => element.scrollTop,
  );
  expect(walletOffset).toBeGreaterThan(100);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expectOffset(scroller, homeOffset);

  await page.goForward();
  await expect(page).toHaveURL(/\/wallet$/);
  await expectOffset(scroller, walletOffset);

  await page
    .locator("[data-app-top-bar]")
    .getByRole("button", { name: "Go back" })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expectOffset(scroller, homeOffset);

  await page.goForward();
  await expect(page).toHaveURL(/\/wallet$/);
  await expectOffset(scroller, walletOffset);

  // Stay pending beyond the former short deadline, then change only a content
  // box size (no child-list mutation). ResizeObserver must reassert the saved
  // entry before paint.
  await page.waitForTimeout(3_100);
  const resizeContent = async (kind: "padding" | "content") =>
    scroller.evaluate(
      (element, { target, resizeKind }) => {
        element.scrollTop = target + 120;
        const content = element.firstElementChild;
        if (!(content instanceof HTMLElement))
          throw new Error("missing scroll content");
        if (resizeKind === "padding") {
          content.style.paddingBottom = "1px";
        } else {
          content.style.minHeight = `${content.getBoundingClientRect().height + 1}px`;
        }
      },
      { target: walletOffset, resizeKind: kind },
    );
  await resizeContent("padding");
  await expectOffset(scroller, walletOffset);
  await resizeContent("content");
  await expectOffset(scroller, walletOffset);

  // The bounded async-content retry must yield to real input outside the
  // viewport, not only events dispatched inside it. Use a real pointer action
  // over pinned chrome, then move to the user's new offset. A later DOM
  // mutation must not snap that position back to the restored target.
  const topBarBox = await page.locator("[data-app-top-bar]").boundingBox();
  expect(topBarBox).not.toBeNull();
  const topBarPoint = {
    x: topBarBox!.x + topBarBox!.width / 2,
    y: topBarBox!.y + topBarBox!.height / 2,
  };
  let currentWalletOffset = walletOffset;
  const assertInputWins = async (
    interact: () => Promise<void>,
    markerName: string,
  ) => {
    await interact();
    currentWalletOffset = await setOffset(
      scroller,
      currentWalletOffset + 60,
    );
    await scroller.evaluate((element, marker) => {
      const node = document.createElement("span");
      node.hidden = true;
      node.dataset.postRestoreMutation = marker;
      element.append(node);
    }, markerName);
    await page.waitForTimeout(100);
    await expectOffset(scroller, currentWalletOffset);
  };
  const rearmPendingRestore = async () => {
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expectOffset(scroller, homeOffset);
    await page.goForward();
    await expect(page).toHaveURL(/\/wallet$/);
    await expectOffset(scroller, currentWalletOffset);
  };

  await assertInputWins(async () => {
    await page.mouse.move(topBarPoint.x, topBarPoint.y);
    await page.mouse.down();
    await page.mouse.up();
  }, "pointer");

  await rearmPendingRestore();
  await assertInputWins(async () => {
    await page.mouse.move(topBarPoint.x, topBarPoint.y);
    await page.mouse.wheel(0, 100);
  }, "wheel");

  await rearmPendingRestore();
  await assertInputWins(async () => {
    await page.keyboard.press("PageDown");
  }, "keyboard");
});

test("generic and full-bleed owners hand off without leaking offsets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await setSession(page, false);
  await page.goto("/");
  await page.waitForTimeout(900);

  const generic = genericViewport(page);
  const homeOffset = await setOffset(generic, 680);
  // #904 phase 4 removed `/ai`; login is now the only full-bleed scroll owner.
  await page
    .getByRole("navigation", { name: "App navigation" })
    .getByRole("link", { name: "Log in" })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(generic).toHaveCount(0);
  const fullBleed = page.locator("main[data-route-frame] [data-route-scroll]");
  await expect(fullBleed).toBeVisible();
  await expectOffset(fullBleed, 0);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(genericViewport(page)).toBeVisible();
  await expectOffset(genericViewport(page), homeOffset);

  await page.goForward();
  await expect(page).toHaveURL(/\/login$/);
  await expectOffset(fullBleed, 0);
  await page.goto("/wallet/history");
  await expect(genericViewport(page)).toBeVisible();
  await expectOffset(genericViewport(page), 0);
});

test("active desktop tabs return to top by pointer and keyboard without navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await setSession(page, false);
  await page.goto("/");
  await page.waitForTimeout(900);

  const scroller = genericViewport(page);
  const home = page
    .getByRole("navigation", { name: "App navigation" })
    .getByRole("link", { name: "Home", exact: true });
  const historyLength = await page.evaluate(() => history.length);

  await setOffset(scroller, 620);
  await home.click();
  await expectOffset(scroller, 0);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  await setOffset(scroller, 540);
  await home.focus();
  await page.keyboard.press("Enter");
  await expectOffset(scroller, 0);
  await expect(home).toBeFocused();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test("a prefix-active tab still navigates from a child route to its destination", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await setSession(page, false);

  await page.goto("/wallet/send");

  const wallet = page
    .getByRole("navigation", { name: "App navigation" })
    .getByRole("link", { name: "Zcash wallet" });
  await expect(wallet).toHaveAttribute("aria-current", "page");
  await wallet.click();
  await expect(page).toHaveURL(/\/wallet$/);
  await expectOffset(genericViewport(page), 0);
});

test.describe("touch scroll restoration", () => {
  test.use({ hasTouch: true });

  test("the active mobile tab tops on first touch at 320x568 without overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await setSession(page, false);
    await page.goto("/");
    await page.waitForTimeout(900);

    const scroller = genericViewport(page);
    await setOffset(scroller, 520);
    const home = page
      .getByRole("navigation", { name: "Primary navigation" })
      .locator('[data-navigation-id="home"]');
    await home.tap();
    await expectOffset(scroller, 0);

    const geometry = await page
      .locator("[data-app-frame]")
      .evaluate((frame) => ({
        clientWidth: frame.clientWidth,
        scrollWidth: frame.scrollWidth,
        viewportClientWidth: document.documentElement.clientWidth,
        viewportScrollWidth: document.documentElement.scrollWidth,
      }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expect(geometry.viewportScrollWidth).toBeLessThanOrEqual(
      geometry.viewportClientWidth,
    );
  });
});

test("fresh deep links and hashes deliberately start the custom owner at top", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await setSession(page, true);
  await page.goto("/wallet/history#does-not-exist");
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expectOffset(genericViewport(page), 0);
  await page.waitForTimeout(500);
  await expectOffset(genericViewport(page), 0);
});
